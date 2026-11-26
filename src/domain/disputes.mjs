import { HttpError, mailEvent, requireFields } from '../http-util.mjs';
import { nextId } from '../store.mjs';

// 争议复核是独立记录：只有争议复核角色可以结案，申请人不能自行解除。
export function openDispute(state, body, actor, now) {
  requireFields(body, ['mailId', 'reason']);
  const mail = state.mail.find(m => m.id === body.mailId);
  if (!mail) throw new HttpError(404, 'not_found', '来件不存在');
  if (mail.status === 'delivered') {
    throw new HttpError(409, 'state_conflict', '已合法领取的事实保留；争议应针对尚未领取的件或登记复核意见');
  }
  const dispute = {
    id: nextId(state, 'DSP'),
    mailId: mail.id,
    companyId: mail.companyId,
    status: 'open',
    reason: String(body.reason).slice(0, 300),
    submittedBy: actor.id,
    submittedByPersonId: actor.personId ?? null,
    openedAt: now,
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    timeline: [{ at: now, type: 'opened', by: actor.id, note: body.reason }],
  };
  state.disputes.push(dispute);
  mail.disputeIds.push(dispute.id);
  mail.blocked = true;
  mailEvent(state, mail, now, 'delivery_suspended', '新旧代表对未领取件存在争议，相关交付暂停', { disputeId: dispute.id });
  return dispute;
}

export function resolveDispute(state, disputeId, body, actor, now) {
  const dispute = state.disputes.find(d => d.id === disputeId);
  if (!dispute) throw new HttpError(404, 'not_found', '争议不存在');
  if (dispute.status !== 'open') throw new HttpError(409, 'state_conflict', '争议已结案');
  if (!['uphold_new', 'uphold_old', 'reject'].includes(body.decision)) {
    throw new HttpError(400, 'bad_decision', 'decision 必须是 uphold_new / uphold_old / reject');
  }
  // 争议解除不能由提出人自行核准（按自然人判断；机构账号提出时按 actor 判断）。
  if (dispute.submittedBy === actor.id || (actor.personId && dispute.submittedByPersonId === actor.personId)) {
    throw new HttpError(403, 'self_approval_forbidden', '争议提出人不能自行解除争议');
  }
  dispute.status = 'resolved';
  dispute.resolution = {
    decision: body.decision,
    note: String(body.note ?? '').slice(0, 300),
    evidence: String(body.evidence ?? '').slice(0, 200),
  };
  dispute.resolvedBy = actor.id;
  dispute.resolvedAt = now;
  dispute.timeline.push({ at: now, type: 'resolved', by: actor.id, note: body.decision });

  const mail = state.mail.find(m => m.id === dispute.mailId);
  const stillOpen = state.disputes.some(d => d.mailId === mail.id && d.status === 'open');
  if (!stillOpen) {
    mail.blocked = false;
    mailEvent(state, mail, now, 'delivery_resumed', `争议复核结论：${body.decision}，交付恢复`, { disputeId: dispute.id });
  } else {
    mailEvent(state, mail, now, 'dispute_partial_resolved', '仍有其他未结争议，交付继续暂停', { disputeId: dispute.id });
  }
  return dispute;
}
