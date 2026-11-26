import { HttpError, assertCompanyExists, dateWithin, isDateString, requireFields } from '../http-util.mjs';
import { nextId } from '../store.mjs';
import { activeRepresentationAt } from './organizations.mjs';

const SERVICE_KINDS = ['office', 'address'];

// 某企业在某日是否仍有指定服务期间。
export function activeServiceAt(state, companyId, kind, date) {
  return state.services.find(s => s.companyId === companyId && s.kind === kind && dateWithin(date, s.start, s.end));
}

// 入驻申请：企业代表提出，需含签约主体与拟授权领取人说明；运营确认时校验代表权。
export function createTenancyApplication(state, body, actor, now) {
  requireFields(body, ['companyId', 'signatoryPersonId', 'services']);
  assertCompanyExists(state, body.companyId);
  const today = now.slice(0, 10);
  if (!activeRepresentationAt(state, body.companyId, body.signatoryPersonId, today)) {
    throw new HttpError(409, 'state_conflict', '签约人在今日没有有效代表权，不能作为签约主体确认');
  }
  if (!Array.isArray(body.services) || body.services.length === 0) {
    throw new HttpError(400, 'bad_request', '至少声明一项服务期间');
  }
  const normalized = body.services.map(s => {
    if (!SERVICE_KINDS.includes(s.kind) || !isDateString(s.start) || !isDateString(s.end) || s.start > s.end) {
      throw new HttpError(400, 'bad_service', '服务期间类型或日期不符');
    }
    return { kind: s.kind, start: s.start, end: s.end };
  });
  if (new Set(normalized.map(s => s.kind)).size !== normalized.length) {
    throw new HttpError(400, 'bad_service', '同类服务期间只能出现一次');
  }
  const application = {
    id: nextId(state, 'TA'),
    companyId: body.companyId,
    signatoryPersonId: body.signatoryPersonId,
    status: 'submitted',
    services: normalized,
    intendedRecipients: Array.isArray(body.intendedRecipients) ? body.intendedRecipients : [],
    submittedBy: actor.id,
    submittedAt: now,
    confirmedBy: null,
    confirmedAt: null,
  };
  state.tenancyApplications.push(application);
  return application;
}

export function confirmTenancy(state, applicationId, actor, body, now) {
  const application = state.tenancyApplications.find(a => a.id === applicationId);
  if (!application) throw new HttpError(404, 'not_found', '入驻申请不存在');
  if (application.status !== 'submitted') throw new HttpError(409, 'state_conflict', '该入驻申请已处理');
  const today = now.slice(0, 10);
  // 运营确认签约主体：签约人须仍有代表权。
  if (!activeRepresentationAt(state, application.companyId, application.signatoryPersonId, today)) {
    throw new HttpError(409, 'state_conflict', '签约人代表权已失效，需先核实新代表权');
  }
  // 拟授权领取人必须存在已核实的授权（或由企业代表本人领取）。
  for (const personId of application.intendedRecipients) {
    const auth = state.recipientAuths.find(a => a.companyId === application.companyId && a.personId === personId && a.status === 'active');
    if (!auth) throw new HttpError(409, 'state_conflict', `授权领取人 ${personId} 尚未完成核实`);
  }
  application.status = 'confirmed';
  application.confirmedBy = actor.id;
  application.confirmedAt = now;
  const created = application.services.map(s => {
    const service = {
      id: nextId(state, 'SV'),
      companyId: application.companyId,
      kind: s.kind,
      start: s.start,
      end: s.end,
      status: 'active',
      applicationId: application.id,
    };
    state.services.push(service);
    return service;
  });
  const company = state.companies.find(c => c.id === application.companyId);
  company.status = 'in_community';
  return { application, services: created };
}

// ---------- 门禁 ----------

