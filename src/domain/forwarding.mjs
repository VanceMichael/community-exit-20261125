import { HttpError, mailEvent, requireFields } from '../http-util.mjs';
import { nextId } from '../store.mjs';

// 承运台客户端：转寄使用外部承运协议，网络未明不等于未受理。
export function createCarrierClient({ baseUrl, config, fetchImpl = fetch, timeoutMs = 4000 }) {
  async function submit(forwardingNo, reference, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${config.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [config.key]: key },
        body: JSON.stringify({ [config.group]: [{ [config.id]: forwardingNo, reference }] }),
        signal: controller.signal,
      });
    } catch (error) {
      // 超时/断线：可能已被受理，必须保留原件责任，交由查单核实。
      return { outcome: 'unclear', httpStatus: null, error: String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 202 || response.status === 200) {
      const payload = await response.json();
      const result = payload.results?.[0] ?? {};
      return { outcome: 'submitted', httpStatus: response.status, carrierStatus: result.status ?? 'accepted', result };
    }
    if (response.status === 409) return { outcome: 'conflict', httpStatus: 409, payload: await safeJson(response) };
    return { outcome: 'rejected', httpStatus: response.status, payload: await safeJson(response) };
  }

  async function lookup(forwardingNo) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${config.lookup}${encodeURIComponent(forwardingNo)}`, {
        signal: controller.signal,
      });
      if (response.status === 404) return { outcome: 'missing', httpStatus: 404 };
      if (!response.ok) return { outcome: 'error', httpStatus: response.status };
      return { outcome: 'found', httpStatus: response.status, operation: await response.json() };
    } catch (error) {
      return { outcome: 'unclear', httpStatus: null, error: String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { submit, lookup };
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

function findForwarding(state, id) {
  const f = state.forwardings.find(x => x.id === id);
  if (!f) throw new HttpError(404, 'not_found', '转寄记录不存在');
  return f;
}

// 新建转寄：受理未明前保留原件责任，且与现场领取互斥。
export async function createForwarding(state, deps, body, actor, now) {
  requireFields(body, ['mailId', 'destination']);
  const mail = state.mail.find(m => m.id === body.mailId);
  if (!mail) throw new HttpError(404, 'not_found', '来件不存在');
  if (mail.status !== 'pending') throw new HttpError(409, 'state_conflict', '只有待领取的来件可以申请转寄');
  if (mail.blocked) throw new HttpError(409, 'delivery_suspended', '该件存在未结争议，转寄同步暂停');
  if (mail.currentForwardingId) throw new HttpError(409, 'forwarding_active', '该件已有转寄安排');

  const forwarding = {
    id: nextId(state, 'FWD'),
    carrierNo: nextId(state, 'CARRIER'),
    mailId: mail.id,
    companyId: mail.companyId,
    destination: String(body.destination).slice(0, 200),
    status: 'requested',
    carrierStatus: null,
    carrierRevision: null,
    key: `fwd-${mail.id}-${Date.parse(now)}`,
    requestedBy: actor.id,
    requestedAt: now,
    submittedAt: null,
    unclearAt: null,
    completedAt: null,
    cancelledAt: null,
    intercepts: [],
    events: [{ at: now, type: 'created', note: '转寄申请已登记，原件责任保留' }],
  };
  state.forwardings.push(forwarding);
  mail.currentForwardingId = forwarding.id;
  mail.status = 'forwarding';
  mailEvent(state, mail, now, 'forwarding_requested', '转寄申请建立，现场领取同时关闭', { forwardingId: forwarding.id });

  const result = await deps.carrier.submit(forwarding.carrierNo, { mailId: mail.id, trackingNo: mail.trackingNo }, forwarding.key);
  forwarding.submittedAt = now;
  if (result.outcome === 'submitted') {
    forwarding.status = 'submitted';
    forwarding.carrierStatus = result.carrierStatus;
    forwarding.carrierRevision = result.result?.revision ?? null;
    forwarding.events.push({ at: now, type: 'carrier_submitted', note: `承运台状态：${result.carrierStatus}` });
    if (result.carrierStatus === 'rejected') {
      // 承运台拒绝：原件退回可领取库存。
      forwarding.status = 'carrier_rejected';
      mail.status = 'pending';
      mail.currentForwardingId = null;
      mailEvent(state, mail, now, 'forwarding_rejected', '承运台拒绝受理，恢复现场领取');
    }
  } else if (result.outcome === 'unclear') {
    // 受理未明：保留原件责任，不允许现场领取，等待查单。
    forwarding.status = 'unclear';
    forwarding.unclearAt = now;
    forwarding.unclearReason = result.error ?? '网络未明';
    forwarding.events.push({ at: now, type: 'carrier_unclear', note: forwarding.unclearReason });
    mailEvent(state, mail, now, 'forwarding_unclear', '承运受理未明，原件继续保管，禁止现场领取');
  } else {
    forwarding.status = 'carrier_rejected';
    forwarding.events.push({ at: now, type: 'carrier_rejected_submit', note: `HTTP ${result.httpStatus}` });
    mail.status = 'pending';
    mail.currentForwardingId = null;
    mailEvent(state, mail, now, 'forwarding_rejected', '承运台未受理，恢复现场领取');
  }
  return forwarding;
}

// 同步承运台查单结果。
export async function syncForwarding(state, deps, forwardingId, actor, now) {
  const forwarding = findForwarding(state, forwardingId);
  const mail = state.mail.find(m => m.id === forwarding.mailId);
  const result = await deps.carrier.lookup(forwarding.carrierNo);
  if (result.outcome === 'unclear') {
    forwarding.events.push({ at: now, type: 'lookup_unclear', note: result.error ?? '查单网络未明' });
    return { forwarding, synced: false, note: '查单未明，维持原状并继续保留原件责任' };
  }
  if (result.outcome === 'missing') {
    if (forwarding.status === 'unclear') {
      // 查单确认未受理：可以安全撤回，恢复库存。
      forwarding.status = 'carrier_rejected';
      forwarding.events.push({ at: now, type: 'lookup_missing', note: '查单确认承运台无此流水' });
      if (mail.currentForwardingId === forwarding.id) {
        mail.currentForwardingId = null;
        mail.status = 'pending';
        mailEvent(state, mail, now, 'forwarding_rejected', '查无承运流水，恢复现场领取');
      }
    }
    return { forwarding, synced: true, carrierFound: false };
  }
  if (result.outcome !== 'found') {
    return { forwarding, synced: false, note: `承运台响应异常 HTTP ${result.httpStatus}` };
  }
  const op = result.operation;
  forwarding.carrierStatus = op.status;
  forwarding.carrierRevision = op.revision ?? forwarding.carrierRevision;
  forwarding.events.push({ at: now, type: 'lookup', note: `承运台状态：${op.status}` });

  if (forwarding.status === 'unclear') {
    if (op.status === 'rejected') {
      forwarding.status = 'carrier_rejected';
      if (mail.currentForwardingId === forwarding.id) {
        mail.currentForwardingId = null;
        mail.status = 'pending';
        mailEvent(state, mail, now, 'forwarding_rejected', '查单确认承运台拒绝，恢复现场领取');
      }
    } else {
      // accepted/pending/confirmed/returned 都说明流水真实存在，受理成立。
      forwarding.status = 'submitted';
      mailEvent(state, mail, now, 'forwarding_confirmed_receipt', '查单确认承运台已受理，原件责任按转寄流程保留');
    }
  }
  if (op.status === 'confirmed') applyCarrierTerminal(state, forwarding, mail, 'completed', 'forwarded', now, '承运台确认实际转寄完成');
  if (op.status === 'returned') applyCarrierTerminal(state, forwarding, mail, 'returned', 'returned', now, '承运台确认原件退回');
  return { forwarding, synced: true, carrierFound: true, carrierStatus: op.status };
}

function applyCarrierTerminal(state, forwarding, mail, fwdStatus, mailStatus, now, note) {
  if (forwarding.status !== 'completed' && forwarding.status !== 'returned') {
    forwarding.status = fwdStatus;
    forwarding.completedAt = now;
    forwarding.events.push({ at: now, type: 'terminal', note });
  }
  if (mail.status !== mailStatus) {
    mail.status = mailStatus;
    mailEvent(state, mail, now, fwdStatus === 'completed' ? 'forwarded' : 'returned_by_carrier', note);
  }
}

// 撤销：仅在尚未实际提交承运台时才恢复库存；已受理后的撤销一律是拦截申请。
export function revokeForwarding(state, body, forwardingId, actor, now) {
  const forwarding = findForwarding(state, forwardingId);
  const mail = state.mail.find(m => m.id === forwarding.mailId);
  // 已取消不可再撤销；completed/returned 等实物终态仍可登记拦截申请（件不恢复库存）。
  if (forwarding.status === 'cancelled') {
    throw new HttpError(409, 'state_conflict', '转寄已取消，不能重复撤销');
  }
  // requested 且从未成功提交：可直接撤回，件恢复为可领取。
  if (forwarding.status === 'requested' && !forwarding.submittedAt) {
    forwarding.status = 'cancelled';
    forwarding.cancelledAt = now;
    forwarding.events.push({ at: now, type: 'cancelled', note: '提交前撤销，恢复现场领取' });
    mail.currentForwardingId = null;
    mail.status = 'pending';
    mailEvent(state, mail, now, 'forwarding_cancelled', '转寄提交前撤销，恢复可领取');
    return { forwarding, kind: 'cancellation' };
  }
  // 已实际转寄（或受理未明、已提交）之后到达的撤销只能作为拦截申请，件不恢复库存。
  const intercept = {
    id: nextId(state, 'INT'),
    at: now,
    requestedBy: actor.id,
    reason: String(body?.reason ?? '申请拦截').slice(0, 200),
    status: 'requested',
  };
  forwarding.intercepts.push(intercept);
  forwarding.events.push({ at: now, type: 'intercept_requested', note: intercept.reason, interceptId: intercept.id });
  mailEvent(state, mail, now, 'intercept_requested', '撤销仅登记为拦截申请，不恢复可领取库存', { interceptId: intercept.id });
  return { forwarding, intercept, kind: 'intercept' };
}

// 承运台对拦截的结论（由运营根据承运台凭证登记）。
export function resolveIntercept(state, forwardingId, interceptId, body, actor, now) {
  const forwarding = findForwarding(state, forwardingId);
  const intercept = forwarding.intercepts.find(i => i.id === interceptId);
  if (!intercept) throw new HttpError(404, 'not_found', '拦截申请不存在');
  if (intercept.status !== 'requested') throw new HttpError(409, 'state_conflict', '拦截申请已处理');
  if (!['intercepted', 'failed'].includes(body.outcome)) {
    throw new HttpError(400, 'bad_outcome', 'outcome 必须是 intercepted 或 failed');
  }
  intercept.status = body.outcome;
  intercept.resolvedAt = now;
  intercept.resolvedBy = actor.id;
  intercept.evidence = String(body.evidence ?? '').slice(0, 200);
  forwarding.events.push({ at: now, type: 'intercept_resolved', note: `拦截结论：${body.outcome}` });
  const mail = state.mail.find(m => m.id === forwarding.mailId);
  if (body.outcome === 'intercepted') {
    // 拦截成功意味着实物退回前台，登记为退回而非“可领取库存”的简单恢复。
    mail.status = 'returned';
    mailEvent(state, mail, now, 'intercepted_return', '拦截成功，实物退回，按退回件另行处理');
  } else {
    mailEvent(state, mail, now, 'intercept_failed', '拦截失败，转寄继续');
  }
  return intercept;
}
