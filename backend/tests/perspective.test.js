const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findOrganizationParty,
  resolveReviewPerspective,
} = require('../services/contractAnalysis/perspective');

test('defaults review perspective to the party containing 云伽智能', () => {
  const parties = [
    '甲方：某建设单位',
    '乙方：深圳市云伽智能技术有限公司',
  ];
  assert.equal(findOrganizationParty(parties), parties[1]);
});

test('normalizes spaces and preserves an explicit manual perspective', () => {
  const parties = ['甲方（深圳市 云伽 智能技术有限公司）', '乙方'];
  assert.equal(findOrganizationParty(parties), parties[0]);
  assert.equal(resolveReviewPerspective('乙方', parties, '我方'), '乙方');
});

test('automatic pipeline can fall back when 云伽智能 is absent', () => {
  const parties = ['甲方：外部公司', '乙方：供应商'];
  assert.equal(resolveReviewPerspective('', parties, parties[0]), parties[0]);
});
