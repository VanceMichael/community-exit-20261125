import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, TOKENS } from './helpers/harness.mjs';

const TOK = { ...TOKENS, opsSelf: 'tok-ops-self', review2: 'tok-review-2' };

// 把种子资料中的代表权草案核实为有效代表权，并确认种子入驻申请（产生 office/address 服务）。
async function activateSeedRep(h) {
  const verified = await h.call(TOK.ops, 'POST', '/representations/REP-1/verify', { note: '核实合成代表' });
  await h.call(TOK.ops, 'POST', '/tenancy-applications/TA-SEED-1/confirm', {});
  return verified;
}

test('代表权草案核实后生效，申请人不能自行核准企业身份', async () => {
  const h = await startHarness();
  try {
    // 无令牌拒绝。
    assert.equal((await h.call(null, 'GET', '/companies')).status, 401);
    // 前台不能登记代表权。
    assert.equal((await h.call(TOK.front, 'POST', '/representations', {
      companyId: 'CO-1', personId: 'PER-B', validFrom: '2026-11-01', validUntil: '2027-11-01',
    })).status, 403);

    // 兼任运营（绑定 PER-A）不能自行核准本人的代表权。
    const selfVerify = await h.call(TOK.opsSelf, 'POST', '/representations/REP-1/verify', {});
    assert.equal(selfVerify.status, 403);
    assert.equal(selfVerify.body.code, 'self_approval_forbidden');

    const verified = await activateSeedRep(h);
    assert.equal(verified.status, 200);
    assert.equal(verified.body.status, 'active');

    // 企业自行申请新公司，不能自己核准。
    const applied = await h.call(TOK.repA, 'POST', '/company-applications', { name: '新合成企业丙' });
    assert.equal(applied.status, 201);
    const selfConfirm = await h.call(TOK.opsSelf, 'POST', `/company-applications/${applied.body.id}/confirm`, {});
    assert.equal(selfConfirm.status, 403);
    assert.equal(selfConfirm.body.code, 'self_approval_forbidden');
    const confirmed = await h.call(TOK.ops, 'POST', `/company-applications/${applied.body.id}/confirm`, {});
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.company.status, 'registered');

    // 企业代表只能看到自己代表的企业。
    const mine = await h.call(TOK.repA, 'GET', '/companies');
    assert.ok(mine.body.companies.some(c => c.id === 'CO-1'));
  } finally { await h.stop(); }
});

test('一个自然人可代表多家企业；授权领取人有期限、范围与转交限制', async () => {
  const h = await startHarness();
  try {
    await activateSeedRep(h);
    // PER-A 再登记为 CO-2 的代表（同一自然人代表多家企业）。
    const rep2 = await h.call(TOK.ops, 'POST', '/representations', {
      companyId: 'CO-2', personId: 'PER-A', validFrom: '2026-11-01', validUntil: '2027-12-31', basis: '兼任',
    });
    assert.equal(rep2.status, 201);
    const rep2Verified = await h.call(TOK.ops, 'POST', `/representations/${rep2.body.id}/verify`, {});
    assert.equal(rep2Verified.status, 200);
    // CO-2 建立地址托管服务期间，否则其新来件会依约拒收。
    const ta2 = await h.call(TOK.repA, 'POST', '/tenancy-applications', {
      companyId: 'CO-2', signatoryPersonId: 'PER-A',
      services: [{ kind: 'address', start: '2026-11-01', end: '2027-06-30' }],
    });
    assert.equal((await h.call(TOK.ops, 'POST', `/tenancy-applications/${ta2.body.id}/confirm`, {})).status, 200);

    // 代表为 CO-1 登记授权领取人 PER-B，仅限 parcel，不允许转交。
    const auth = await h.call(TOK.repA, 'POST', '/recipient-auths', {
      companyId: 'CO-1', personId: 'PER-B', validFrom: '2026-11-01', validUntil: '2026-12-31',
      scopeKinds: ['parcel'], allowHandover: false,
    });
    assert.equal(auth.status, 201);
    assert.equal(auth.body.status, 'pending');
    const authOk = await h.call(TOK.ops, 'POST', `/recipient-auths/${auth.body.id}/verify`, {});
    assert.equal(authOk.status, 200);
    assert.equal(authOk.body.status, 'active');

    // 前台视图只看到交付资格字段，看不到内部备注。
    const frontView = await h.call(TOK.front, 'GET', '/recipient-auths?companyId=CO-1');
    assert.equal(frontView.status, 200);
    assert.ok(!('scopeNote' in frontView.body.recipientAuths[0]));
    assert.deepEqual(frontView.body.recipientAuths[0].scopeKinds, ['parcel']);

    // 登记一件 CO-2 的包裹，PER-B 不能凭 CO-1 的授权领取。
    const parcel = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-CO2-1', companyId: 'CO-2', kind: 'parcel',
      arrivedAt: '2026-11-26T04:00:00Z', packaging: 'intact',
    });
    assert.equal(parcel.status, 201);
    const crossPickup = await h.call(TOK.front, 'POST', `/mail/${parcel.body.id}/pickup`, { personId: 'PER-B' });
    assert.equal(crossPickup.status, 403);
    assert.equal(crossPickup.body.code, 'no_recipient_auth');

    // 需本人签收的挂号通知，普通代领人不能领取。
    const registered = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-REG-9', companyId: 'CO-1', kind: 'registered', requiresPrincipal: true,
      arrivedAt: '2026-11-26T05:00:00Z', packaging: 'sealed', deadline: '2026-11-28',
    });
    const proxyPickup = await h.call(TOK.front, 'POST', `/mail/${registered.body.id}/pickup`, { personId: 'PER-B' });
    assert.equal(proxyPickup.status, 403);
    assert.equal(proxyPickup.body.code, 'principal_required');

    // 代表本人可以签收。
    const principalPickup = await h.call(TOK.front, 'POST', `/mail/${registered.body.id}/pickup`, { personId: 'PER-A' });
    assert.equal(principalPickup.status, 200);
    assert.equal(principalPickup.body.deliveryBasis, 'representative_signature');

    // 不允许转交的授权，登记转交对象被拒；允许转交时须记录实际领取人。
    const handoverMail = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-HAND-1', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T05:30:00Z', packaging: 'intact',
    });
    const forbidden = await h.call(TOK.front, 'POST', `/mail/${handoverMail.body.id}/pickup`, {
      personId: 'PER-B', handedToPersonId: 'PER-A',
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'handover_forbidden');
    // 本人领取不受影响。
    const ownPickup = await h.call(TOK.front, 'POST', `/mail/${handoverMail.body.id}/pickup`, { personId: 'PER-B' });
    assert.equal(ownPickup.status, 200);
  } finally { await h.stop(); }
});

