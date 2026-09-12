/**
 * @file services/vectorStore/reembed.js
 * @brief 对已入库文档重新计算 embedding（切换真实向量模型后必跑）
 */

const db = require('../../database');
const { embedTexts, getLastBackend, probeEmbedding } = require('../embeddingClient');

const reembedAllVectorDocuments = async ({ limit = null, batchSize = 16, onProgress } = {}) => {
    const probe = await probeEmbedding();
    if (!probe.ok) {
        throw new Error(`Embedding 不可用，无法重嵌入：${probe.error}`);
    }

    let query = db('vector_documents').select('id', 'title', 'category', 'clause_id', 'content').orderBy('id', 'asc');
    if (limit && Number(limit) > 0) query = query.limit(Number(limit));
    const rows = await query;
    if (!rows.length) return { total: 0, updated: 0, backend: getLastBackend() };

    let updated = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const texts = chunk.map((row) => [
            row.title || '',
            row.category || '',
            row.clause_id || '',
            String(row.content || '').slice(0, 6000),
        ].filter(Boolean).join('\n'));
        const embeddings = await embedTexts(texts);
        for (let j = 0; j < chunk.length; j += 1) {
            const emb = embeddings[j];
            if (!Array.isArray(emb) || !emb.length) continue;
            await db('vector_documents').where({ id: chunk[j].id }).update({
                embedding: JSON.stringify(emb),
                updated_at: db.fn.now(),
            });
            updated += 1;
        }
        if (typeof onProgress === 'function') {
            onProgress({ done: Math.min(i + chunk.length, rows.length), total: rows.length, updated });
        }
        console.log(`[reembed] ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
    }

    return {
        total: rows.length,
        updated,
        backend: getLastBackend(),
        embedding_model: probe.model,
        dim: probe.dim,
    };
};

module.exports = {
    reembedAllVectorDocuments,
};