export function issueCredential(state, body, actor, now) {
  requireFields(body, ['companyId', 'personId']);
  assertCompanyExists(state, body.companyId);
  const person = state.persons.find(p => p.id === body.personId);
  if (!person) throw new HttpError(404, 'not_found', '自然人不存在');
  const today = now.slice(0, 10);
  // 门禁发给个人，但必须锚定企业服务关系；企业授权与个人门禁不混为一谈。
  if (!activeServiceAt(state, body.companyId, 'office', today)) {
    throw new HttpError(409, 'state_conflict', '该企业当前没有有效空间使用服务，不能发放入场凭证');
  }
  const credential = {
    id: nextId(state, 'CRED'),
    companyId: body.companyId,
    personId: body.personId,
    type: body.type === 'card' ? 'card' : 'key',
    status: 'issued',
    issuedAt: now,
    issuedBy: actor.id,
    returnRequestedAt: null,
    returnedAt: null,
    verifiedBy: null,
    note: String(body.note ?? '').slice(0, 200),
  };
  state.credentials.push(credential);
  return credential;
}

// 归还确认期间先冻结新入场，确认后转已归还。
export function beginCredentialReturn(state, credentialId, actor, now) {
  const credential = state.credentials.find(c => c.id === credentialId);
  if (!credential) throw new HttpError(404, 'not_found', '凭证不存在');
  if (credential.status !== 'issued') throw new HttpError(409, 'state_conflict', '只有已发放凭证可申请归还');
  credential.status = 'return_pending';
  credential.returnRequestedAt = now;
  return credential;
}

export function completeCredentialReturn(state, credentialId, actor, body, now) {
  const credential = state.credentials.find(c => c.id === credentialId);
  if (!credential) throw new HttpError(404, 'not_found', '凭证不存在');
  if (credential.status !== 'return_pending') throw new HttpError(409, 'state_conflict', '凭证不在归还确认中');
  credential.status = 'returned';
  credential.returnedAt = now;
  credential.verifiedBy = actor.id;
  credential.returnCondition = body.condition ?? 'normal';
  return credential;
}

export function revokeCredential(state, credentialId, actor, body, now) {
  const credential = state.credentials.find(c => c.id === credentialId);
  if (!credential) throw new HttpError(404, 'not_found', '凭证不存在');
  if (credential.status === 'returned') throw new HttpError(409, 'state_conflict', '已归还凭证无需吊销');
  credential.status = 'revoked';
  credential.revokedAt = now;
  credential.revokedBy = actor.id;
  credential.revokeReason = body.reason ?? '运营吊销';
  return credential;
}

// 每次入场尝试都落记录；归还确认中的钥匙不再允许新入场。
export function recordEntryAttempt(state, body, actor, now) {
  requireFields(body, ['credentialId']);
  const credential = state.credentials.find(c => c.id === body.credentialId);
  if (!credential) throw new HttpError(404, 'not_found', '凭证不存在');
  const today = now.slice(0, 10);
  let allowed = true;
  const reasons = [];
  if (credential.status !== 'issued') {
    allowed = false;
    reasons.push(`凭证状态为 ${credential.status}，不允许入场`);
  }
  if (!activeServiceAt(state, credential.companyId, 'office', today)) {
    allowed = false;
    reasons.push('企业空间使用服务已结束');
  }
  const attempt = {
    id: nextId(state, 'ACC'),
    credentialId: credential.id,
    companyId: credential.companyId,
    personId: credential.personId,
    at: now,
    allowed,
    reasons,
    recordedBy: actor.id,
  };
  state.accessAttempts.push(attempt);
  return attempt;
}

// ---------- 退驻：空间、进出、地址托管、未结来件分别结束 ----------

export function createExitApplication(state, body, actor, now) {
  requireFields(body, ['companyId', 'officeEnd']);
  const company = assertCompanyExists(state, body.companyId);
  if (!isDateString(body.officeEnd)) throw new HttpError(400, 'bad_date', '空间结束日期不符');
  if (body.addressEnd !== undefined && body.addressEnd !== null && !isDateString(body.addressEnd)) {
    throw new HttpError(400, 'bad_date', '地址托管结束日期不符');
  }
  if (body.addressEnd && body.addressEnd < body.officeEnd) {
    throw new HttpError(400, 'bad_date', '地址托管不能早于空间使用结束');
  }
  const existing = state.exits.find(e => e.companyId === body.companyId && e.status !== 'withdrawn');
  if (existing) throw new HttpError(409, 'state_conflict', '该企业已有退驻申请，应在原申请上逐项交接');
  const exit = {
    id: nextId(state, 'EXIT'),
    companyId: body.companyId,
    officeEnd: body.officeEnd,
    requestedAddressEnd: body.addressEnd ?? null,
    status: 'open',
    submittedBy: actor.id,
    submittedAt: now,
    checkpoints: {
      space: { status: 'pending', endedAt: null, by: null },
      access: { status: 'pending', allReturned: false, by: null },
      address: { status: 'pending', endedAt: null, by: null },
      mail: { status: 'pending', openCount: null, by: null },
      deposit: { status: 'pending', by: null },
    },
    notes: String(body.note ?? '').slice(0, 300),
  };
  state.exits.push(exit);
  return exit;
}

