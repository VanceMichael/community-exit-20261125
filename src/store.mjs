import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 业务状态的内存结构与原子持久化。所有集合只保存事实与申请，不预计算结论。
export function freshState() {
  return {
    meta: { version: 1, seededFrom: null, createdAt: null },
    // 身份与主体
    users: {}, // actorId -> { id, role, personId, token }
    persons: [], // { id, name }
    companies: [], // { id, name, status, arrivalPolicyAfterAddress }
    companyApplications: [], // 企业身份申请，申请人不能自行核准
    // 企业授权
    representations: [], // 代表权：pending/active/superseded/rejected
    recipientAuths: [], // 授权领取人：pending/active/reverify/revoked
    // 入退驻
    tenancyApplications: [], // 入驻申请（含服务期间草案）
    services: [], // 已确认服务期间：office 空间 / address 地址托管
    retentions: [], // 退驻后的地址保留记录
    exits: [], // 退驻申请（逐项交接的聚合根）
    // 门禁
    credentials: [], // issued/return_pending/returned/revoked
    accessAttempts: [], // 每次入场尝试都留痕，拒绝也记录
    // 来件与交付
    mail: [], // 来件主记录，事件内嵌
    forwardings: [], // 转寄申请与承运台流水对照
    disputes: [], // 争议复核独立记录
    // 押金
    deposits: [], // 费用、暂扣、退款逐项登记
    // 未处理来源变更队列与审计
    inbound: [],
    audit: [],
    counters: {},
    revision: 0,
  };
}

// 生成编号时跳过种子资料已占用的编号，避免与合成基线冲突。
const ID_COLLECTIONS = [
  'persons', 'companies', 'companyApplications', 'representations', 'recipientAuths',
  'tenancyApplications', 'services', 'retentions', 'exits', 'credentials', 'accessAttempts',
  'mail', 'forwardings', 'disputes', 'deposits', 'inbound',
];

export function nextId(state, prefix) {
  const existing = new Set();
  for (const name of ID_COLLECTIONS) {
    for (const row of state[name] ?? []) {
      if (row && typeof row.id === 'string' && row.id.startsWith(`${prefix}-`)) existing.add(row.id);
    }
  }
  let candidate;
  do {
    state.counters[prefix] = (state.counters[prefix] ?? 0) + 1;
    candidate = `${prefix}-${state.counters[prefix]}`;
  } while (existing.has(candidate));
  return candidate;
}

export function loadState(stateFile, seedFile = null) {
  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = freshState();
    if (seedFile) seedState(state, JSON.parse(readFileSync(seedFile, 'utf8')), seedFile);
  }
  return state;
}

export function saveState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
  renameSync(stateFile + '.tmp', stateFile);
}

// 合成资料只作为未核准的初始登记：草案仍是草案，来源变更进入待处理队列。
export function seedState(state, seed, seedFile) {
  state.meta.seededFrom = seedFile;
  state.meta.createdAt = '2026-11-26T00:00:00Z';

  for (const person of seed.people ?? []) {
    state.persons.push({ id: person.id, name: person.name });
  }
  for (const company of seed.companies ?? []) {
    state.companies.push({
      id: company.id,
      name: company.name,
      status: 'registered',
      arrivalPolicyAfterAddress: 'reject',
    });
  }
  for (const actor of seed.actors ?? []) {
    // 本地合成环境使用确定性令牌；生产应由认证系统签发。
    state.users[actor.id] = {
      id: actor.id,
      role: actor.role,
      personId: actor.person ?? null,
      token: `tok-${actor.id}`,
    };
  }
  // 兼任账号：拥有运营权限但绑定自然人 PER-A，用于验证“不能自行核准本人”。
  state.users['ops-self'] = { id: 'ops-self', role: 'operations', personId: 'PER-A', token: 'tok-ops-self' };
  // 第二名复核员：用于验证争议不能由提出人自行解除。
  state.users['review-2'] = { id: 'review-2', role: 'reviewer', personId: null, token: 'tok-review-2' };
  for (const draft of seed.representationDrafts ?? []) {
    const submitter = (seed.actors ?? []).find(a => a.person === draft.person && a.role === 'representative');
    state.representations.push({
      id: draft.id,
      companyId: draft.company,
      personId: draft.person,
      status: 'pending',
      validFrom: '2026-11-01',
      validUntil: draft.until,
      basis: '合成登记资料中的代表权草案，尚未核准',
      applicantActorId: submitter ? submitter.id : null,
      verifiedBy: null,
      verifiedAt: null,
      events: [{ at: state.meta.createdAt, type: 'seeded', note: '草案导入，不代表已生效' }],
    });
  }
  const services = seed.serviceDrafts ?? [];
  if (services.length) {
    const companyId = services[0].company;
    state.tenancyApplications.push({
      id: 'TA-SEED-1',
      companyId,
      signatoryPersonId: 'PER-A',
      status: 'submitted',
      services: services.map(s => ({ kind: s.kind, start: s.start, end: s.end })),
      intendedRecipients: [],
      submittedBy: null,
      submittedAt: state.meta.createdAt,
      confirmedBy: null,
      confirmedAt: null,
      note: '由 serviceDrafts 导入的入驻草案，待运营确认签约主体',
    });
  }
  for (const item of seed.items ?? []) {
    state.mail.push({
      id: item.id,
      trackingNo: item.id,
      companyId: item.company,
      kind: item.kind,
      requiresPrincipal: Boolean(item.requiresPrincipal),
      arrivedAt: item.arrivedAt,
      packaging: 'intact',
      deadline: null,
      scanRef: null,
      note: null,
      status: 'pending',
      registeredBy: null,
      currentForwardingId: null,
      disputeIds: [],
      events: [{ at: item.arrivedAt, type: 'seeded', note: '合成来件基线资料' }],
    });
  }
  for (const asset of seed.assets ?? []) {
    state.credentials.push({
      id: asset.id,
      companyId: asset.company,
      personId: asset.person,
      type: 'key',
      status: 'issued',
      issuedAt: state.meta.createdAt,
      returnRequestedAt: null,
      returnedAt: null,
      verifiedBy: null,
      note: '由 assets 导入',
    });
  }
  for (const deposit of seed.deposits ?? []) {
    state.deposits.push({
      id: deposit.id,
      companyId: deposit.company,
      amountMinor: deposit.amountMinor,
      status: 'held',
      fees: [],
      holds: [],
      refunds: [],
    });
  }
  for (const change of seed.sourceChanges ?? []) {
    state.inbound.push({ id: change.id, payload: change, processed: false, receivedAt: state.meta.createdAt });
  }
  return state;
}
