/**
 * Approval decision + audit trail routes.
 * Registered before crudRoutes so /:id/audit is not swallowed.
 */
const db = require('../../database');
const { requireRequestUserId, findOwnedContract, findAccessibleContract } = require('../../services/contractAnalysis/auth');
const { listAuditEvents, writeAuditEvent } = require('../../services/auditService');
const { decideApproval } = require('../../services/approvalEngine');
const { matchPlaybook } = require('../../services/playbook/matcher');
const { listPlaybooks } = require('../../services/playbook/loader');
const { buildStructuredResult } = require('../../services/contractAnalysis/analysisCore');

function safeParse(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = function (router) {
  router.get('/playbooks', async (_req, res) => {
    try {
      res.json({ playbooks: listPlaybooks() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/:id/audit', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    try {
      const contract = await findAccessibleContract(req.params.id, userId);
      if (!contract) return res.status(404).json({ error: 'Contract not found' });
      const events = await listAuditEvents(contract.id);
      res.json({
        contract_id: contract.id,
        decision: contract.decision || null,
        decision_at: contract.decision_at || null,
        playbook_id: contract.playbook_id || null,
        playbook_version: contract.playbook_version || null,
        decision_payload: safeParse(contract.decision_payload, null),
        events,
      });
    } catch (error) {
      console.error('[audit] list failed', error);
      res.status(500).json({ error: 'Failed to load audit trail' });
    }
  });

  router.post('/:id/decision/override', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const decision = String(req.body?.decision || '').toUpperCase();
    if (!['PASS', 'MANUAL', 'REJECT'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be PASS|MANUAL|REJECT' });
    }
    try {
      const contract = await findAccessibleContract(req.params.id, userId);
      if (!contract) return res.status(404).json({ error: 'Contract not found' });

      const previous = safeParse(contract.decision_payload, {});
      const nextPayload = {
        ...previous,
        decision,
        summary: req.body?.reason || `人工改判为 ${decision}`,
        overridden_by: userId,
        previous_decision: contract.decision || previous.decision || null,
      };

      await db('contracts').where({ id: contract.id }).update({
        decision,
        decision_at: new Date(),
        decision_payload: JSON.stringify(nextPayload),
      });

      await writeAuditEvent({
        contractId: contract.id,
        eventType: 'APPROVAL_OVERRIDDEN',
        actor: String(userId),
        playbookId: contract.playbook_id,
        decision,
        ruleIds: nextPayload.matched_rule_ids || [],
        payload: nextPayload,
      });

      res.json({ ok: true, decision, decision_payload: nextPayload });
    } catch (error) {
      console.error('[decision] override failed', error);
      res.status(500).json({ error: 'Failed to override decision' });
    }
  });

  // Recompute decision from stored analysis (dev/test helper)
  router.post('/:id/decision/recompute', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    try {
      const contract = await findAccessibleContract(req.params.id, userId);
      if (!contract) return res.status(404).json({ error: 'Contract not found' });
      const analysis = safeParse(contract.analysis_result, {});
      const pre = safeParse(contract.pre_analysis_data, {});
      const playbook = matchPlaybook(pre.contract_type || analysis.playbook?.contract_type || '');
      const structured = analysis.structured_result
        || buildStructuredResult(analysis, analysis.hard_violations || []);
      const approval = decideApproval({
        playbook,
        structuredResult: structured,
        contractProfile: req.body?.contractProfile || {},
      });
      analysis.approval = approval;
      analysis.structured_result = structured;
      await db('contracts').where({ id: contract.id }).update({
        analysis_result: JSON.stringify(analysis),
        decision: approval.decision,
        decision_at: new Date(),
        decision_payload: JSON.stringify(approval),
        playbook_id: approval.playbook_id,
        playbook_version: approval.playbook_version,
      });
      await writeAuditEvent({
        contractId: contract.id,
        eventType: 'APPROVAL_DECIDED',
        actor: 'recompute',
        playbookId: approval.playbook_id,
        decision: approval.decision,
        ruleIds: approval.matched_rule_ids?.length ? approval.matched_rule_ids : approval.passed_rule_ids,
        payload: approval,
      });
      res.json({ approval });
    } catch (error) {
      console.error('[decision] recompute failed', error);
      res.status(500).json({ error: error.message });
    }
  });
};
