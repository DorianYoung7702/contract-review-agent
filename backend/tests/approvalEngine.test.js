/**
 * Table-driven tests for Approval Engine + playbook loader/matcher + normalize rule_id.
 * Run: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { decideApproval, normalizeSeverity } = require('../services/approvalEngine');
const { loadAllPlaybooks, getPlaybookById } = require('../services/playbook/loader');
const { matchPlaybook } = require('../services/playbook/matcher');
const { normalizeFindingItem, normalizeAnalysisResult, buildStructuredResult } = require('../services/contractAnalysis/analysisCore');

const fixturesDir = path.join(__dirname, 'fixtures');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

describe('playbook loader/matcher', () => {
  it('loads purchase and sales playbooks with required rule fields', () => {
    const all = loadAllPlaybooks({ force: true });
    assert.ok(all.length >= 2);
    const purchase = getPlaybookById('purchase_v1');
    assert.ok(purchase);
    assert.equal(purchase.contract_type, '采购合同');
    const ids = purchase.rules.map((r) => r.id);
    for (const id of ['PAYMENT_001', 'LIABILITY_001', 'IP_001', 'CONFIDENTIAL_001', 'JURISDICTION_001']) {
      assert.ok(ids.includes(id), `missing rule ${id}`);
    }
    const sales = all.find((p) => p.contract_type === '销售合同');
    assert.ok(sales);
  });

  it('matches 采购合同 and keyword 购销', () => {
    assert.equal(matchPlaybook('采购合同').playbook_id, 'purchase_v1');
    assert.equal(matchPlaybook('设备购销合同').playbook_id, 'purchase_v1');
  });
});

describe('normalize findings with rule_id', () => {
  it('preserves rule_id / severity / values on normalizeFindingItem', () => {
    const item = normalizeFindingItem({
      ruleId: 'PAYMENT_001',
      severity: '高',
      contract_value: '80%',
      limit_value: '30%',
      title: '预付款过高',
    });
    assert.equal(item.rule_id, 'PAYMENT_001');
    assert.equal(item.severity, 'high');
    assert.equal(item.current_value, '80%');
    assert.equal(item.standard_value, '30%');
  });

  it('normalizeAnalysisResult maps rule_id on dispute/missing/suggestions', () => {
    const result = normalizeAnalysisResult({
      dispute_points: [{ rule_id: 'IP_001', title: 'IP', severity: 'medium' }],
      missing_clauses: [{ rule_id: 'CONFIDENTIAL_001', title: '缺保密' }],
      modification_suggestions: [{ ruleId: 'JURISDICTION_001', title: '管辖' }],
    });
    assert.equal(result.dispute_points[0].rule_id, 'IP_001');
    assert.equal(result.missing_clauses[0].rule_id, 'CONFIDENTIAL_001');
    assert.equal(result.modification_suggestions[0].rule_id, 'JURISDICTION_001');
  });

  it('buildStructuredResult merges hard_violations with rule_id', () => {
    const structured = buildStructuredResult(
      { dispute_points: [], missing_clauses: [], modification_suggestions: [] },
      [{ rule_id: 'PAYMENT_001', description: '预付款 80%', severity: 'high', contract_value: '80%', limit_value: '30%' }],
    );
    assert.equal(structured.hard_violations[0].rule_id, 'PAYMENT_001');
    assert.ok(structured.findings.some((f) => f.rule_id === 'PAYMENT_001'));
  });
});

describe('approvalEngine decideApproval', () => {
  it('normalizeSeverity maps zh/en', () => {
    assert.equal(normalizeSeverity('高'), 'HIGH');
    assert.equal(normalizeSeverity('medium'), 'MEDIUM');
  });

  it('sample A compliant purchase → PASS with passed rule_ids', () => {
    const fx = loadFixture('sample-a-compliant.json');
    const playbook = matchPlaybook(fx.contract_type);
    const approval = decideApproval({
      playbook,
      structuredResult: fx.structuredResult,
      contractProfile: fx.contractProfile,
    });
    assert.equal(approval.decision, 'PASS');
    assert.ok(approval.reason_codes.includes('ALL_CHECKS_PASSED'));
    for (const id of fx.expected.passed_rule_ids_includes) {
      assert.ok(approval.passed_rule_ids.includes(id), `expected passed ${id}, got ${approval.passed_rule_ids}`);
    }
  });

  it('sample B 80% prepaid → MANUAL + PAYMENT_001', () => {
    const fx = loadFixture('sample-b-high-prepaid.json');
    const playbook = matchPlaybook(fx.contract_type);
    const approval = decideApproval({
      playbook,
      structuredResult: fx.structuredResult,
      contractProfile: fx.contractProfile,
    });
    assert.equal(approval.decision, 'MANUAL');
    assert.ok(approval.matched_rule_ids.includes('PAYMENT_001'));
    assert.ok(approval.reason_codes.includes('HIGH_RISK'));
  });

  it('forbidden / REJECT auto_decision → REJECT', () => {
    const playbook = getPlaybookById('purchase_v1');
    const approval = decideApproval({
      playbook,
      structuredResult: {
        dispute_points: [{
          rule_id: 'FORBIDDEN_EXCLUSIVE_001',
          title: '绝对免责',
          severity: 'HIGH',
          forbidden: true,
          auto_decision: 'REJECT',
        }],
      },
    });
    assert.equal(approval.decision, 'REJECT');
    assert.ok(approval.matched_rule_ids.includes('FORBIDDEN_EXCLUSIVE_001'));
  });

  it('amount over auto_approval_limit → MANUAL', () => {
    const playbook = getPlaybookById('purchase_v1');
    const approval = decideApproval({
      playbook,
      structuredResult: { dispute_points: [], missing_clauses: [] },
      contractProfile: { amount: 800000 },
    });
    assert.equal(approval.decision, 'MANUAL');
    assert.ok(approval.reason_codes.includes('AMOUNT_OVER_LIMIT'));
  });
});
