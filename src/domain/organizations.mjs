import { HttpError, assertCompanyExists, assertPersonExists, isDateString, requireFields } from '../http-util.mjs';
import { nextId } from '../store.mjs';

// 当前日期是否存在有效代表权。
export function activeRepresentationAt(state, companyId, personId, date) {
  return state.representations.find(
    r => r.companyId === companyId && r.personId === personId && r.status === 'active'
      && r.validFrom <= date && date <= r.validUntil,
  );
}

// 授权领取人校验：有期限、材料范围（件型）、是否允许转交，且处于已核实状态。
export function validRecipientAuthAt(state, companyId, personId, date, kind) {
  return state.recipientAuths.find(
    a => a.companyId === companyId && a.personId === personId && a.status === 'active'
      && a.validFrom <= date && date <= a.validUntil
      && a.scopeKinds.includes(kind),
  );
}

export function createPerson(state, body, actor, now) {
  requireFields(body, ['name']);
  const person = { id: nextId(state, 'PER'), name: String(body.name).slice(0, 100) };
  state.persons.push(person);
  return person;
}

// 企业身份申请：任何企业代表可以发起，但核准权只在运营。
export function createCompanyApplication(state, body, actor, now) {
  requireFields(body, ['name']);
  const application = {
    id: nextId(state, 'CAPP'),
    name: String(body.name).slice(0, 120),
    applicantActorId: actor.id,
    applicantPersonId: actor.personId,
    status: 'submitted',
    submittedAt: now,
    confirmedBy: null,
    companyId: null,
  };
  state.companyApplications.push(application);
  return application;
}

export function confirmCompanyApplication(state, applicationId, actor, now) {
  const application = state.companyApplications.find(a => a.id === applicationId);
  if (!application) throw new HttpError(404, 'not_found', '企业申请不存在');
  if (application.status !== 'submitted') throw new HttpError(409, 'state_conflict', '该申请已处理');
  // 申请人不能独自核准自己的企业身份（按自然人与 actor 双重判断）。
  if (application.applicantActorId === actor.id || (actor.personId && application.applicantPersonId === actor.personId)) {
    throw new HttpError(403, 'self_approval_forbidden', '申请人不能核准自己的企业身份申请');
  }
  const company = {
    id: nextId(state, 'CO'),
    name: application.name,
    status: 'registered',
    arrivalPolicyAfterAddress: 'reject',
  };
  state.companies.push(company);
  application.status = 'confirmed';
  application.confirmedBy = actor.id;
  application.companyId = company.id;
  return { application, company };
}

export function rejectCompanyApplication(state, applicationId, actor, body, now) {
  const application = state.companyApplications.find(a => a.id === applicationId);
  if (!application) throw new HttpError(404, 'not_found', '企业申请不存在');
  if (application.status !== 'submitted') throw new HttpError(409, 'state_conflict', '该申请已处理');
  if (application.applicantActorId === actor.id || (actor.personId && application.applicantPersonId === actor.personId)) {
    throw new HttpError(403, 'self_approval_forbidden', '申请人不能核准自己的企业身份申请');
  }
  application.status = 'rejected';
  application.confirmedBy = actor.id;
  application.rejectReason = body.reason ?? '未说明';
  return application;
}

// 代表权登记申请。签约与授权主张先记录，核实通过后才生效。
export function createRepresentation(state, body, actor, now) {
  requireFields(body, ['companyId', 'personId', 'validFrom', 'validUntil']);
  assertCompanyExists(state, body.companyId);
  assertPersonExists(state, body.personId);
  if (!isDateString(body.validFrom) || !isDateString(body.validUntil) || body.validFrom > body.validUntil) {
    throw new HttpError(400, 'bad_date', '代表权期间格式或顺序不符');
  }
  const representation = {
    id: nextId(state, 'REP'),
    companyId: body.companyId,
    personId: body.personId,
    status: 'pending',
    validFrom: body.validFrom,
    validUntil: body.validUntil,
    basis: String(body.basis ?? '').slice(0, 300),
    applicantActorId: actor.id,
    verifiedBy: null,
    verifiedAt: null,
    events: [{ at: now, type: 'submitted', note: '代表权登记待核实' }],
  };
  state.representations.push(representation);
  return representation;
}

export function verifyRepresentation(state, representationId, actor, body, now) {
  const rep = state.representations.find(r => r.id === representationId);
  if (!rep) throw new HttpError(404, 'not_found', '代表权记录不存在');
  if (rep.status !== 'pending') throw new HttpError(409, 'state_conflict', '该代表权已处理');
  // 不能自行核准本人的代表权：按自然人身份判断，运营代他人提交不受影响。
  if (actor.personId && actor.personId === rep.personId) {
    throw new HttpError(403, 'self_approval_forbidden', '不能自行核准本人的代表权');
  }
  rep.status = 'active';
  rep.verifiedBy = actor.id;
  rep.verifiedAt = now;
  rep.events.push({ at: now, type: 'verified', note: body.note ?? '运营核实通过' });

  // 新代表权生效：同企业旧代表权终止（同一自然人续期不替代自己）；
  // 旧授权进入待重新核实，已合法领取的事实保留在来件事件里。
  for (const old of state.representations) {
    if (old.id !== rep.id && old.companyId === rep.companyId && old.status === 'active' && old.personId !== rep.personId) {
      old.status = 'superseded';
      old.events.push({ at: now, type: 'superseded', note: `被新代表权 ${rep.id} 替代`, newRepId: rep.id });
    }
  }
  for (const auth of state.recipientAuths) {
    if (auth.companyId === rep.companyId && auth.status === 'active') {
      auth.status = 'reverify';
      auth.events.push({ at: now, type: 'reverify_required', note: '代表权变化，新接收授权需重新核实' });
    }
  }
  return rep;
}

