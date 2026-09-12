/**
 * @file services/reviewTemplates.js
 * @brief 审查模板管理服务，提供模板加载、匹配与数据库种子能力
 *
 * 核心职责：
 * - 从数据库或 JSON 文件加载审查模板（DB 优先，失败回退 JSON）
 * - 按关键词命中数与语义相似度加权匹配合同模板
 * - 启动时为空表注入模板并生成 typical_description 与 embedding
 *
 * 关键实现：
 * - 混合匹配：默认关键词命中；Embedding 仅用于模板 seed 可选写入，匹配阶段不依赖
 * - 混合合同（双模板得分均>0.7）返回数组，审查点取并集
 * - 模板匹配不调用 embedding，避免未配置时报错打断审查
 * - 得分全为 0 时回退到 general 通用模板
 *
 * 依赖关系：
 * - 上游：database（review_templates 表）、embeddingClient、data/reviewTemplates.json
 * - 下游：合同审查服务调用 matchTemplate 选择模板
 */

const path = require('path');
const fs = require('fs');
const db = require('../database');
const { embedText } = require('./embeddingClient');

const templatesPath = path.join(__dirname, '..', 'data', 'reviewTemplates.json');

// 从 JSON 文件加载模板(数据库不可用时的回退路径)
const loadTemplatesFromJson = () => {
    if (!fs.existsSync(templatesPath)) return [];
    return JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
};

// 生成模板的典型描述(无 LLM 依赖),用于语义匹配
const generateTypicalDescription = (template) => {
    const name = template.name || template.id || '合同';
    const reviewPoints = (template.review_points || []).slice(0, 5).join('、');
    const corePurposes = (template.core_purposes || []).slice(0, 2).join('、');
    return `该模板用于审查${name}。审查要点:${reviewPoints}。核心目的:${corePurposes}`;
};

// 将数据库行转换为模板对象(jsonb 字段由 knex+pg 自动解析为对象)
const rowToTemplate = (row) => {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        contract_type_keywords: row.contract_type_keywords || [],
        review_points: row.review_points || [],
        core_purposes: row.core_purposes || [],
        report_sections: row.report_sections || [],
        prompt_rules: row.prompt_rules || [],
        typical_description: row.typical_description || '',
        is_active: row.is_active,
        is_system: row.is_system,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
};

// 获取全部模板:优先查数据库,失败回退 JSON 文件
const getAllTemplates = async () => {
    try {
        const rows = await db('review_templates').orderBy('created_at', 'asc');
        if (rows && rows.length > 0) {
            return rows.map(rowToTemplate);
        }
    } catch (error) {
        console.warn('[reviewTemplates] DB query failed, falling back to JSON:', error.message);
    }
    return loadTemplatesFromJson();
};

// 按 id 获取模板:优先查数据库,失败回退 JSON
const getTemplateById = async (id) => {
    if (!id) return null;
    try {
        const row = await db('review_templates').where({ id }).first();
        if (row) return rowToTemplate(row);
    } catch (error) {
        console.warn('[reviewTemplates] DB query failed, falling back to JSON:', error.message);
    }
    return loadTemplatesFromJson().find((template) => template.id === id) || null;
};

// 启动时调用:若 review_templates 表为空,从 JSON 导入,标记 is_system=true,生成 typical_description 与 embedding
const seedTemplatesIfEmpty = async () => {
    try {
        const countRow = await db('review_templates').count({ count: '*' }).first();
        const count = Number(countRow?.count || 0);
        if (count > 0) {
            console.log(`[reviewTemplates] Table already has ${count} templates, skipping seed.`);
            return { seeded: 0, total: count };
        }
        const templates = loadTemplatesFromJson();
        let seeded = 0;
        for (const template of templates) {
            const typicalDescription = generateTypicalDescription(template);
            // seed 时 embedding 失败不影响入库，匹配阶段只用关键词
            let embedding = null;
            try {
                const vector = await embedText(typicalDescription);
                embedding = Array.isArray(vector) ? JSON.stringify(vector) : null;
            } catch (_error) {
                // 静默：模板匹配不依赖 embedding
            }
            await db('review_templates').insert({
                id: template.id,
                name: template.name,
                contract_type_keywords: JSON.stringify(template.contract_type_keywords || []),
                review_points: JSON.stringify(template.review_points || []),
                core_purposes: JSON.stringify(template.core_purposes || []),
                report_sections: JSON.stringify(template.report_sections || []),
                prompt_rules: JSON.stringify(template.prompt_rules || []),
                typical_description: typicalDescription,
                typical_description_embedding: embedding,
                is_active: true,
                is_system: true,
            });
            seeded += 1;
        }
        console.log(`[reviewTemplates] Seeded ${seeded} templates from JSON (is_system=true).`);
        return { seeded, total: seeded };
    } catch (error) {
        console.error('[reviewTemplates] seedTemplatesIfEmpty failed:', error.message);
        return { seeded: 0, total: 0, error: error.message };
    }
};

// 余弦相似度
const cosineSimilarity = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        const av = a[i] || 0;
        const bv = b[i] || 0;
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const parseEmbedding = (value) => {
    if (!value) return null;
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

// 关键词命中得分(保留原逻辑)
const keywordScore = (template, haystack) => (template.contract_type_keywords || []).reduce(
    (sum, keyword) => (haystack.includes(String(keyword).toLowerCase()) ? sum + 1 : sum),
    0,
);

// 模板匹配：直接关键词匹配，不调用 embedding（避免未配置/挂掉时打断审查）
const matchTemplate = async (contractType = '', text = '') => {
    const templates = await getAllTemplates();
    const haystack = `${contractType}\n${text}`.toLowerCase();

    // 强匹配优先:LLM 已识别的 contract_type 唯一命中某模板时直接返回
    if (contractType) {
        const ctLower = contractType.toLowerCase();
        const strongMatches = templates
            .map((t) => ({
                t,
                kwHits: (t.contract_type_keywords || []).filter((k) => ctLower.includes(String(k).toLowerCase())).length,
            }))
            .filter((x) => x.kwHits > 0)
            .sort((a, b) => b.kwHits - a.kwHits);
        if (strongMatches.length > 0 && (strongMatches.length === 1 || strongMatches[0].kwHits > strongMatches[1].kwHits)) {
            return strongMatches[0].t;
        }
    }

    const scored = templates.map((template) => ({
        template,
        score: keywordScore(template, haystack),
    })).sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    // 混合合同:两个模板得分均 > 0.7,返回数组,审查点取并集
    if (scored.length >= 2 && scored[0].score > 0.7 && scored[1].score > 0.7) {
        const unionPoints = Array.from(new Set([
            ...(scored[0].template.review_points || []),
            ...(scored[1].template.review_points || []),
        ]));
        const unionPurposes = Array.from(new Set([
            ...(scored[0].template.core_purposes || []),
            ...(scored[1].template.core_purposes || []),
        ]));
        return [
            { template: { ...scored[0].template, review_points: unionPoints, core_purposes: unionPurposes }, score: scored[0].score },
            { template: { ...scored[1].template, review_points: unionPoints, core_purposes: unionPurposes }, score: scored[1].score },
        ];
    }

    // 单模板:向后兼容返回对象;得分全为 0 时回退到 general
    const best = scored[0];
    if (best.score <= 0) {
        return templates.find((t) => t.id === 'general') || templates[0] || null;
    }
    return best.template;
};

module.exports = {
    getAllTemplates,
    getTemplateById,
    matchTemplate,
    seedTemplatesIfEmpty,
    generateTypicalDescription,
};