// 结束空间使用：office 服务在结束日截止，并不自动终止地址托管。
export function closeSpaceCheckpoint(state, exitId, actor, now) {
  const exit = findExit(state, exitId);
  if (exit.checkpoints.space.status === 'done') throw new HttpError(409, 'state_conflict', '空间交接已完成');
  for (const service of state.services) {
    if (service.companyId === exit.companyId && service.kind === 'office' && service.status === 'active') {
      service.status = 'ended';
      service.end = exit.officeEnd;
      service.endedAt = now;
    }
  }
  exit.checkpoints.space = { status: 'done', endedAt: now, by: actor.id };
  const company = state.companies.find(c => c.id === exit.companyId);
  if (company.status === 'in_community') company.status = 'exiting';
  return exit;
}

// 人员进出结束：所有凭证归还或吊销后才能勾选。
export function closeAccessCheckpoint(state, exitId, actor, now) {
  const exit = findExit(state, exitId);
  const openCreds = state.credentials.filter(c => c.companyId === exit.companyId && ['issued', 'return_pending'].includes(c.status));
  if (openCreds.length) throw new HttpError(409, 'state_conflict', '仍有未归还或确认中的凭证，不能结束人员进出');
  exit.checkpoints.access = { status: 'done', allReturned: true, by: actor.id };
  return exit;
}

// 地址托管结束：把 address 服务截止到指定日期，并记录保留期。
export function closeAddressCheckpoint(state, exitId, actor, body, now) {
  const exit = findExit(state, exitId);
  const endDate = body?.addressEnd ?? exit.requestedAddressEnd ?? exit.officeEnd;
  if (!isDateString(endDate)) throw new HttpError(400, 'bad_date', '需明确地址托管结束日期');
  let retentionCreated = null;
  for (const service of state.services) {
    if (service.companyId === exit.companyId && service.kind === 'address' && service.status === 'active') {
      if (endDate > exit.officeEnd) {
        retentionCreated = {
          id: nextId(state, 'RET'),
          companyId: exit.companyId,
          start: exit.officeEnd,
          end: endDate,
          exitId: exit.id,
          createdAt: now,
        };
        state.retentions.push(retentionCreated);
      }
      service.status = 'ended';
      service.end = endDate;
      service.endedAt = now;
    }
  }
  exit.checkpoints.address = { status: 'done', endedAt: now, by: actor.id, addressEnd: endDate };
  return { exit, retention: retentionCreated };
}

export function closeMailCheckpoint(state, exitId, actor, now) {
  const exit = findExit(state, exitId);
  const openCount = state.mail.filter(m => m.companyId === exit.companyId && !['delivered', 'rejected', 'returned'].includes(m.status)).length;
  if (openCount > 0) throw new HttpError(409, 'state_conflict', `仍有 ${openCount} 件未结来件，不能结束来件交接`);
  exit.checkpoints.mail = { status: 'done', openCount: 0, by: actor.id };
  return exit;
}

export function closeDepositCheckpoint(state, exitId, actor, now) {
  const exit = findExit(state, exitId);
  exit.checkpoints.deposit = { status: 'done', by: actor.id };
  return exit;
}

function findExit(state, exitId) {
  const exit = state.exits.find(e => e.id === exitId);
  if (!exit) throw new HttpError(404, 'not_found', '退驻申请不存在');
  if (exit.status !== 'open') throw new HttpError(409, 'state_conflict', '退驻申请已关闭');
  return exit;
}

