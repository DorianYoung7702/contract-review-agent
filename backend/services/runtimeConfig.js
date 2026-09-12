/**
 * @file services/runtimeConfig.js
 * @brief 运行时读写 LLM / 企查查配置，同步 process.env 与 backend/.env
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

const LLM_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];
const COMPANY_KEYS = [
    'COMPANY_API_PROVIDER',
    'COMPANY_API_TOKEN',
    'COMPANY_API_SECRET',
    'COMPANY_API_BASE_URL',
];

const SECRET_KEYS = new Set(['LLM_API_KEY', 'COMPANY_API_TOKEN', 'COMPANY_API_SECRET']);

const maskSecret = (value) => {
    const text = String(value || '');
    if (!text) return '';
    if (text.length <= 8) return `${text.slice(0, 2)}****`;
    return `${text.slice(0, 4)}****${text.slice(-4)}`;
};

const readEnvFile = () => {
    try {
        return fs.readFileSync(ENV_PATH, 'utf8');
    } catch {
        return '';
    }
};

const upsertEnvVars = (updates = {}) => {
    let content = readEnvFile();
    const lines = content ? content.split(/\r?\n/) : [];
    const seen = new Set();

    const nextLines = lines.map((line) => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (!match) return line;
        const key = match[1];
        if (!(key in updates)) return line;
        seen.add(key);
        return `${key}=${updates[key]}`;
    });

    Object.entries(updates).forEach(([key, value]) => {
        if (seen.has(key)) return;
        nextLines.push(`${key}=${value}`);
    });

    const output = `${nextLines.join('\n').replace(/\n*$/, '\n')}`;
    fs.writeFileSync(ENV_PATH, output, 'utf8');
};

const getRuntimeConfig = () => {
    const llm = {
        base_url: process.env.LLM_BASE_URL || '',
        api_key_masked: maskSecret(process.env.LLM_API_KEY),
        api_key_configured: Boolean(process.env.LLM_API_KEY),
        model: process.env.LLM_MODEL || '',
    };
    const company = {
        provider: process.env.COMPANY_API_PROVIDER || 'web_search',
        token_masked: maskSecret(process.env.COMPANY_API_TOKEN),
        secret_masked: maskSecret(process.env.COMPANY_API_SECRET),
        token_configured: Boolean(process.env.COMPANY_API_TOKEN),
        secret_configured: Boolean(process.env.COMPANY_API_SECRET),
        base_url: process.env.COMPANY_API_BASE_URL || '',
    };
    const embedding = {
        base_url: process.env.EMBEDDING_BASE_URL || '',
        api_key_masked: maskSecret(process.env.EMBEDDING_API_KEY),
        api_key_configured: Boolean(process.env.EMBEDDING_API_KEY),
        model: process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
        dim: Number(process.env.EMBEDDING_DIM || 1024),
        allow_hash_fallback: ['1', 'true', 'yes'].includes(String(process.env.EMBEDDING_ALLOW_HASH_FALLBACK || '').toLowerCase()),
    };
    const rerank = {
        base_url: process.env.RERANK_BASE_URL || process.env.EMBEDDING_BASE_URL || '',
        api_key_masked: maskSecret(process.env.RERANK_API_KEY || process.env.EMBEDDING_API_KEY),
        api_key_configured: Boolean(process.env.RERANK_API_KEY || process.env.EMBEDDING_API_KEY),
        model: process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3',
    };
    return { llm, company, embedding, rerank };
};

/**
 * @param {{ llm?: object, company?: object, embedding?: object, rerank?: object }} payload
 * @param {{ resetLlmClient?: Function }} hooks
 */
const updateRuntimeConfig = (payload = {}, hooks = {}) => {
    const updates = {};

    if (payload.llm && typeof payload.llm === 'object') {
        if (payload.llm.base_url != null) updates.LLM_BASE_URL = String(payload.llm.base_url).trim();
        if (payload.llm.model != null) updates.LLM_MODEL = String(payload.llm.model).trim();
        const key = payload.llm.api_key;
        if (key != null && String(key).trim() && !String(key).includes('*')) {
            updates.LLM_API_KEY = String(key).trim();
        }
    }

    if (payload.company && typeof payload.company === 'object') {
        if (payload.company.provider != null) {
            updates.COMPANY_API_PROVIDER = String(payload.company.provider).trim() || 'qichacha';
        }
        if (payload.company.base_url != null) {
            updates.COMPANY_API_BASE_URL = String(payload.company.base_url).trim();
        }
        const token = payload.company.token ?? payload.company.api_token;
        if (token != null && String(token).trim() && !String(token).includes('*')) {
            updates.COMPANY_API_TOKEN = String(token).trim();
        }
        const secret = payload.company.secret ?? payload.company.api_secret;
        if (secret != null && String(secret).trim() && !String(secret).includes('*')) {
            updates.COMPANY_API_SECRET = String(secret).trim();
        }
    }

    if (payload.embedding && typeof payload.embedding === 'object') {
        if (payload.embedding.base_url != null) {
            updates.EMBEDDING_BASE_URL = String(payload.embedding.base_url).trim();
        }
        if (payload.embedding.model != null) {
            updates.EMBEDDING_MODEL = String(payload.embedding.model).trim();
        }
        if (payload.embedding.dim != null && Number(payload.embedding.dim) > 0) {
            updates.EMBEDDING_DIM = String(Number(payload.embedding.dim));
        }
        if (payload.embedding.allow_hash_fallback != null) {
            updates.EMBEDDING_ALLOW_HASH_FALLBACK = payload.embedding.allow_hash_fallback ? 'true' : 'false';
        }
        const key = payload.embedding.api_key;
        if (key != null && String(key).trim() && !String(key).includes('*')) {
            updates.EMBEDDING_API_KEY = String(key).trim();
        }
    }

    if (payload.rerank && typeof payload.rerank === 'object') {
        if (payload.rerank.base_url != null) {
            updates.RERANK_BASE_URL = String(payload.rerank.base_url).trim();
        }
        if (payload.rerank.model != null) {
            updates.RERANK_MODEL = String(payload.rerank.model).trim();
        }
        const key = payload.rerank.api_key;
        if (key != null && String(key).trim() && !String(key).includes('*')) {
            updates.RERANK_API_KEY = String(key).trim();
        }
    }

    if (!Object.keys(updates).length) {
        return getRuntimeConfig();
    }

    Object.entries(updates).forEach(([key, value]) => {
        process.env[key] = value;
    });
    upsertEnvVars(updates);

    if (updates.LLM_API_KEY || updates.LLM_BASE_URL) {
        if (typeof hooks.resetLlmClient === 'function') hooks.resetLlmClient();
    }

    return getRuntimeConfig();
};

module.exports = {
    ENV_PATH,
    LLM_KEYS,
    COMPANY_KEYS,
    SECRET_KEYS,
    maskSecret,
    getRuntimeConfig,
    updateRuntimeConfig,
};
