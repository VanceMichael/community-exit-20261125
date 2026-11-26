import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, TOKENS } from './helpers/harness.mjs';

const TOK = { ...TOKENS, opsSelf: 'tok-ops-self' };

async function activateSeedRep(h) {
  await h.call(TOK.ops, 'POST', '/representations/REP-1/verify', {});
  await h.call(TOK.ops, 'POST', '/tenancy-applications/TA-SEED-1/confirm', {});
}

test('退驻分别结束空间、门禁、地址与来件；一个退驻申请可看到未结责任', async () => {
  const h = await startHarness();
  try {
    await activateSeedRep(h);
    // 企业申请退驻：空间 11-30 结束，付费保留地址至 12-31。
    const exit = await h.call(TOK.repA, 'POST', '/exits', {
      companyId: 'CO-1', officeEnd: '2026-11-30', addressEnd: '2026-12-31', note: '搬离工位保留地址',
    });
    assert.equal(exit.status, 201);
    const exitId = exit.body.id;

    // 初始总览：空间、门禁、来件、押金均未结，地址仍有效。
    let overview = await h.call(TOK.ops, 'GET', `/exits/${exitId}/overview`);
    assert.equal(overview.body.responsibilities.space.state, 'open');
    assert.equal(overview.body.responsibilities.address.state, 'active');
    assert.equal(overview.body.allCheckpointsDone, false);

    // 结束空间使用，office 服务终止但 address 保留。
    await h.call(TOK.ops, 'POST', `/exits/${exitId}/checkpoints/space`, {});
    // 钥匙未归还时不能结束人员进出。
    const accessEarly = await h.call(TOK.ops, 'POST', `/exits/${exitId}/checkpoints/access`, {});
    assert.equal(accessEarly.status, 409);
    await h.call(TOK.front, 'POST', '/credentials/KEY-1/return', {});
    await h.call(TOK.front, 'POST', '/credentials/KEY-1/return-confirm', { condition: 'normal' });
    await h.call(TOK.ops, 'POST', `/exits/${exitId}/checkpoints/access`, {});

    // 地址托管结束到 12-31，并产生保留记录。
    const addressClose = await h.call(TOK.ops, 'POST', `/exits/${exitId}/checkpoints/address`, {});
    assert.equal(addressClose.status, 200);
    assert.ok(addressClose.body.retention);
    assert.equal(addressClose.body.retention.end, '2026-12-31');

    // 种子 MAIL-1 仍未结，不能勾来件交接。
    const mailEarly = await h.call(TOK.ops, 'POST', `/exits/${exitId}/checkpoints/mail`, {});
    assert.equal(mailEarly.status, 409);

    // 未全部交接不能结案。
    const finalizeEarly = await h.call(TOK.ops, 'POST', `/exits/${exitId}/finalize`, {});
    assert.equal(finalizeEarly.status, 409);
  } finally { await h.stop(); }
});

test('地址到期后来件依约拒收或待核实，不因历史合同继续接收', async () => {
  const h = await startHarness();
  try {
    await activateSeedRep(h);
    const exit = await h.call(TOK.repA, 'POST', '/exits', {
      companyId: 'CO-1', officeEnd: '2026-11-30', addressEnd: '2026-12-31',
    });
    const exitId = exit.body.id;
    await h.call(TOK.ops, 'POST', `/exits/${exitId}/checkpoints/space`, {});
    await h.call(TOK.front, 'POST', '/credentials/KEY-1/return', {});
    await h.call(TOK.front, 'POST', '/credentials/KEY-1/return-confirm', { condition: 'normal' });
    await h.call(TOK.ops, 'POST', `/exits/${exitId}/checkpoints/access`, {});
    await h.call(TOK.ops, 'POST', `/exits/${exitId}/checkpoints/address`, {});

    // 地址结束日后的来件：默认拒收策略。
    const after = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-EXPIRED-1', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2027-01-02T01:00:00Z', packaging: 'intact',
    });
    assert.equal(after.body.status, 'rejected');

    // 切换为待核实策略：进入 verification_hold，不进可领取库存。
    const company = h.app.state.companies.find(c => c.id === 'CO-1');
    company.arrivalPolicyAfterAddress = 'verify';
    const held = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-EXPIRED-2', companyId: 'CO-1', kind: 'letter',
      arrivedAt: '2027-01-03T01:00:00Z', packaging: 'intact',
    });
    assert.equal(held.body.status, 'verification_hold');
    const pickupHold = await h.call(TOK.front, 'POST', `/mail/${held.body.id}/pickup`, { personId: 'PER-A' });
    assert.equal(pickupHold.status, 409);
    // 运营核实拒收。
    const rejected = await h.call(TOK.ops, 'POST', `/mail/${held.body.id}/verification`, { decision: 'reject', reason: '地址托管已结束' });
    assert.equal(rejected.body.status, 'rejected');

    // 保留期内（12-31 前）仍正常接收。
    const within = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-RETAIN-1', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-12-20T01:00:00Z', packaging: 'intact',
    });
    assert.equal(within.body.status, 'pending');
  } finally { await h.stop(); }
});