test('代表权更换后旧授权需重新核实，已合法领取事实保留，未领取件争议暂停交付', async () => {
  const h = await startHarness();
  try {
    await activateSeedRep(h);
    const auth = await h.call(TOK.repA, 'POST', '/recipient-auths', {
      companyId: 'CO-1', personId: 'PER-B', validFrom: '2026-11-01', validUntil: '2026-12-31',
      scopeKinds: ['parcel'], allowHandover: true,
    });
    await h.call(TOK.ops, 'POST', `/recipient-auths/${auth.body.id}/verify`, {});
    // 另一名普通授权领取人 PER-C，用于验证代表权更换后旧授权失效。
    const personC = await h.call(TOK.ops, 'POST', '/persons', { name: '合成人员丙' });
    const authC = await h.call(TOK.repA, 'POST', '/recipient-auths', {
      companyId: 'CO-1', personId: personC.body.id, validFrom: '2026-11-01', validUntil: '2026-12-31',
      scopeKinds: ['parcel'], allowHandover: false,
    });
    await h.call(TOK.ops, 'POST', `/recipient-auths/${authC.body.id}/verify`, {});

    // 先合法领取一件，事实须保留。
    const mail1 = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-KEEP-1', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T06:00:00Z', packaging: 'intact',
    });
    const kept = await h.call(TOK.front, 'POST', `/mail/${mail1.body.id}/pickup`, { personId: 'PER-B' });
    assert.equal(kept.status, 200);

    // 再来一件尚未领取。
    const mail2 = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-HOLD-2', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T07:00:00Z', packaging: 'intact',
    });

    // 新代表 PER-B 的代表权登记并核实，旧代表 PER-A 被替代，旧授权进入 reverify。
    const newRep = await h.call(TOK.ops, 'POST', '/representations', {
      companyId: 'CO-1', personId: 'PER-B', validFrom: '2026-11-26', validUntil: '2027-12-31', basis: '代表变更',
    });
    const newRepOk = await h.call(TOK.ops, 'POST', `/representations/${newRep.body.id}/verify`, {});
    assert.equal(newRepOk.status, 200);
    const authAfter = await h.call(TOK.ops, 'GET', '/recipient-auths?companyId=CO-1');
    assert.equal(authAfter.body.recipientAuths[0].status, 'reverify');

    // 旧授权 reverify 期间，普通授权领取人不能再领取未结件。
    const blockedPickup = await h.call(TOK.front, 'POST', `/mail/${mail2.body.id}/pickup`, { personId: personC.body.id });
    assert.equal(blockedPickup.status, 403);
    assert.equal(blockedPickup.body.code, 'no_recipient_auth');

    // 已领取的件仍是 delivered，事实没有被回滚。
    const keptNow = await h.call(TOK.ops, 'GET', `/mail/${mail1.body.id}`);
    assert.equal(keptNow.body.status, 'delivered');
    assert.equal(keptNow.body.deliveredToPersonId, 'PER-B');

    // 新旧代表对未领取件有争议：企业方提出，交付暂停，普通办公服务不受影响。
    const dispute = await h.call(TOK.ops, 'POST', '/disputes', {
      mailId: mail2.body.id, reason: '新旧代表领取授权异议',
    });
    assert.equal(dispute.status, 201);
    const mail2View = await h.call(TOK.front, 'GET', `/mail/${mail2.body.id}`);
    assert.equal(mail2View.body.blocked, true);
    const pickupWhileDispute = await h.call(TOK.front, 'POST', `/mail/${mail2.body.id}/pickup`, { personId: 'PER-B' });
    assert.equal(pickupWhileDispute.status, 409);
    assert.equal(pickupWhileDispute.body.code, 'delivery_suspended');

    // 争议复核是独立角色：运营无权结案。
    const opsResolve = await h.call(TOK.ops, 'POST', `/disputes/${dispute.body.id}/resolve`, { decision: 'uphold_new' });
    assert.equal(opsResolve.status, 403);
    // 复核员独立记录并结案。
    const resolved = await h.call(TOK.review, 'POST', `/disputes/${dispute.body.id}/resolve`, {
      decision: 'uphold_new', note: '新代表授权成立', evidence: '复核材料 D-1',
    });
    assert.equal(resolved.status, 200);
    const resumed = await h.call(TOK.front, 'GET', `/mail/${mail2.body.id}`);
    assert.equal(resumed.body.blocked, false);
  } finally { await h.stop(); }
});

