import { HttpError, assertCompanyExists, isIsoString, mailEvent, requireFields } from '../http-util.mjs';
import { nextId } from '../store.mjs';
import { activeRepresentationAt, validRecipientAuthAt } from './organizations.mjs';
import { activeServiceAt } from './tenancy.mjs';

const MAIL_KINDS = ['parcel', 'registered', 'letter'];
// 可拒收包裹在登记时可直接拒收；挂号通知只能登记待处理，不能拒收处理。
const REJECTABLE_KINDS = ['parcel'];

function findMail(state, mailId) {
  const mail = state.mail.find(m => m.id === mailId);
  if (!mail) throw new HttpError(404, 'not_found', '来件不存在');
  return mail;
}

// 地址托管是否覆盖某时刻（按日期）。
export function addressCovered(state, companyId, date) {
  return Boolean(activeServiceAt(state, companyId, 'address', date));
}

// 前台登记真实来件：件号、收件主体、到达时间、封装状态必填。
export function registerMail(state, body, actor, now) {
  requireFields(body, ['trackingNo', 'companyId', 'arrivedAt', 'packaging']);
  assertCompanyExists(state, body.companyId);
  if (!isIsoString(body.arrivedAt)) throw new HttpError(400, 'bad_date', '到达时间必须是完整时间字符串');
  if (!MAIL_KINDS.includes(body.kind)) throw new HttpError(400, 'bad_kind', `件型必须是 ${MAIL_KINDS.join('/')}`);
  if (state.mail.some(m => m.trackingNo === body.trackingNo)) {
    throw new HttpError(409, 'state_conflict', '件号已登记，不能重复登记');
  }
  const arrivedDate = body.arrivedAt.slice(0, 10);
  const company = state.companies.find(c => c.id === body.companyId);
  const covered = addressCovered(state, body.companyId, arrivedDate);

  // 地址到期以后的新来件依约拒收或待核实，不能因历史合同继续接收。
  if (!covered) {
    const policy = company.arrivalPolicyAfterAddress ?? 'reject';
    if (policy === 'reject') {
      const rejected = {
        id: nextId(state, 'MAIL'),
        trackingNo: body.trackingNo,
        companyId: body.companyId,
        kind: body.kind,
        requiresPrincipal: Boolean(body.requiresPrincipal),
        arrivedAt: body.arrivedAt,
        packaging: body.packaging,
        deadline: body.deadline ?? null,
        scanRef: body.scanRef ? String(body.scanRef).slice(0, 120) : null,
        note: '地址托管已结束，依约拒收',
        status: 'rejected',
        registeredBy: actor.id,
        currentForwardingId: null,
        disputeIds: [],
        events: [{ at: now, type: 'rejected_on_arrival', note: '地址托管到期，企业约定拒收' }],
      };
      state.mail.push(rejected);
      return rejected;
    }
    // verify 策略：登记为待核实，不进入可领取库存。
    const held = buildMail(state, body, actor, now, 'verification_hold');
    held.note = '地址托管已结束，来件待核实后再决定拒收或受理';
    mailEvent(state, held, now, 'verification_hold', '地址托管到期，新来件待核实');
    state.mail.push(held);
    return held;
  }

  // 可拒收包裹可在登记环节拒收。
  if (body.rejectOnArrival === true) {
    if (!REJECTABLE_KINDS.includes(body.kind)) {
      throw new HttpError(400, 'not_rejectable', '该件型不支持登记即拒收，须登记为待处理');
    }
    const rejected = buildMail(state, body, actor, now, 'rejected');
    mailEvent(state, rejected, now, 'rejected_on_arrival', body.rejectReason ?? '可拒收包裹，登记时拒收');
    state.mail.push(rejected);
    return rejected;
  }

  const mail = buildMail(state, body, actor, now, 'pending');
  mailEvent(state, mail, now, 'registered', '前台登记来件，等待领取或处理');
  state.mail.push(mail);
  return mail;
}