// 退驻总览：一个退驻申请即可看到哪些责任已结束、哪些仍未结。
export function exitOverview(state, exitId, now = new Date().toISOString()) {
  const exit = state.exits.find(e => e.id === exitId);
  if (!exit) throw new HttpError(404, 'not_found', '退驻申请不存在');
  const companyId = exit.companyId;
  const today = now.slice(0, 10);
  const openMail = state.mail
    .filter(m => m.companyId === companyId && !['delivered', 'rejected', 'returned'].includes(m.status))
    .map(m => ({ id: m.id, kind: m.kind, status: m.status, requiresPrincipal: m.requiresPrincipal, deadline: m.deadline }));
  const openForwardings = state.forwardings
    .filter(f => f.companyId === companyId && !['completed', 'cancelled'].includes(f.status))
    .map(f => ({ id: f.id, mailId: f.mailId, status: f.status, carrierStatus: f.carrierStatus }));
  const openDisputes = state.disputes
    .filter(d => d.companyId === companyId && d.status === 'open')
    .map(d => ({ id: d.id, mailId: d.mailId, reason: d.reason }));
  const openCreds = state.credentials
    .filter(c => c.companyId === companyId && ['issued', 'return_pending'].includes(c.status))
    .map(c => ({ id: c.id, personId: c.personId, type: c.type, status: c.status }));
  const deposit = state.deposits.find(d => d.companyId === companyId);
  const depositSummary = deposit ? summarizeDeposit(deposit) : null;
  const addressService = state.services.find(s => s.companyId === companyId && s.kind === 'address');
  const retention = state.retentions.find(r => r.companyId === companyId && r.end >= today);

  const responsibilities = {
    space: exit.checkpoints.space.status === 'done'
      ? { state: 'ended', detail: `空间使用已于 ${exit.officeEnd} 结束` }
      : { state: 'open', detail: '空间使用尚未交接' },
    access: openCreds.length
      ? { state: 'open', detail: '仍有有效/确认中的入场凭证', credentials: openCreds }
      : { state: 'ended', detail: '人员进出凭证均已归还或吊销' },
    address: (addressService && addressService.status === 'active' && addressService.end >= today)
      ? { state: 'active', detail: '地址托管仍在有效期', end: addressService.end, retention: Boolean(retention) }
      : { state: 'ended', detail: '地址托管已结束，新来件依约拒收或待核实' },
    mail: openMail.length || openForwardings.length
      ? { state: 'open', detail: '存在未结来件或在途转寄', openMail, openForwardings }
      : { state: 'ended', detail: '来件均已结清' },
    disputes: openDisputes.length
      ? { state: 'open', detail: '存在争议复核未结案', openDisputes }
      : { state: 'ended', detail: '无未结争议' },
    deposit: depositSummary && depositSummary.refundableMinor > 0
      ? { state: 'open', detail: '押金仍有可退或暂扣余额', ...depositSummary }
      : { state: 'ended', detail: '押金已结清', ...(depositSummary ?? {}) },
  };
  const allDone = Object.values(exit.checkpoints).every(c => c.status === 'done');
  return {
    exit,
    responsibilities,
    allCheckpointsDone: allDone,
    computedAt: now,
  };
}

export function finalizeExit(state, exitId, actor, now) {
  const overview = exitOverview(state, exitId, now);
  if (!overview.allCheckpointsDone) throw new HttpError(409, 'state_conflict', '退驻逐项交接未全部完成，不能标记退驻完成');
  const exit = state.exits.find(e => e.id === exitId);
  exit.status = 'completed';
  exit.completedAt = now;
  exit.completedBy = actor.id;
  const company = state.companies.find(c => c.id === exit.companyId);
  company.status = 'exited';
  return exit;
}

export function summarizeDeposit(deposit) {
  const feesMinor = deposit.fees.reduce((sum, f) => sum + f.amountMinor, 0);
  const heldMinor = deposit.holds.filter(h => h.status === 'held').reduce((sum, h) => sum + h.amountMinor, 0);
  const refundedMinor = deposit.refunds.reduce((sum, r) => sum + r.amountMinor, 0);
  return {
    depositId: deposit.id,
    amountMinor: deposit.amountMinor,
    feesMinor,
    heldMinor,
    refundedMinor,
    refundableMinor: Math.max(0, deposit.amountMinor - feesMinor - heldMinor - refundedMinor),
  };
}
