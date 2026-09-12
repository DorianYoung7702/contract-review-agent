/**
 * @file services/amountArithmeticCheck.js
 * @brief 合同金额算术一致性：数量 × 单价 是否等于金额/合计
 *
 * 不依赖 Embedding/LLM；确定性扫描，供审查硬性违规列表使用。
 */

const toNumber = (raw) => {
    if (raw == null) return null;
    const cleaned = String(raw).replace(/,/g, '').replace(/，/g, '').trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
};

const nearlyEqual = (a, b, { absTol = 0.02, relTol = 0.001 } = {}) => {
    const diff = Math.abs(a - b);
    if (diff <= absTol) return true;
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return diff / scale <= relTol;
};

const moneyUnitFactor = (unit) => {
    const u = String(unit || '').trim();
    if (/万元/.test(u)) return 10000;
    return 1;
};

/**
 * 在局部文本中抽取 数量 / 单价 / 金额（合计/总价/价款）
 * 支持：数量：10、单价100元、金额 1000 元、共10件×单价50元=合计500元 等常见写法
 */
const extractTriplet = (chunk) => {
    const text = String(chunk || '');

    // 模式 A：显式「共N×单价M=金额P」或「数量N 单价M 金额P」同行
    const inline = text.match(
        /(?:数量|Qty|QTY)[^\d]{0,8}(\d+(?:\.\d+)?)\s*(?:件|个|台|套|吨|千克|kg|KG|箱|批)?[^\d]{0,20}(?:单价|含税单价|不含税单价)[^\d]{0,8}(\d+(?:\.\d+)?)[^\d]{0,8}(万元|元)?[^\d]{0,24}(?:金额|合计|小计|总价|价款|货款)[^\d]{0,8}(\d+(?:\.\d+)?)[^\d]{0,8}(万元|元)?/i,
    );
    if (inline) {
        return {
            qty: toNumber(inline[1]),
            unitPrice: toNumber(inline[2]) * moneyUnitFactor(inline[3]),
            amount: toNumber(inline[4]) * moneyUnitFactor(inline[5]),
            source: 'inline',
        };
    }

    // 模式 B：分散字段
    const qtyM = text.match(/(?:数量|Qty|QTY)[^\d]{0,8}(\d+(?:\.\d+)?)/i);
    const priceM = text.match(/(?:单价|含税单价|不含税单价)[^\d]{0,8}(\d+(?:\.\d+)?)[^\d]{0,8}(万元|元)?/);
    const amountM = text.match(/(?:金额|合计|小计|总价|价款|货款|合同金额)[^\d]{0,8}(\d+(?:\.\d+)?)[^\d]{0,8}(万元|元)?/);
    if (qtyM && priceM && amountM) {
        return {
            qty: toNumber(qtyM[1]),
            unitPrice: toNumber(priceM[1]) * moneyUnitFactor(priceM[2]),
            amount: toNumber(amountM[1]) * moneyUnitFactor(amountM[2]),
            source: 'fields',
        };
    }

    // 模式 C：N × M = P / N*M元=P元
    const mul = text.match(
        /(\d+(?:\.\d+)?)\s*[×xX\*＊]\s*(\d+(?:\.\d+)?)\s*(?:元)?\s*[=＝]\s*(\d+(?:\.\d+)?)\s*(万元|元)?/,
    );
    if (mul) {
        return {
            qty: toNumber(mul[1]),
            unitPrice: toNumber(mul[2]),
            amount: toNumber(mul[3]) * moneyUnitFactor(mul[4]),
            source: 'mul_eq',
        };
    }

    return null;
};

const splitWindows = (text) => {
    const src = String(text || '');
    if (!src) return [];
    // 按行 / 分号 / 表格感分隔切块，并保留含金额关键词的上下文窗
    const parts = src.split(/[\n\r；;|｜]+/).map((s) => s.trim()).filter(Boolean);
    const windows = [];
    for (let i = 0; i < parts.length; i += 1) {
        const chunk = [parts[i - 1], parts[i], parts[i + 1]].filter(Boolean).join(' ');
        if (/(数量|单价|金额|合计|总价|价款)/.test(chunk)) {
            windows.push(chunk.slice(0, 500));
        }
    }
    if (!windows.length && /(数量|单价)/.test(src)) {
        // 整文滑窗兜底
        for (let i = 0; i < src.length; i += 280) {
            windows.push(src.slice(i, i + 420));
        }
    }
    return windows;
};

/**
 * @returns {{ violations: Array, checked: number }}
 */
const checkAmountArithmetic = (contractText) => {
    const violations = [];
    const seen = new Set();
    const windows = splitWindows(contractText);
    let checked = 0;

    for (const chunk of windows) {
        const triplet = extractTriplet(chunk);
        if (!triplet) continue;
        const { qty, unitPrice, amount } = triplet;
        if (![qty, unitPrice, amount].every((n) => Number.isFinite(n) && n > 0)) continue;
        checked += 1;
        const expected = qty * unitPrice;
        if (nearlyEqual(expected, amount)) continue;

        const key = `${qty}|${unitPrice}|${amount}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const expectedRounded = Math.round(expected * 100) / 100;
        violations.push({
            rule_id: 'AMOUNT_ARITH_001',
            description: `数量×单价与金额不一致：${qty} × ${unitPrice} = ${expectedRounded}，合同填写金额为 ${amount}`,
            legal_basis: '合同价款算术一致性（数量×单价应等于金额/合计）',
            contract_value: amount,
            limit_value: expectedRounded,
            severity: '高',
            fix_template: `请将金额修正为 ${expectedRounded}（或同步修正数量/单价，使三者一致）`,
            clause_excerpt: chunk.slice(0, 220),
            qty,
            unit_price: unitPrice,
            written_amount: amount,
            expected_amount: expectedRounded,
        });
    }

    return { violations, checked };
};

module.exports = {
    checkAmountArithmetic,
    extractTriplet,
    nearlyEqual,
};
