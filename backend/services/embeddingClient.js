/**
 * @file services/embeddingClient.js
 * @brief 文本嵌入与重排序客户端（与 LLM 端点解耦）
 *
 * 注意：DeepSeek Chat 不提供 /embeddings、/rerank。
 * 默认走硅基流动 OpenAI 兼容接口（BGE），也可配置任意兼容服务。
 */

const axios = require('axios');
const crypto = require('crypto');

let lastBackend = 'unknown'; // online | hash_fallback | missing_config

const getConfig = () => {
    // 禁止静默回退到 LLM_BASE_URL（DeepSeek 会 404）
    const baseUrl = (process.env.EMBEDDING_BASE_URL || '').replace(/\/$/, '');
    const apiKey = process.env.EMBEDDING_API_KEY || '';
    const model = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3';
    const rerankBase = (process.env.RERANK_BASE_URL || baseUrl || '').replace(/\/$/, '');
    const rerankKey = process.env.RERANK_API_KEY || apiKey;
    const rerankModel = process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3';
    const dim = Number(process.env.EMBEDDING_DIM || 1024);
    const batchSize = Math.max(1, Number(process.env.EMBEDDING_BATCH_SIZE || 32));
    // 默认允许 hash，保证未配在线 Embedding 时仍可走向量库（与库内 hash 向量一致）
    // 配好 EMBEDDING_API_KEY 后自动走在线模型；显式 EMBEDDING_ALLOW_HASH_FALLBACK=false 才禁止
    const allowHashRaw = process.env.EMBEDDING_ALLOW_HASH_FALLBACK;
    const allowHash = allowHashRaw == null || allowHashRaw === ''
        ? true
        : ['1', 'true', 'yes'].includes(String(allowHashRaw).toLowerCase());
    return {
        baseUrl, apiKey, model, rerankBase, rerankKey, rerankModel, dim, batchSize, allowHash,
    };
};

const hashFallbackEmbedding = (text, dim) => {
    const vector = new Array(dim).fill(0);
    const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const tokens = normalized.match(/[\u4e00-\u9fa5]|[a-z0-9]+/g) || [];
    const grams = [...tokens];
    for (let i = 0; i < tokens.length - 1; i += 1) grams.push(`${tokens[i]}${tokens[i + 1]}`);
    for (const token of grams) {
        const digest = crypto.createHash('sha256').update(token).digest();
        const index = digest.readUInt32BE(0) % dim;
        vector[index] += digest[4] % 2 === 0 ? 1 : -1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm ? vector.map((value) => Number((value / norm).toFixed(6))) : vector;
};

const embeddingUrl = (baseUrl) => `${baseUrl}/embeddings`;
const rerankUrl = (baseUrl) => `${baseUrl}/rerank`;

const getLastBackend = () => lastBackend;

const probeEmbedding = async () => {
    const cfg = getConfig();
    if (!cfg.baseUrl || !cfg.apiKey) {
        return { ok: false, backend: 'missing_config', error: 'EMBEDDING_BASE_URL / EMBEDDING_API_KEY 未配置' };
    }
    try {
        const response = await axios.post(
            embeddingUrl(cfg.baseUrl),
            { model: cfg.model, input: ['合同审查 RAG probe'] },
            { headers: { Authorization: `Bearer ${cfg.apiKey}` }, timeout: 30000 },
        );
        const emb = response.data?.data?.[0]?.embedding;
        if (!Array.isArray(emb) || !emb.length) {
            return { ok: false, backend: 'online', error: '返回空向量' };
        }
        return {
            ok: true,
            backend: 'online',
            model: cfg.model,
            dim: emb.length,
            base_url: cfg.baseUrl,
        };
    } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data
            ? JSON.stringify(error.response.data).slice(0, 200)
            : error.message;
        return { ok: false, backend: 'online', error: `HTTP ${status || '?'} ${detail}` };
    }
};

const probeRerank = async () => {
    const cfg = getConfig();
    if (!cfg.rerankBase || !cfg.rerankKey) {
        return { ok: false, backend: 'missing_config', error: 'RERANK_BASE_URL / RERANK_API_KEY 未配置' };
    }
    try {
        const response = await axios.post(
            rerankUrl(cfg.rerankBase),
            {
                model: cfg.rerankModel,
                query: '试用期',
                documents: ['试用期不得超过六个月', '无关文档'],
                top_n: 2,
            },
            { headers: { Authorization: `Bearer ${cfg.rerankKey}` }, timeout: 30000 },
        );
        const results = response.data?.results;
        if (!Array.isArray(results) || !results.length) {
            return { ok: false, backend: 'online', error: '返回空 rerank 结果' };
        }
        return { ok: true, backend: 'online', model: cfg.rerankModel, base_url: cfg.rerankBase };
    } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data
            ? JSON.stringify(error.response.data).slice(0, 200)
            : error.message;
        return { ok: false, backend: 'online', error: `HTTP ${status || '?'} ${detail}` };
    }
};

