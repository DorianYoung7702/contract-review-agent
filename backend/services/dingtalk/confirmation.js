/**
 * Human confirmation after AI approval decision.
 */
const db = require('../../database');
const { writeAuditEvent } = require('../auditService');
const { parseSourceMeta, notifyDingTalkUser, buildAwaitConfirmMessage } = require('./notify');

async function markAwaitingHumanConfirm(contractId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) return null;

  const meta = parseSourceMeta(contract.source_meta);
  let decisionPayload = {};
  try {
    decisionPayload = typeof contract.decision_payload === 'string'
      ? JSON.parse(contract.decision_payload || '{}')
      : (contract.decision_payload || {});
  } catch { /* ignore */ }

  await db('contracts').where({ id: contractId }).update({
    confirmation_status: 'pending',
  });

  const message = buildAwaitConfirmMessage({
    contractId: contract.id,
    filename: contract.original_filename,
    decision: contract.decision || decisionPayload.decision,
    riskScore: decisionPayload.risk_score,
    reasonCodes: decisionPayload.reason_codes,
  });

  let notifyResult = { channel: 'skipped' };
  try {
    notifyResult = await notifyDingTalkUser({
      sessionWebhook: meta.session_webhook,
      staffId: meta.staff_id,
      content: message,
    });
  } catch (err) {
    console.error('[DingTalk] await-confirm notify failed:', err.message);
    notifyResult = { channel: 'error', error: err.message };
  }

  await writeAuditEvent({
    contractId: contract.id,
    eventType: 'HUMAN_CONFIRM_REQUESTED',
    actor: 'dingtalk_notify',
    playbookId: contract.playbook_id,
    decision: contract.decision,
    ruleIds: decisionPayload.matched_rule_ids || [],
    payload: {
      notify: notifyResult,
      message_preview: message.slice(0, 500),
    },
  });

  return { confirmation_status: 'pending', notify: notifyResult, message };
}

async function applyHumanConfirmation({
  contractId,
  action,
  actor,
  reason = '',
}) {
  const normalized = String(action || '').toLowerCase();
  if (!['confirm', 'reject'].includes(normalized)) {
    const err = new Error('action must be confirm|reject');
    err.status = 400;
    throw err;
  }

  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) {
    const err = new Error('Contract not found');
    err.status = 404;
    throw err;
  }

  if (contract.confirmation_status === 'confirmed' || contract.confirmation_status === 'rejected') {
    return {
      ok: true,
      idempotent: true,
      confirmation_status: contract.confirmation_status,
      decision: contract.decision,
    };
  }

  if (contract.confirmation_status !== 'pending') {
    const err = new Error('Contract is not awaiting human confirmation');
    err.status = 409;
    throw err;
  }

  const nextStatus = normalized === 'confirm' ? 'confirmed' : 'rejected';
  const meta = parseSourceMeta(contract.source_meta);
  meta.human_action = {
    action: normalized,
    actor: String(actor || ''),
    reason: String(reason || ''),
    at: new Date().toISOString(),
  };

  await db('contracts').where({ id: contractId }).update({
    confirmation_status: nextStatus,
    confirmed_at: new Date(),
    confirmed_by: String(actor || ''),
    source_meta: JSON.stringify(meta),
  });

  await writeAuditEvent({
    contractId: contract.id,
    eventType: nextStatus === 'confirmed' ? 'HUMAN_CONFIRMED' : 'HUMAN_CONFIRM_REJECTED',
    actor: String(actor || 'human'),
    playbookId: contract.playbook_id,
    decision: contract.decision,
    payload: {
      action: normalized,
      reason,
      ai_decision: contract.decision,
    },
  });

  // Best-effort ack to DingTalk
  try {
    const ack = nextStatus === 'confirmed'
      ? `【合同审查】#${contract.id} 已确认（AI 决策 ${contract.decision || '—'} 保留）。`
      : `【合同审查】#${contract.id} 已驳回确认。原因：${reason || '未填写'}`;
    await notifyDingTalkUser({
      sessionWebhook: meta.session_webhook,
      staffId: meta.staff_id,
      content: ack,
    });
  } catch (err) {
    console.warn('[DingTalk] confirm ack notify failed:', err.message);
  }

  return {
    ok: true,
    idempotent: false,
    confirmation_status: nextStatus,
    decision: contract.decision,
  };
}

module.exports = {
  markAwaitingHumanConfirm,
  applyHumanConfirmation,
};