test('复核员提出的争议不能由本人解除（申请人不能独自核准争议解除）', async () => {
  const h = await startHarness();
  try {
    await activateSeedRep(h);
    const mail = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-DSP-1', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T08:00:00Z', packaging: 'intact',
    });
    const dispute = await h.call(TOK.review, 'POST', '/disputes', {
      mailId: mail.body.id, reason: '复核员依职权登记的争议',
    });
    const selfResolve = await h.call(TOK.review, 'POST', `/disputes/${dispute.body.id}/resolve`, { decision: 'reject' });
    assert.equal(selfResolve.status, 403);
    assert.equal(selfResolve.body.code, 'self_approval_forbidden');
    // 另一名复核员可以独立结案。
    const otherResolve = await h.call(TOK.review2, 'POST', `/disputes/${dispute.body.id}/resolve`, { decision: 'reject', note: '证据不足' });
    assert.equal(otherResolve.status, 200);
    assert.equal(otherResolve.body.status, 'resolved');
  } finally { await h.stop(); }
});

test('钥匙归还确认期间冻结新入场，确认后拒绝该凭证入场', async () => {
  const h = await startHarness();
  try {
    await activateSeedRep(h);
    // 种子钥匙 KEY-1 处于 issued，先登记一次入场应放行。
    const okAttempt = await h.call(TOK.front, 'POST', '/access-attempts', { credentialId: 'KEY-1' });
    assert.equal(okAttempt.status, 200);
    assert.equal(okAttempt.body.allowed, true);

    // 发起归还确认：同一钥匙不应继续允许新入场。
    const begin = await h.call(TOK.front, 'POST', '/credentials/KEY-1/return', {});
    assert.equal(begin.status, 200);
    const attemptDuringReturn = await h.call(TOK.front, 'POST', '/access-attempts', { credentialId: 'KEY-1' });
    assert.equal(attemptDuringReturn.status, 403);
    assert.equal(attemptDuringReturn.body.allowed, false);
    assert.ok(attemptDuringReturn.body.reasons.some(r => r.includes('return_pending')));

    const done = await h.call(TOK.front, 'POST', '/credentials/KEY-1/return-confirm', { condition: 'normal' });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'returned');
    const attemptAfterReturn = await h.call(TOK.front, 'POST', '/access-attempts', { credentialId: 'KEY-1' });
    assert.equal(attemptAfterReturn.status, 403);
    assert.ok(attemptAfterReturn.body.reasons.some(r => r.includes('returned')));
  } finally { await h.stop(); }
});

test('时限将到且无合格接收人时只返回待办，不会自动写成已送达', async () => {
  const h = await startHarness();
  try {
    // 不核实 REP-1：CO-1 没有有效代表。种子 MAIL-1 是 requiresPrincipal 的挂号件。
    const current = await h.call(TOK.ops, 'GET', '/mail/MAIL-1');
    assert.equal(current.body.status, 'pending');
    const pending = await h.call(TOK.front, 'GET', '/mail/pending/deadlines?atDate=2026-11-26');
    assert.equal(pending.status, 200);
    const row = pending.body.pending.find(p => p.mailId === 'MAIL-1');
    assert.ok(row);
    assert.ok(row.pendingActions.some(a => a.includes('有效代表')));
    // 状态仍为 pending，绝不自动 delivered。
    const again = await h.call(TOK.ops, 'GET', '/mail/MAIL-1');
    assert.equal(again.body.status, 'pending');
  } finally { await h.stop(); }
});
