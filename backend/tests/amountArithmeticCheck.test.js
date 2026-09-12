const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkAmountArithmetic, extractTriplet } = require('../services/amountArithmeticCheck');

describe('amountArithmeticCheck', () => {
    it('detects qty * unitPrice != amount', () => {
        const text = '货物明细：数量：10件，单价：100元，金额：900元。';
        const { violations } = checkAmountArithmetic(text);
        assert.equal(violations.length, 1);
        assert.equal(violations[0].rule_id, 'AMOUNT_ARITH_001');
        assert.equal(violations[0].expected_amount, 1000);
        assert.equal(violations[0].written_amount, 900);
    });

    it('passes when arithmetic matches', () => {
        const text = '数量 5 单价 200 元 合计 1000 元';
        const { violations } = checkAmountArithmetic(text);
        assert.equal(violations.length, 0);
    });

    it('parses inline mul equals', () => {
        const t = extractTriplet('共 3 × 50 = 150 元');
        assert.deepEqual(
            { qty: t.qty, unitPrice: t.unitPrice, amount: t.amount },
            { qty: 3, unitPrice: 50, amount: 150 },
        );
    });
});
