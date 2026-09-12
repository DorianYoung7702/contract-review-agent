const test = require('node:test');
const assert = require('node:assert/strict');

const { getVectorStoreMode, isKeywordOnlyMode } = require('../services/vectorStore/config');
const { toVectorDocumentRows } = require('../services/vectorStore/documentMapping');

test('vector store mode recognises keyword-only aliases', () => {
    assert.equal(getVectorStoreMode(' KEYWORD '), 'keyword');
    assert.equal(isKeywordOnlyMode('keyword'), true);
    assert.equal(isKeywordOnlyMode('lexical'), true);
    assert.equal(isKeywordOnlyMode('pg'), false);
    assert.equal(isKeywordOnlyMode('milvus'), false);
});

test('keyword-only import creates searchable rows without embedding calls', async () => {
    const previous = process.env.VECTOR_STORE;
    process.env.VECTOR_STORE = 'keyword';
    try {
        const rows = await toVectorDocumentRows({
            source_type: 'law',
            title: '测试法律',
            content: '合同一方违反付款、交付或者保密义务时，应当按照合同约定承担违约责任并赔偿实际损失。',
        });
        assert.ok(rows.length > 0);
        assert.deepEqual(rows[0].embedding, []);
        assert.match(rows[0].content, /违约责任/);
    } finally {
        if (previous === undefined) delete process.env.VECTOR_STORE;
        else process.env.VECTOR_STORE = previous;
    }
});