function buildMail(state, body, actor, now, status) {
  return {
    id: nextId(state, 'MAIL'),
    trackingNo: String(body.trackingNo).slice(0, 100),
    companyId: body.companyId,
    kind: body.kind,
    requiresPrincipal: Boolean(body.requiresPrincipal),
    arrivedAt: body.arrivedAt,
    packaging: String(body.packaging).slice(0, 60),
    deadline: body.deadline ?? null,
    // 扫描面单只保存引用，不保存可公开全文；任何接口都不返回全文。
    scanRef: body.scanRef ? String(body.scanRef).slice(0, 120) : null,
    note: body.note ? String(body.note).slice(0, 200) : null,
    status,
    registeredBy: actor.id,
    currentForwardingId: null,
    disputeIds: [],
    events: [],
  };
}

// 待核实来件的后续决定：核实通过才进入可领取库存；否则拒收。
export function resolveVerificationHold(state, mailId, actor, body, now) {
  const mail = findMail(state, mailId);
  if (mail.status !== 'verification_hold') throw new HttpError(409, 'state_conflict', '该件不在待核实状态');
  if (body.decision === 'accept') {
    mail.status = 'pending';
    mailEvent(state, mail, now, 'verification_accepted', body.reason ?? '核实后受理');
  } else if (body.decision === 'reject') {
    mail.status = 'rejected';
    mailEvent(state, mail, now, 'verification_rejected', body.reason ?? '核实后拒收');
  } else {
    throw new HttpError(400, 'bad_decision', 'decision 必须是 accept 或 reject');
  }
  mail.resolvedBy = actor.id;
  return mail;
}

function assertPickable(mail) {
  if (mail.status !== 'pending') {
    throw new HttpError(409, 'state_conflict', `来件状态为 ${mail.status}，不可现场领取`);
  }
  if (mail.blocked) throw new HttpError(409, 'delivery_suspended', '该件存在未结争议，交付暂停');
  if (mail.currentForwardingId) throw new HttpError(409, 'forwarding_active', '该件已有转寄安排，不能同时现场领取');
}

// 前台领取登记：核验领取人资格，社区不能仅凭工位号把不同企业的件交给同一个人。
export function pickupMail(state, mailId, body, actor, now) {
  requireFields(body, ['personId']);
  const mail = findMail(state, mailId);
  assertPickable(mail);
  const person = state.persons.find(p => p.id === body.personId);
  if (!person) throw new HttpError(404, 'not_found', '领取人不存在');
  const today = now.slice(0, 10);
  const isRepresentative = Boolean(activeRepresentationAt(state, mail.companyId, body.personId, today));

  let basis;
  if (mail.requiresPrincipal) {
    // 需本人签收的通知：普通代领人不能领取，只能由当前有效代表本人签收。
    if (!isRepresentative) {
      throw new HttpError(403, 'principal_required', '该通知需企业代表本人签收，普通代领人无权领取');
    }
    basis = 'representative_signature';
  } else if (isRepresentative) {
    basis = 'representative';
  } else {
    const auth = validRecipientAuthAt(state, mail.companyId, body.personId, today, mail.kind);
    if (!auth) throw new HttpError(403, 'no_recipient_auth', '该领取人对此企业此类材料没有有效授权');
    // 转交链条：允许转交时须登记最终实际领取人；不允许转交则必须授权人本人。
    if (body.handedToPersonId) {
      if (!auth.allowHandover) throw new HttpError(403, 'handover_forbidden', '该授权不允许转交');
      const finalPerson = state.persons.find(p => p.id === body.handedToPersonId);
      if (!finalPerson) throw new HttpError(404, 'not_found', '转交对象不存在');
    }
    basis = body.handedToPersonId ? 'recipient_auth_handover' : 'recipient_auth';
  }

  mail.status = 'delivered';
  mail.deliveredAt = now;
  mail.deliveredToPersonId = body.personId;
  mail.handedToPersonId = body.handedToPersonId ?? null;
  mail.deliveryBasis = basis;
  mail.receiptNote = body.receiptNote ? String(body.receiptNote).slice(0, 200) : null;
  mailEvent(state, mail, now, 'delivered', `领取依据：${basis}`, { personId: body.personId, handedTo: body.handedToPersonId ?? null });
  return mail;
}

