import { HttpError, requireFields } from '../http-util.mjs';
import { nextId } from '../store.mjs';
import { summarizeDeposit } from './tenancy.mjs';

function findCompanyDeposit(state, companyId) {
  const deposit = state.deposits.find(d => d.companyId === companyId);
  if (!deposit) throw new HttpError(404, 'not_found', '该企业没有押金账户');
  return deposit;
}

// 已确认费用逐项登记，不允许笼统扣款。
export function addFee(state, body, actor, now) {
  requireFields(body, ['companyId', 'amountMinor', 'reason']);
  if (!Number.isInteger(body.amountMinor) || body.amountMinor <= 0) {
    throw new HttpError(400, 'bad_amount', '金额必须是正整数（分）');
  }
  const deposit = findCompanyDeposit(state, body.companyId);
  const summary = summarizeDeposit(deposit);
  if (body.amountMinor > summary.refundableMinor + summary.heldMinor) {
    throw new HttpError(409, 'insufficient_deposit', '费用超过押金可用余额');
  }
  const fee = {
    id: nextId(state, 'FEE'),
    amountMinor: body.amountMinor,
    reason: String(body.reason).slice(0, 200),
    at: now,
    confirmedBy: actor.id,
    ref: body.ref ? String(body.ref).slice(0, 100) : null,
  };
  deposit.fees.push(fee);
  return { fee, summary: summarizeDeposit(deposit) };
}

// 争议暂扣只冻结争议相关范围，不能扣住无关余额。
export function addHold(state, body, actor, now) {
  requireFields(body, ['companyId', 'amountMinor', 'disputeId']);
  if (!Number.isInteger(body.amountMinor) || body.amountMinor <= 0) {
    throw new HttpError(400, 'bad_amount', '金额必须是正整数（分）');
  }
  const dispute = state.disputes.find(d => d.id === body.disputeId);
  if (!dispute) throw new HttpError(404, 'not_found', '关联争议不存在');
  const deposit = findCompanyDeposit(state, body.companyId);
  const summary = summarizeDeposit(deposit);
  if (body.amountMinor > summary.refundableMinor) {
    throw new HttpError(409, 'insufficient_deposit', '暂扣金额超过可退余额');
  }
  const hold = {
    id: nextId(state, 'HOLD'),
    amountMinor: body.amountMinor,
    disputeId: body.disputeId,
    reason: String(body.reason ?? '争议暂扣').slice(0, 200),
    status: 'held',
    at: now,
    placedBy: actor.id,
    releasedAt: null,
  };
  deposit.holds.push(hold);
  return { hold, summary: summarizeDeposit(deposit) };
}

export function releaseHold(state, holdId, body, actor, now) {
  for (const deposit of state.deposits) {
    const hold = deposit.holds.find(h => h.id === holdId);
    if (!hold) continue;
    if (hold.status !== 'held') throw new HttpError(409, 'state_conflict', '暂扣已处理');
    if (body?.forfeit === true) {
      hold.status = 'forfeited';
      hold.forfeitedAt = now;
      hold.resolvedBy = actor.id;
    } else {
      hold.status = 'released';
      hold.releasedAt = now;
      hold.resolvedBy = actor.id;
    }
    return { hold, summary: summarizeDeposit(deposit) };
  }
  throw new HttpError(404, 'not_found', '暂扣记录不存在');
}

// 退押金：受钥匙设备归还、已确认费用和争议暂扣范围约束；只退自由余额。
// 退押金不会清空未完成的转寄责任。
export function refundDeposit(state, body, actor, now) {
  requireFields(body, ['companyId', 'amountMinor']);
  if (!Number.isInteger(body.amountMinor) || body.amountMinor <= 0) {
    throw new HttpError(400, 'bad_amount', '退款金额必须是正整数（分）');
  }
  const deposit = findCompanyDeposit(state, body.companyId);
  const summary = summarizeDeposit(deposit);
  if (body.amountMinor > summary.refundableMinor) {
    throw new HttpError(409, 'refund_exceeds_free_balance', '退款金额超过扣除费用与争议暂扣后的自由余额', { summary });
  }
  const unreturned = state.credentials.filter(c => c.companyId === body.companyId && ['issued', 'return_pending'].includes(c.status));
  if (unreturned.length) {
    throw new HttpError(409, 'assets_unreturned', '仍有钥匙/设备未完成归还确认，不能退款', { credentials: unreturned.map(c => c.id) });
  }
  const refund = {
    id: nextId(state, 'RFD'),
    amountMinor: body.amountMinor,
    at: now,
    by: actor.id,
    note: String(body.note ?? '').slice(0, 200),
    forwardingObligationsRetained: state.forwardings.some(f => f.companyId === body.companyId && !['completed', 'cancelled'].includes(f.status)),
  };
  deposit.refunds.push(refund);
  const after = summarizeDeposit(deposit);
  if (after.refundableMinor === 0 && after.heldMinor === 0) deposit.status = 'settled';
  return { refund, summary: after };
}

export function depositSummary(state, companyId) {
  const deposit = findCompanyDeposit(state, companyId);
  return {
    ...summarizeDeposit(deposit),
    status: deposit.status,
    fees: deposit.fees,
    holds: deposit.holds,
    refunds: deposit.refunds,
    // 即便押金结清，未完成转寄仍单独列出，责任不随退款清空。
    openForwardingIds: state.forwardings
      .filter(f => f.companyId === companyId && !['completed', 'cancelled'].includes(f.status))
      .map(f => f.id),
  };
}