const embedTexts = async (texts) => {
    const cfg = getConfig();
    const input = Array.isArray(texts) ? texts : [texts];
    if (input.length > cfg.batchSize) {
        const batches = [];
        for (let i = 0; i < input.length; i += cfg.batchSize) {
            batches.push(...await embedTexts(input.slice(i, i + cfg.batchSize)));
        }
        return batches;
    }

    if (!cfg.baseUrl || !cfg.apiKey) {
        lastBackend = 'missing_config';
        if (!cfg.allowHash) {
            throw new Error(
                'Embedding 未配置：请设置 EMBEDDING_BASE_URL/EMBEDDING_API_KEY（推荐硅基流动 https://api.siliconflow.cn/v1）。'
                + 'DeepSeek 仅支持对话，不能用于向量嵌入。',
            );
        }
        console.warn('[Embedding] missing config; hash fallback enabled.');
        lastBackend = 'hash_fallback';
        return input.map((t) => hashFallbackEmbedding(t, cfg.dim));
    }

    try {
        const response = await axios.post(
            embeddingUrl(cfg.baseUrl),
            { model: cfg.model, input },
            { headers: { Authorization: `Bearer ${cfg.apiKey}` }, timeout: 60000 },
        );
        const data = response.data?.data || [];
        if (!data.length || !Array.isArray(data[0]?.embedding)) {
            throw new Error('embedding response missing data[].embedding');
        }
        lastBackend = 'online';
        return data
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((item) => item.embedding);
    } catch (error) {
        const status = error.response?.status;
        const respData = error.response?.data;
        const detail = respData
            ? (typeof respData === 'string' ? respData.substring(0, 200) : JSON.stringify(respData).substring(0, 200))
            : '';
        if (!cfg.allowHash) {
            lastBackend = 'online_error';
            throw new Error(
                `Online embedding failed: ${error.message}${status ? ` (HTTP ${status})` : ''}${detail ? ` ${detail}` : ''}`
                + '。请检查 EMBEDDING_* 是否指向硅基流动等支持 /embeddings 的服务（勿用 DeepSeek）。',
            );
        }
        console.warn(`[Embedding] Online embedding failed: ${error.message}${status ? ` (HTTP ${status})` : ''}${detail ? ` Response: ${detail}` : ''}. Falling back to local hash vectors.`);
        lastBackend = 'hash_fallback';
        return input.map((t) => hashFallbackEmbedding(t, cfg.dim));
    }
};

const embedText = async (text) => {
    const [embedding] = await embedTexts([text]);
    return embedding;
};

const ensureEmbeddingReady = async () => {
    const cfg = getConfig();
    const [embedding] = await embedTexts(['合同审查知识库初始化']);
    return Array.isArray(embedding) && embedding.length > 0
        && (cfg.dim <= 0 || embedding.length === cfg.dim || lastBackend === 'online');
};

const rerankDocuments = async (query, documents, topN) => {
    const cfg = getConfig();
    if (!documents.length) return [];
    if (!cfg.rerankBase || !cfg.rerankKey) {
        return documents.slice(0, topN || documents.length);
    }

    try {
        const response = await axios.post(
            rerankUrl(cfg.rerankBase),
            {
                model: cfg.rerankModel,
                query,
                documents: documents.map((item) => `${item.title || ''}\n${item.content || ''}`),
                top_n: topN || documents.length,
            },
            { headers: { Authorization: `Bearer ${cfg.rerankKey}` }, timeout: 60000 },
        );
        const results = response.data?.results || [];
        if (!Array.isArray(results) || results.length === 0) {
            return documents.slice(0, topN || documents.length);
        }

        return results
            .map((result) => {
                const source = documents[result.index];
                if (!source) return null;
                return { ...source, rerank_score: result.relevance_score ?? result.score };
            })
            .filter(Boolean);
    } catch (error) {
        console.warn(`[Rerank] Online rerank failed: ${error.message}. Using vector scores only.`);
        return documents.slice(0, topN || documents.length);
    }
};

module.exports = {
    get EMBEDDING_DIM() { return getConfig().dim; },
    get EMBEDDING_MODEL() { return getConfig().model; },
    get RERANK_MODEL() { return getConfig().rerankModel; },
    embedText,
    embedTexts,
    ensureEmbeddingReady,
    rerankDocuments,
    probeEmbedding,
    probeRerank,
    getLastBackend,
    getConfig,
};
