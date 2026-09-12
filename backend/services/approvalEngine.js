/**
 * Deterministic Approval Engine.
 * LLM findings are facts; this module decides PASS / MANUAL / REJECT.
 */

function normalizeSeverity(value) {
  const text = String(value || '').toLowerCase();
  if (['high', '高', '高危', '严重'].includes(text)) return 'HIGH';
  if (['medium', '中', '中危', '中等'].includes(text)) return 'MEDIUM';
  if (['low', '低', '低危'].includes(text)) return 'LOW';
  if (['high', 'medium', 'low'].includes(String(value || '').toUpperCase().toLowerCase())) {
    return String(value).toUpperCase();
  }
  const upper = String(value || '').toUpperCase();
  if (['HIGH', 'MEDIUM', 'LOW'].includes(upper)) return upper;
  return 'MEDIUM';
}

function collectFindings(structuredResult = {}) {
  const findings = [];
  const push = (item, source) => {
    if (!item || typeof item !== 'object') return;
    findings.push({
      source,
      rule_id: item.rule_id || item.ruleId || null,
      title: item.title || item.description || item.name || '',
      severity: normalizeSeverity(item.severity || item.risk_level || item.risk),
      reason: item.reason || item.dispute_rationale || item.description || '',
      current_value: item.current_value || item.contract_value || null,
      standard_value: item.standard_value || item.limit_value || null,
      suggestion: item.suggestion || item.suggested_text || item.suggested_clause || item.fix_template || '',
      missing: source === 'missing_clauses' || Boolean(item.missing),
      forbidden: Boolean(item.forbidden),
      auto_decision: item.auto_decision ? String(item.auto_decision).toUpperCase() : null,
    });
  };

  (structuredResult.dispute_points || []).forEach((x) => push(x, 'dispute_points'));
  (structuredResult.modification_suggestions || []).forEach((x) => push(x, 'modification_suggestions'));
  (structuredResult.missing_clauses || []).forEach((x) => push({ ...x, missing: true, severity: x.severity || 'HIGH' }, 'missing_clauses'));
  (structuredResult.hard_violations || []).forEach((x) => push({
    ...x,
    title: x.description || x.title,
    severity: x.severity || 'HIGH',
    rule_id: x.rule_id,
  }, 'hard_violations'));
  (structuredResult.findings || []).forEach((x) => push(x, 'findings'));
  return findings;
}

function ruleIndex(playbook) {
  const map = new Map();
  for (const rule of playbook?.rules || []) {
    map.set(rule.id, rule);
  }
  return map;
}

function computeRiskScore(findings) {
  let score = 0;
  for (const f of findings) {
    if (f.severity === 'HIGH') score += 25;
    else if (f.severity === 'MEDIUM') score += 10;
    else score += 3;
  }
  return Math.max(0, Math.min(100, score));
}

/**
 * @param {object} input
 * @param {object} input.playbook
 * @param {object} input.structuredResult
 * @param {object} [input.contractProfile]
 */
