/**
 * Lightweight tests for DingTalk confirmation message + action parsing helpers.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildAwaitConfirmMessage } = require('../services/dingtalk/notify');

describe('dingtalk notify message', () => {
  it('includes wait-confirm wording and reply instructions', () => {
    const msg = buildAwaitConfirmMessage({
      contractId: 42,
      filename: '采购合同.docx',
      decision: 'MANUAL',
      riskScore: 55,
      reasonCodes: ['HIGH_RISK', 'PAYMENT_001'],
    });
    assert.match(msg, /等待您确认/);
    assert.match(msg, /确认 #42/);
    assert.match(msg, /驳回 #42/);
    assert.match(msg, /MANUAL/);
    assert.match(msg, /contract_id=42/);
  });
});