// 时限将到仍未指定合格接收人：返回待处理事项，绝不自动写成已送达。
export function pendingDeadlines(state, atDate, role, user) {
  const rows = state.mail
    .filter(m => m.status === 'pending' || m.status === 'verification_hold')
    .filter(m => role !== 'representative' || state.representations.some(r => r.companyId === m.companyId && r.personId === user.personId && r.status === 'active'))
    .map(m => {
      const today = atDate;
      const hasPrincipal = state.representations.some(r => r.companyId === m.companyId && r.status === 'active' && r.validFrom <= today && today <= r.validUntil);
      const actions = [];
      if (m.requiresPrincipal && !hasPrincipal) {
        actions.push('需企业代表本人签收，但当前没有有效代表，请尽快指定并完成代表权核实');
      } else if (!m.requiresPrincipal) {
        const hasAuth = state.recipientAuths.some(a => a.companyId === m.companyId && a.status === 'active' && a.scopeKinds.includes(m.kind) && a.validFrom <= today && today <= a.validUntil);
        if (!hasAuth && !hasPrincipal) actions.push('尚无合格授权领取人，需登记并核实授权后才能领取');
      }
      if (m.status === 'verification_hold') actions.push('地址托管已结束，本件待运营核实受理或拒收');
      if (m.blocked) actions.push('存在未结争议，交付暂停，等待争议复核结论');
      let urgency = 'normal';
      if (m.deadline) {
        const days = Math.ceil((new Date(m.deadline) - new Date(today)) / 86400000);
        if (days <= 2) urgency = 'urgent';
        else if (days <= 5) urgency = 'soon';
      }
      return {
        mailId: m.id,
        companyId: m.companyId,
        kind: m.kind,
        requiresPrincipal: m.requiresPrincipal,
        status: m.status,
        deadline: m.deadline,
        urgency,
        pendingActions: actions,
      };
    });
  return rows;
}

// 前台视图：只含交付所需内容，不含扫描全文引用以外的内部备注，且按件号限定。
export function frontDeskView(mail) {
  return {
    id: mail.id,
    trackingNo: mail.trackingNo,
    companyId: mail.companyId,
    kind: mail.kind,
    requiresPrincipal: mail.requiresPrincipal,
    packaging: mail.packaging,
    arrivedAt: mail.arrivedAt,
    deadline: mail.deadline,
    status: mail.status,
    blocked: Boolean(mail.blocked),
    hasForwarding: Boolean(mail.currentForwardingId),
    scanRef: mail.scanRef,
  };
}

// 企业视图：只能查自己的件。
export function companyMailList(state, companyId) {
  return state.mail.filter(m => m.companyId === companyId).map(m => ({
    id: m.id,
    trackingNo: m.trackingNo,
    kind: m.kind,
    requiresPrincipal: m.requiresPrincipal,
    arrivedAt: m.arrivedAt,
    status: m.status,
    deadline: m.deadline,
    deliveredAt: m.deliveredAt ?? null,
    deliveredToPersonId: m.deliveredToPersonId ?? null,
    deliveryBasis: m.deliveryBasis ?? null,
    currentForwardingId: m.currentForwardingId,
    blocked: Boolean(m.blocked),
    events: m.events.map(e => ({ at: e.at, type: e.type, note: e.note })),
  }));
}

export function getMailById(state, mailId) {
  return findMail(state, mailId);
}

export function listMail(state, role, user, companyId = null) {
  let rows = state.mail;
  if (companyId) rows = rows.filter(m => m.companyId === companyId);
  if (role === 'representative') {
    const companies = state.representations.filter(r => r.personId === user.personId && r.status === 'active').map(r => r.companyId);
    rows = rows.filter(m => companies.includes(m.companyId));
  }
  return rows;
}