export function rejectRepresentation(state, representationId, actor, body, now) {
  const rep = state.representations.find(r => r.id === representationId);
  if (!rep) throw new HttpError(404, 'not_found', '代表权记录不存在');
  if (rep.status !== 'pending') throw new HttpError(409, 'state_conflict', '该代表权已处理');
  // 不能自行核准本人的代表权：按自然人身份判断，运营代他人提交不受影响。
  if (actor.personId && actor.personId === rep.personId) {
    throw new HttpError(403, 'self_approval_forbidden', '不能自行核准本人的代表权');
  }
  rep.status = 'rejected';
  rep.verifiedBy = actor.id;
  rep.verifiedAt = now;
  rep.events.push({ at: now, type: 'rejected', note: body.reason ?? '材料不足' });
  return rep;
}

const MAIL_KINDS = ['parcel', 'registered', 'letter'];

// 授权领取人：必须由该企业当前有效代表提出，运营核实后生效。
export function createRecipientAuth(state, body, actor, now) {
  requireFields(body, ['companyId', 'personId', 'validFrom', 'validUntil', 'scopeKinds']);
  assertCompanyExists(state, body.companyId);
  assertPersonExists(state, body.personId);
  if (!isDateString(body.validFrom) || !isDateString(body.validUntil) || body.validFrom > body.validUntil) {
    throw new HttpError(400, 'bad_date', '授权期间格式或顺序不符');
  }
  const scopeKinds = body.scopeKinds;
  if (!Array.isArray(scopeKinds) || !scopeKinds.length || scopeKinds.some(k => !MAIL_KINDS.includes(k))) {
    throw new HttpError(400, 'bad_scope', `材料范围必须是 ${MAIL_KINDS.join('/')} 的非空组合`);
  }
  const today = now.slice(0, 10);
  if (!actor.personId || !activeRepresentationAt(state, body.companyId, actor.personId, today)) {
    throw new HttpError(403, 'forbidden', '只有企业当前有效代表才能登记授权领取人');
  }
  const auth = {
    id: nextId(state, 'RA'),
    companyId: body.companyId,
    personId: body.personId,
    grantedByPersonId: actor.personId,
    status: 'pending',
    validFrom: body.validFrom,
    validUntil: body.validUntil,
    scopeKinds: [...new Set(scopeKinds)],
    allowHandover: Boolean(body.allowHandover),
    scopeNote: String(body.scopeNote ?? '').slice(0, 200),
    verifiedBy: null,
    verifiedAt: null,
    events: [{ at: now, type: 'submitted', note: '授权领取登记待运营核实' }],
  };
  state.recipientAuths.push(auth);
  return auth;
}

export function verifyRecipientAuth(state, authId, actor, body, now) {
  const auth = state.recipientAuths.find(a => a.id === authId);
  if (!auth) throw new HttpError(404, 'not_found', '授权记录不存在');
  if (!['pending', 'reverify'].includes(auth.status)) {
    throw new HttpError(409, 'state_conflict', '该授权当前状态不允许核实');
  }
  // 新的接收授权要核实：代表权变化后，需确认企业当前存在有效代表承接授权关系。
  const today = now.slice(0, 10);
  const hasActiveRep = state.representations.some(
    r => r.companyId === auth.companyId && r.status === 'active' && r.validFrom <= today && today <= r.validUntil,
  );
  if (!hasActiveRep) throw new HttpError(409, 'state_conflict', '企业当前没有有效代表，需先完成代表权核实');
  auth.status = 'active';
  auth.verifiedBy = actor.id;
  auth.verifiedAt = now;
  auth.events.push({ at: now, type: 'verified', note: body.note ?? '运营核实授权领取人' });
  return auth;
}

export function revokeRecipientAuth(state, authId, actor, body, now) {
  const auth = state.recipientAuths.find(a => a.id === authId);
  if (!auth) throw new HttpError(404, 'not_found', '授权记录不存在');
  if (auth.status === 'revoked') throw new HttpError(409, 'state_conflict', '授权已撤销');
  if (actor.role === 'representative') {
    if (!actor.personId || auth.grantedByPersonId !== actor.personId) {
      throw new HttpError(403, 'forbidden', '只能撤销本人提出的授权');
    }
  }
  auth.status = 'revoked';
  auth.events.push({ at: now, type: 'revoked', note: body.reason ?? '撤销授权', by: actor.id });
  return auth;
}
