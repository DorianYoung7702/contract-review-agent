const db = require('../database');

async function writeAuditEvent({
  contractId,
  eventType,
  actor = 'system',
  playbookId = null,
  decision = null,
  ruleIds = [],
  payload = {},
}) {
  const row = {
    contract_id: contractId,
    event_type: eventType,
    actor,
    playbook_id: playbookId,
    decision,
    rule_ids: JSON.stringify(ruleIds || []),
    payload: JSON.stringify(payload || {}),
    created_at: new Date(),
  };
  const [id] = await db('review_audit_events').insert(row).returning('id');
  return typeof id === 'object' ? id.id : id;
}

async function listAuditEvents(contractId) {
  const rows = await db('review_audit_events')
    .where({ contract_id: contractId })
    .orderBy('created_at', 'desc');
  return rows.map((row) => ({
    ...row,
    rule_ids: safeJson(row.rule_ids, []),
    payload: safeJson(row.payload, {}),
  }));
}

function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = {
  writeAuditEvent,
  listAuditEvents,
};