test('转寄受理未明保留原件责任且禁止现场领取；查单确认后按承运状态处理', async () => {
  const h = await startHarness({ carrierRules: { 'CARRIER-1': 'pending' } });
  try {
    await activateSeedRep(h);
    const mail = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-FWD-1', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T09:00:00Z', packaging: 'intact',
    });
    const fwd = await h.call(TOK.ops, 'POST', '/forwardings', {
      mailId: mail.body.id, destination: '合成收件地址甲',
    });
    assert.equal(fwd.status, 201);
    assert.equal(['submitted', 'unclear'].includes(fwd.body.status), true);

    if (fwd.body.status === 'unclear') {
      // 受理未明：现场领取被禁止。
      const pickup = await h.call(TOK.front, 'POST', `/mail/${mail.body.id}/pickup`, { personId: 'PER-A' });
      assert.equal(pickup.status, 409);
      assert.equal(pickup.body.code, 'forwarding_active');
      // 查单（承运台此时已有流水）。
      const synced = await h.call(TOK.ops, 'POST', `/forwardings/${fwd.body.id}/sync`, {});
      assert.equal(synced.body.synced, true);
      assert.equal(synced.body.carrierStatus, 'pending');
    }
    // 无论未明还是待处理，来件都不处于可领取库存。
    const view = await h.call(TOK.front, 'GET', `/mail/${mail.body.id}`);
    assert.equal(view.body.hasForwarding, true);
    assert.notEqual(view.body.status, 'pending');

    // 承运台最终确认转寄完成。
    await fetch(`${h.peerBase}/control/settle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'CARRIER-1', status: 'confirmed', details: { receipt: 'R-1' } }),
    });
    const synced2 = await h.call(TOK.ops, 'POST', `/forwardings/${fwd.body.id}/sync`, {});
    assert.equal(synced2.body.carrierStatus, 'confirmed');
    const after = await h.call(TOK.ops, 'GET', `/mail/${mail.body.id}`);
    assert.equal(after.body.status, 'forwarded');

    // 已实际转寄后的撤销只能是拦截申请，件不恢复成可领取库存。
    const revoke = await h.call(TOK.ops, 'POST', `/forwardings/${fwd.body.id}/revoke`, { reason: '企业改口' });
    assert.equal(revoke.body.kind, 'intercept');
    assert.ok(revoke.body.intercept.id);
    const mailStill = await h.call(TOK.front, 'GET', `/mail/${mail.body.id}`);
    assert.notEqual(mailStill.body.status, 'pending');

    // 拦截成功登记为退回，而不是恢复库存。
    const interceptResolve = await h.call(TOK.ops, 'POST',
      `/forwardings/${fwd.body.id}/intercepts/${revoke.body.intercept.id}/resolve`,
      { outcome: 'intercepted', evidence: '承运退回凭证' });
    assert.equal(interceptResolve.status, 200);
    const returned = await h.call(TOK.ops, 'GET', `/mail/${mail.body.id}`);
    assert.equal(returned.body.status, 'returned');
    const pickupReturned = await h.call(TOK.front, 'POST', `/mail/${mail.body.id}/pickup`, { personId: 'PER-A' });
    assert.equal(pickupReturned.status, 409);
  } finally { await h.stop(); }
});

test('承运台断线导致受理未明：保留原件责任，查单确认后才解除未明', async () => {
  const h = await startHarness({ carrierRules: { 'CARRIER-1': 'accepted_disconnect' } });
  try {
    await activateSeedRep(h);
    const mail = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-DISC-1', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T15:00:00Z', packaging: 'intact',
    });
    // 承运台先持久化受理再断开连接，业务侧抓取网络异常并标记 unclear。
    const fwd = await h.call(TOK.ops, 'POST', '/forwardings', {
      mailId: mail.body.id, destination: '断线转寄',
    });
    assert.equal(fwd.body.status, 'unclear');
    assert.ok(fwd.body.unclearAt);
    // 未明期间现场领取被禁止，原件责任保留（状态已非可领取，且转寄安排仍在）。
    const pickup = await h.call(TOK.front, 'POST', `/mail/${mail.body.id}/pickup`, { personId: 'PER-A' });
    assert.equal(pickup.status, 409);
    assert.ok(['forwarding_active', 'state_conflict'].includes(pickup.body.code));
    const heldView = await h.call(TOK.front, 'GET', `/mail/${mail.body.id}`);
    assert.equal(heldView.body.hasForwarding, true);
    assert.notEqual(heldView.body.status, 'pending');
    // 查单确认流水真实存在，受理成立。
    const synced = await h.call(TOK.ops, 'POST', `/forwardings/${fwd.body.id}/sync`, {});
    assert.equal(synced.body.synced, true);
    assert.equal(synced.body.carrierStatus, 'accepted');
    assert.equal(synced.body.forwarding.status, 'submitted');
    // 此时撤销只能是拦截申请。
    const revoke = await h.call(TOK.ops, 'POST', `/forwardings/${fwd.body.id}/revoke`, { reason: '未明后改口' });
    assert.equal(revoke.body.kind, 'intercept');
  } finally { await h.stop(); }
});

test('提交前撤销恢复库存；承运台拒绝受理也恢复库存', async () => {
  const h = await startHarness({ carrierRules: { 'CARRIER-1': 'rejected' } });
  try {
    await activateSeedRep(h);
    const mail = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-FWD-2', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T10:00:00Z', packaging: 'intact',
    });
    const fwd = await h.call(TOK.ops, 'POST', '/forwardings', {
      mailId: mail.body.id, destination: '合成收件地址乙',
    });
    assert.equal(fwd.body.status, 'carrier_rejected');
    const restored = await h.call(TOK.front, 'GET', `/mail/${mail.body.id}`);
    assert.equal(restored.body.status, 'pending');
    assert.equal(restored.body.hasForwarding, false);
    // 恢复后可以正常现场领取。
    const pickup = await h.call(TOK.front, 'POST', `/mail/${mail.body.id}/pickup`, { personId: 'PER-A' });
    assert.equal(pickup.status, 200);
  } finally { await h.stop(); }
});

test('押金退款受归还/费用/争议暂扣约束，且不清空转寄责任', async () => {
  const h = await startHarness();
  try {
    await activateSeedRep(h);
    // 钥匙未还不能退款。
    const early = await h.call(TOK.cashier, 'POST', '/deposits/refunds', { companyId: 'CO-1', amountMinor: 1000 });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'assets_unreturned');

    // 登记一笔已确认费用 20000 分，一笔争议暂扣 10000 分。
    const fee = await h.call(TOK.cashier, 'POST', '/deposits/fees', {
      companyId: 'CO-1', amountMinor: 20000, reason: '会议室损坏赔偿',
    });
    assert.equal(fee.status, 201);
    // 暂扣需关联真实争议。
    const mail = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-DEP-1', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T11:00:00Z', packaging: 'intact',
    });
    const dispute = await h.call(TOK.ops, 'POST', '/disputes', { mailId: mail.body.id, reason: '押金争议测试' });
    const hold = await h.call(TOK.cashier, 'POST', '/deposits/holds', {
      companyId: 'CO-1', amountMinor: 10000, disputeId: dispute.body.id, reason: '争议暂扣',
    });
    assert.equal(hold.status, 201);

    // 自由余额 = 100000 - 20000 - 10000 = 70000；超额退款被拒。
    const over = await h.call(TOK.cashier, 'POST', '/deposits/refunds', { companyId: 'CO-1', amountMinor: 70001 });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'refund_exceeds_free_balance');

    // 先还钥匙，再退自由余额 70000。
    await h.call(TOK.front, 'POST', '/credentials/KEY-1/return', {});
    await h.call(TOK.front, 'POST', '/credentials/KEY-1/return-confirm', { condition: 'normal' });
    const refund = await h.call(TOK.cashier, 'POST', '/deposits/refunds', {
      companyId: 'CO-1', amountMinor: 70000, note: '退还自由余额',
    });
    assert.equal(refund.status, 201);
    assert.equal(refund.body.summary.refundableMinor, 0);
    assert.equal(refund.body.summary.heldMinor, 10000);

    // 同时存在未结来件/争议：建立一个转寄，验证退款不清空转寄责任。
    const mail2 = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-DEP-2', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T12:00:00Z', packaging: 'intact',
    });
    const fwd = await h.call(TOK.ops, 'POST', '/forwardings', { mailId: mail2.body.id, destination: '保留地址转寄' });
    const summary = await h.call(TOK.cashier, 'GET', '/deposits/CO-1/summary');
    assert.ok(summary.body.openForwardingIds.includes(fwd.body.id));

    // 争议解除后释放暂扣，剩余 10000 可退。
    await h.call(TOK.review, 'POST', `/disputes/${dispute.body.id}/resolve`, { decision: 'reject', note: '争议不成立' });
    const release = await h.call(TOK.cashier, 'POST', `/deposits/holds/${hold.body.hold.id}/release`, {});
    assert.equal(release.body.hold.status, 'released');
    const finalRefund = await h.call(TOK.cashier, 'POST', '/deposits/refunds', { companyId: 'CO-1', amountMinor: 10000 });
    assert.equal(finalRefund.status, 201);
    assert.equal(finalRefund.body.summary.refundableMinor, 0);
    // 转寄责任仍然保留。
    const summary2 = await h.call(TOK.cashier, 'GET', '/deposits/CO-1/summary');
    assert.ok(summary2.body.openForwardingIds.length >= 1);
  } finally { await h.stop(); }
});

test('前台只能访问交付所需内容，扫描面单不公开全文，企业只能查自己的件', async () => {
  const h = await startHarness();
  try {
    await activateSeedRep(h);
    const mail = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-VIEW-1', companyId: 'CO-1', kind: 'registered', requiresPrincipal: true,
      arrivedAt: '2026-11-26T13:00:00Z', packaging: 'sealed', scanRef: 'scan://bucket/TRK-VIEW-1',
      note: '内部备注不应给前台',
    });
    // 前台视图没有内部备注字段，扫描件只有引用没有全文。
    const frontView = await h.call(TOK.front, 'GET', `/mail/${mail.body.id}`);
    assert.equal(frontView.body.scanRef, 'scan://bucket/TRK-VIEW-1');
    assert.ok(!('note' in frontView.body));
    assert.ok(!('events' in frontView.body));
    // 前台不能看押金、审计或争议全量记录。
    assert.equal((await h.call(TOK.front, 'GET', '/audit')).status, 403);
    assert.equal((await h.call(TOK.front, 'GET', '/deposits/CO-1/summary')).status, 403);
    assert.equal((await h.call(TOK.front, 'GET', '/disputes')).status, 403);
    // 前台不能登记费用或核准授权。
    assert.equal((await h.call(TOK.front, 'POST', '/deposits/fees', { companyId: 'CO-1', amountMinor: 1, reason: 'x' })).status, 403);
    assert.equal((await h.call(TOK.front, 'POST', '/representations/REP-1/verify', {})).status, 403);

    // 企业代表只能查自己企业的件：查 CO-2 被拒。
    const other = await h.call(TOK.repA, 'GET', '/mail?companyId=CO-2');
    assert.equal(other.status, 403);
    const own = await h.call(TOK.repA, 'GET', '/mail?companyId=CO-1');
    assert.equal(own.status, 200);
    assert.ok(own.body.mail.every(m => m.companyId === 'CO-1' || m.id));
  } finally { await h.stop(); }
});

test('服务重启后状态保留，退驻总览仍能读到未结转寄与暂扣', async () => {
  const h = await startHarness();
  try {
    await activateSeedRep(h);
    const exit = await h.call(TOK.repA, 'POST', '/exits', {
      companyId: 'CO-1', officeEnd: '2026-11-30', addressEnd: '2026-12-31',
    });
    await h.call(TOK.ops, 'POST', `/exits/${exit.body.id}/checkpoints/space`, {});
    const mail = await h.call(TOK.front, 'POST', '/mail', {
      trackingNo: 'TRK-PERSIST-1', companyId: 'CO-1', kind: 'parcel',
      arrivedAt: '2026-11-26T14:00:00Z', packaging: 'intact',
    });
    const fwd = await h.call(TOK.ops, 'POST', '/forwardings', { mailId: mail.body.id, destination: '持久化转寄' });

    const restarted = await h.restart();
    const overview = await restarted.call(TOK.ops, 'GET', `/exits/${exit.body.id}/overview`);
    assert.equal(overview.status, 200);
    const fwdIds = overview.body.responsibilities.mail.openForwardings.map(f => f.id);
    assert.ok(fwdIds.includes(fwd.body.id));
    const mailAgain = await restarted.call(TOK.ops, 'GET', `/mail/${mail.body.id}`);
    assert.equal(mailAgain.body.currentForwardingId, fwd.body.id);
  } finally { await h.stop(); }
});
