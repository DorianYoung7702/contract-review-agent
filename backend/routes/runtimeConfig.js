/**
 * @file routes/runtimeConfig.js
 * @brief LLM / 企查查 / Embedding+Rerank 运行时配置
 */
const express = require('express');
const { getRuntimeConfig, updateRuntimeConfig } = require('../services/runtimeConfig');
const { resetLlmClient } = require('../services/llmClient');
const { probeEmbedding, probeRerank } = require('../services/embeddingClient');
const { reembedAllVectorDocuments } = require('../services/vectorStore/reembed');

const router = express.Router();

router.get('/', (req, res) => {
    res.json(getRuntimeConfig());
});

router.put('/', (req, res) => {
    try {
        const next = updateRuntimeConfig(req.body || {}, { resetLlmClient });
        res.json({ ok: true, ...next });
    } catch (error) {
        console.error('[runtimeConfig] update failed:', error.message);
        res.status(500).json({ error: `保存配置失败：${error.message}` });
    }
});

router.get('/embedding/probe', async (req, res) => {
    const [embedding, rerank] = await Promise.all([probeEmbedding(), probeRerank()]);
    res.json({ embedding, rerank });
});

router.post('/embedding/reembed', async (req, res) => {
    try {
        const limit = req.body?.limit != null ? Number(req.body.limit) : null;
        const result = await reembedAllVectorDocuments({ limit });
        res.json({ ok: true, ...result });
    } catch (error) {
        console.error('[reembed] failed:', error.message);
        res.status(500).json({ error: error.message || '重嵌入失败' });
    }
});

module.exports = router;