function decideApproval({ playbook, structuredResult = {}, contractProfile = {} } = {}) {
  const findings = collectFindings(structuredResult);
  const rules = ruleIndex(playbook);
  const matchedRuleIds = [];
  const reasonCodes = [];
  const passedRuleIds = [];

  const requiredRules = (playbook?.rules || []).filter((r) => r.required);

  // Enrich findings with playbook meta when rule_id known
  for (const finding of findings) {
    const rule = finding.rule_id ? rules.get(finding.rule_id) : null;
    if (rule) {
      finding.forbidden = finding.forbidden || Boolean(rule.forbidden);
      finding.auto_decision = finding.auto_decision || rule.auto_decision;
      if (finding.severity !== 'HIGH' && rule.severity) {
        // keep explicit HIGH from LLM/hard rules; otherwise inherit playbook severity
        if (!finding.severity || finding.severity === 'LOW') {
          finding.severity = normalizeSeverity(rule.severity);
        }
      }
    }
  }

  // Required rules: only escalate when explicitly reported missing
  for (const rule of requiredRules) {
    const missingHit = findings.some(
      (f) => f.missing && (f.rule_id === rule.id || String(f.title || '').includes(rule.name)),
    );
    if (missingHit) {
      matchedRuleIds.push(rule.id);
      reasonCodes.push(`MISSING_${rule.id}`);
    } else {
      passedRuleIds.push(rule.id);
    }
  }

  for (const finding of findings) {
    if (finding.rule_id) matchedRuleIds.push(finding.rule_id);
  }

  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const matched = uniq(matchedRuleIds);
  const passed = uniq(passedRuleIds).filter((id) => !matched.includes(id));

  // 1) REJECT
  const rejectHits = findings.filter(
    (f) => f.forbidden || f.auto_decision === 'REJECT',
  );
  if (rejectHits.length) {
    return {
      decision: 'REJECT',
      risk_score: Math.max(80, computeRiskScore(findings)),
      reason_codes: uniq([...reasonCodes, ...rejectHits.map((f) => `REJECT_${f.rule_id || 'FORBIDDEN'}`)]),
      matched_rule_ids: matched,
      passed_rule_ids: passed,
      summary: `命中禁止性/否决规则：${rejectHits.map((f) => f.rule_id || f.title).join('、')}`,
      findings,
      playbook_id: playbook?.playbook_id || null,
      playbook_version: playbook?.version || null,
    };
  }

  // 2) MANUAL triggers
  const highCount = findings.filter((f) => f.severity === 'HIGH').length;
  const mediumCount = findings.filter((f) => f.severity === 'MEDIUM').length;
  const missingCount = findings.filter((f) => f.missing).length;
  const amount = Number(contractProfile.amount ?? contractProfile.contract_amount ?? NaN);
  const amountLimit = Number(playbook?.auto_approval_limit ?? 500000);
  const mediumThreshold = Number(playbook?.medium_risk_threshold ?? 2);

  if (highCount > 0) {
    reasonCodes.push('HIGH_RISK');
  }
  if (missingCount > 0) {
    reasonCodes.push('MISSING_REQUIRED');
  }
  if (!Number.isNaN(amount) && amount > amountLimit) {
    reasonCodes.push('AMOUNT_OVER_LIMIT');
  }
  if (mediumCount > mediumThreshold) {
    reasonCodes.push('MEDIUM_RISK_OVERFLOW');
  }

  if (highCount > 0 || missingCount > 0 || reasonCodes.includes('AMOUNT_OVER_LIMIT') || reasonCodes.includes('MEDIUM_RISK_OVERFLOW')) {
    return {
      decision: 'MANUAL',
      risk_score: computeRiskScore(findings),
      reason_codes: uniq(reasonCodes),
      matched_rule_ids: matched,
      passed_rule_ids: passed,
      summary: `转人工法务：${uniq(reasonCodes).join('；') || '存在需人工确认的风险'}`,
      findings,
      playbook_id: playbook?.playbook_id || null,
      playbook_version: playbook?.version || null,
    };
  }

  // 3) PASS — record playbook rules as passed when no findings
  for (const rule of playbook?.rules || []) {
    if (!matched.includes(rule.id)) passed.push(rule.id);
  }

  return {
    decision: 'PASS',
    risk_score: computeRiskScore(findings),
    reason_codes: ['ALL_CHECKS_PASSED'],
    matched_rule_ids: [],
    passed_rule_ids: uniq(passed),
    summary: `法务自动审批通过。依据：${uniq(passed).slice(0, 8).join('、') || '无风险命中'}`,
    findings,
    playbook_id: playbook?.playbook_id || null,
    playbook_version: playbook?.version || null,
  };
}

module.exports = {
  decideApproval,
  collectFindings,
  normalizeSeverity,
  computeRiskScore,
};
