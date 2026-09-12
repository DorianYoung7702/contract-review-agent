/**
 * @file services/vectorStore/index.js
 * @brief 向量库统一入口（Facade），编排各子模块对外暴露一致接口
 *
 * 核心职责：
 * - 整合 relationalStore + milvusStore + seedSources + documentMapping
 * - 提供知识库 seed（法律 Markdown / 案例 JSON）、导入、删除、清空
 * - 提供单/多 query 向量检索，支持 rerank 与阈值过滤
 *
 * 关键实现：
 * - importKnowledgeEntries 双写 PG 与 Milvus 并按 content_hash 去重
 * - seedLawsFromMarkdown/seedCasesFromJson 支持断点续传与进度回调
 * - searchVectorDocumentsMulti 多 query 分通道召回后按 hash 融合去重
 * - 候选集最小 48 条保证 rerank 有效候选
 *
 * 依赖关系：
 * - 上游：../../database、../embeddingClient、../legalMarkdownParser、../caseJsonParser 及本目录各子模块
 * - 下游：被 knowledge、analysisCore 等检索流程及 seed 初始化脚本调用
 */
const path = require('path');
const fs = require('fs');
const db = require('../../database');
const { EMBEDDING_DIM, embedText, ensureEmbeddingReady, rerankDocuments, getLastBackend } = require('../embeddingClient');
const { parseLegalMarkdownFile } = require('../legalMarkdownParser');
const { parseCaseJsonDocument } = require('../caseJsonParser');

const {
    state,
    KNOWLEDGE_SEED_TYPES,
    LAW_SEED_FILE_BATCH_SIZE,
    CASE_SEED_FILE_BATCH_SIZE,
    getVectorStoreMode,
    isKeywordOnlyMode,
} = require('./config');
const { normalizeText, splitTextIntoChunks, splitIntoParagraphs, splitIntoParagraphGroups } = require('./textChunking');
const { listConfiguredLawDirs, listMarkdownFiles, listCaseJsonFiles, fallbackLawEntryFromFile } = require('./seedSources');
const { ensureRelationalVectorTable, upsertRelationalRow, listKnowledgeDocuments, sqliteVectorSearch, keywordSearch, mergeSearchResults } = require('./relationalStore');
const { ensureMilvusCollection, upsertMilvusRows, deleteMilvusRows, milvusVectorSearch } = require('./milvusStore');
const { toVectorDocumentRows } = require('./documentMapping');

const requireMilvus = () => {
    const mode = getVectorStoreMode();
    return !isKeywordOnlyMode(mode) && !['sqlite', 'postgres', 'pg', 'relational'].includes(mode);
};

const ensureVectorStore = async () => {
    await ensureRelationalVectorTable();
    try {
        await ensureMilvusCollection();
    } catch (error) {
        console.warn(`[VectorStore] Milvus init skipped: ${error.message}`);
    }
    // Milvus 未就绪时仍允许关键词检索，保证审查可继续
};

// 导入知识条目:双写 PG(vector_documents)与 Milvus。
// skipMilvus=true 时仅写 PG,用于启动阶段先入库 PG、再由后台异步同步到 Milvus。
const importKnowledgeEntries = async (entries, { skipMilvus = false } = {}) => {
    await ensureVectorStore();
    let imported = 0;
    let chunks = 0;
    let deduped = 0;
    let milvusRowsBuffer = [];

    const flushMilvusRows = async () => {
        if (skipMilvus || milvusRowsBuffer.length === 0) return;
        await upsertMilvusRows(milvusRowsBuffer);
        milvusRowsBuffer = [];
    };

    for (const entry of entries) {
        const rows = [];
        if (Array.isArray(entry.key_clauses)) {
            for (const clause of entry.key_clauses) {
                rows.push(...await toVectorDocumentRows({
                    ...entry,
                    content: clause.content,
                    clauseId: clause.id,
                    sourceId: entry.source_id || `${entry.source_type || entry.type || 'law'}:${entry.title}:${clause.id}`,
                    metadata: { ...(entry.metadata || {}), law: entry.title, category: entry.category },
                }));
            }
        } else {
            rows.push(...await toVectorDocumentRows(entry));
        }

        const uniqueRows = [];
        const seen = new Set();
        for (const row of rows) {
            if (seen.has(row.content_hash)) {
                deduped += 1;
                continue;
            }
            seen.add(row.content_hash);
            uniqueRows.push(row);
        }

        for (const row of uniqueRows) {
            const result = await upsertRelationalRow(row);
            if (result.deduped) deduped += 1;
        }
        if (!skipMilvus) {
            milvusRowsBuffer.push(...uniqueRows);
            if (milvusRowsBuffer.length >= 200) {
                await flushMilvusRows();
            }
        }
        imported += 1;
        chunks += uniqueRows.length;
    }
    await flushMilvusRows();

    return { imported, chunks, deduped, vectorStore: state.milvusReady ? 'milvus' : 'relational-fallback' };
};

const seedLawsFromMarkdown = async (onProgress, { skipMilvus = false } = {}) => {
    if (!KNOWLEDGE_SEED_TYPES.includes('law')) {
        console.log('[DB Init] Law seeding disabled by KNOWLEDGE_SEED_TYPES.');
        return { skipped: true, disabled: true };
    }
    await ensureVectorStore();
    if (!isKeywordOnlyMode()) {
        const embeddingReady = await ensureEmbeddingReady();
        if (!embeddingReady) {
            throw new Error(`Embedding model dimension mismatch. Expected ${EMBEDDING_DIM}.`);
        }
    }

    const existingLawCount = await db('vector_documents').where({ source_type: 'law' }).count({ count: '*' }).first();
    const forceReseed = String(process.env.FORCE_RESEED_LAWS || '').toLowerCase() === 'true';
    if (Number(existingLawCount?.count || 0) > 0 && !forceReseed) {
        console.log('[DB Init] Law data already in PostgreSQL. Skipping startup reseed.');
        return { skipped: true, existing: Number(existingLawCount?.count || 0) };
    }

    const seedDirs = listConfiguredLawDirs();
    const files = listMarkdownFiles(seedDirs);
    if (files.length === 0) {
        console.warn(`[DB Init] No law markdown files found under ${seedDirs.join(', ')}.`);
        return { imported: 0, chunks: 0, files: 0 };
    }

    if (forceReseed) {
        await deleteKnowledgeDocuments({ sourceType: 'law' });
    }

    const totals = { imported: 0, chunks: 0, deduped: 0, files: 0, failed: 0, vectorStore: state.milvusReady ? 'milvus' : 'relational-fallback' };
    let fileCounter = 0;
    for (let i = 0; i < files.length; i += LAW_SEED_FILE_BATCH_SIZE) {
        const batch = files.slice(i, i + LAW_SEED_FILE_BATCH_SIZE);
        const entries = [];
        for (const filePath of batch) {
            const sourceFile = path.relative(path.join(__dirname, '..', '..'), filePath);
            const fileName = path.basename(filePath);
            try {
                const parsed = parseLegalMarkdownFile(filePath, { sourceFile });
                if (parsed.length > 0) {
                    entries.push(...parsed);
                } else {
                    const fallback = fallbackLawEntryFromFile(filePath);
                    if (fallback) entries.push(fallback);
                }
                totals.files += 1;
            } catch (error) {
                totals.failed += 1;
                console.warn(`[DB Init] Failed to parse law markdown ${sourceFile}: ${error.message}`);
            }
            // 上报单文件进度
            fileCounter += 1;
            if (onProgress) {
                await onProgress({
                    phase: 'law',
                    current: fileCounter,
                    total: files.length,
                    fileName,
                    chunks: totals.chunks,
                });
            }
        }
        if (entries.length > 0) {
            const result = await importKnowledgeEntries(entries, { skipMilvus });
            totals.imported += result.imported || 0;
            totals.chunks += result.chunks || 0;
            totals.deduped += result.deduped || 0;
            totals.vectorStore = result.vectorStore || totals.vectorStore;
        }
        console.log(`[DB Init] Law seed progress: ${Math.min(i + batch.length, files.length)}/${files.length} files, ${totals.chunks} chunks.`);
    }

    return totals;
};

const seedCasesFromJson = async (onProgress, { skipMilvus = false } = {}) => {
    if (!KNOWLEDGE_SEED_TYPES.includes('case')) {
        console.log('[DB Init] Case seeding disabled by KNOWLEDGE_SEED_TYPES.');
        return { skipped: true, disabled: true };
    }
    await ensureVectorStore();
    if (!isKeywordOnlyMode()) {
        const embeddingReady = await ensureEmbeddingReady();
        if (!embeddingReady) {
            throw new Error(`Embedding model dimension mismatch. Expected ${EMBEDDING_DIM}.`);
        }
    }

    const existingCaseCount = await db('vector_documents').where({ source_type: 'case' }).count({ count: '*' }).first();
    const forceReseed = String(process.env.FORCE_RESEED_CASES || '').toLowerCase() === 'true';
    if (Number(existingCaseCount?.count || 0) > 0 && !forceReseed) {
        console.log('[DB Init] Case data already in PostgreSQL. Skipping startup reseed.');
        return { skipped: true, existing: Number(existingCaseCount?.count || 0) };
    }

    const files = listCaseJsonFiles();
    if (files.length === 0) {
        console.warn(`[DB Init] No case JSON files found under ${process.env.CASE_SEED_DIR || 'candidate_55192'}.`);
        return { imported: 0, chunks: 0, files: 0 };
    }

    if (forceReseed) {
        await deleteKnowledgeDocuments({ sourceType: 'case' });
    }

    const totals = { imported: 0, chunks: 0, deduped: 0, files: 0, failed: 0, vectorStore: state.milvusReady ? 'milvus' : 'relational-fallback' };
    for (let i = 0; i < files.length; i += CASE_SEED_FILE_BATCH_SIZE) {
        const batch = files.slice(i, i + CASE_SEED_FILE_BATCH_SIZE);
        const entries = [];
        for (let j = 0; j < batch.length; j += 1) {
            const filePath = batch[j];
            const sourceFile = path.relative(path.join(__dirname, '..', '..'), filePath);
            const fileName = path.basename(filePath);
            try {
                const parsed = parseCaseJsonDocument(JSON.parse(fs.readFileSync(filePath, 'utf8')), { sourceFile });
                if (parsed) entries.push(parsed);
                totals.files += 1;
            } catch (error) {
                totals.failed += 1;
                console.warn(`[DB Init] Failed to parse case JSON ${sourceFile}: ${error.message}`);
            }
            if (onProgress) {
                await onProgress({
                    phase: 'case',
                    current: i + j + 1,
                    total: files.length,
                    fileName,
                    chunks: totals.chunks,
                });
            }
        }
        if (entries.length > 0) {
            const result = await importKnowledgeEntries(entries, { skipMilvus });
            totals.imported += result.imported || 0;
            totals.chunks += result.chunks || 0;
            totals.deduped += result.deduped || 0;
            totals.vectorStore = result.vectorStore || totals.vectorStore;
        }
        console.log(`[DB Init] Case seed progress: ${Math.min(i + batch.length, files.length)}/${files.length} files, ${totals.chunks} chunks.`);
    }

    console.log(`[DB Init] Case seed finished: ${totals.files}/${files.length} files, ${totals.chunks} chunks.`);
    return totals;
};

const deleteKnowledgeDocuments = async ({ ids = [], sourceIds = [], sourceType = '', title = '' } = {}) => {
    await ensureVectorStore();
    let query = db('vector_documents');
    let hasFilter = false;

    if (ids.length > 0) {
        query = query.whereIn('id', ids);
        hasFilter = true;
    }
    if (sourceIds.length > 0) {
        query = query.whereIn('source_id', sourceIds);
        hasFilter = true;
    }
    if (sourceType) {
        query = query.where('source_type', sourceType);
        hasFilter = true;
    }
    if (title) {
        query = query.where('title', title);
        hasFilter = true;
    }
    if (!hasFilter) {
        throw new Error('At least one delete filter is required.');
    }

    const rows = await query.clone().select('id', 'source_id', 'content_hash');
    if (rows.length === 0) {
        return { deleted: 0, vectorStore: state.milvusReady ? 'milvus' : 'relational-fallback' };
    }
    await deleteMilvusRows(rows);
    await db('vector_documents').whereIn('id', rows.map((row) => row.id)).del();
    return { deleted: rows.length, vectorStore: state.milvusReady ? 'milvus' : 'relational-fallback' };
};

// 清空所有向量数据（用于重建），同时清空 SQLite 和 Milvus
const clearAllVectorDocuments = async () => {
    await ensureVectorStore();
    const rows = await db('vector_documents').select('id', 'source_id', 'content_hash');
    const deleted = rows.length;
    if (deleted > 0) {
        await deleteMilvusRows(rows);
        await db('vector_documents').del();
    }
    return { deleted, vectorStore: state.milvusReady ? 'milvus' : 'relational-fallback' };
};

// 将 PG(vector_documents)全量同步到 Milvus,用于启动后台同步与"重建向量数据库"。
// 仅 upsert(按 content_hash 去重更新),不删除 PG 已有数据,也不清空 Milvus;
// Milvus 不可用时跳过并返回降级信息。与初始化时的同步操作完全一致,覆盖所有 source_type。
const syncAllVectorDocuments = async (onProgress) => {
    await ensureVectorStore();
    if (!state.milvusReady) {
        console.warn('[VectorStore] Milvus not ready, skip sync (keyword search still available).');
        return { synced: 0, total: 0, vectorStore: 'relational-fallback', skipped: true, reason: 'Milvus not ready' };
    }
    const totalRow = await db('vector_documents').count({ count: '*' }).first();
    const total = Number(totalRow?.count || 0);
    if (total === 0) {
        return { synced: 0, total: 0, vectorStore: 'milvus' };
    }
    let synced = 0;
    let lastId = 0;
    while (true) {
        const rows = await db('vector_documents')
            .where('id', '>', lastId)
            .orderBy('id', 'asc')
            .limit(200)
            .select('*');
        if (rows.length === 0) break;
        lastId = rows[rows.length - 1].id;
        const batch = rows.map((row) => ({
            ...row,
            embedding: JSON.parse(row.embedding || '[]'),
        }));
        await upsertMilvusRows(batch);
        synced += batch.length;
        if (onProgress) {
            await onProgress({ current: synced, total });
        }
    }
    return { synced, total, vectorStore: state.milvusReady ? 'milvus' : 'relational-fallback' };
};

const searchVectorDocuments = async (query, { limit = 5, sourceTypes = [], rerank = true, includeHistorical = false } = {}) => {
    await ensureVectorStore();
    const cleanQuery = normalizeText(query);
    const candidateLimit = Math.max(limit * 8, 48);
    const keywordOnly = isKeywordOnlyMode();

    // 查询向量：优先在线 Embedding；不可用时用 hash（与库内向量同空间），保证能打到向量知识库
    let queryVector = null;
    let embeddingBackend = keywordOnly ? 'keyword_only' : 'none';
    if (!keywordOnly) {
        try {
            queryVector = await embedText(cleanQuery);
            if (!Array.isArray(queryVector) || !queryVector.length) queryVector = null;
            else embeddingBackend = getLastBackend();
        } catch (error) {
            console.warn(`[Vector Search] Embedding failed: ${error.message}`);
            queryVector = null;
        }
    }

    let vectorHits = [];
    let vectorBackend = 'none';

    if (queryVector) {
        // 1) Milvus ANN（主路径）
        if (requireMilvus() && state.milvusReady) {
            try {
                const milvusHits = await milvusVectorSearch(queryVector, {
                    limit: candidateLimit,
                    sourceTypes,
                    includeHistorical,
                });
                if (Array.isArray(milvusHits) && milvusHits.length) {
                    vectorHits = milvusHits.map((item) => ({ ...item, retrieval_engine: 'milvus' }));
                    vectorBackend = 'milvus';
                }
            } catch (error) {
                console.warn(`[Vector Search] Milvus failed: ${error.message}`);
            }
        }

        // 2) PG vector_documents 余弦（Milvus 未就绪或无命中时）
        if (!vectorHits.length) {
            const pgHits = await sqliteVectorSearch(cleanQuery, queryVector, {
                limit: candidateLimit,
                sourceTypes,
                includeHistorical,
            });
            if (Array.isArray(pgHits) && pgHits.length) {
                vectorHits = pgHits.map((item) => ({ ...item, retrieval_engine: 'pg_vector' }));
                vectorBackend = 'pg_vector';
            }
        }
    }

    // 3) 关键词融合（始终并入，提升专有名词召回）
    const keywordResults = (await keywordSearch(cleanQuery, {
        limit: candidateLimit,
        sourceTypes,
        includeHistorical,
    })).map((item) => ({ ...item, retrieval_engine: item.retrieval_engine || 'keyword' }));

    let results = vectorHits.length
        ? mergeSearchResults(vectorHits, keywordResults, candidateLimit)
        : keywordResults;

    if (!results.length) {
        console.warn(`[Vector Search] empty hits query="${cleanQuery.slice(0, 40)}" embed=${embeddingBackend} vector=${vectorBackend}`);
        return [];
    }

    const reranked = rerank && !keywordOnly
        ? await rerankDocuments(cleanQuery, results, limit)
        : results.slice(0, limit);
    const final = reranked.slice(0, limit).map((item) => ({
        ...item,
        retrieval_engine: item.retrieval_engine || vectorBackend || 'keyword',
        embedding_backend: embeddingBackend,
    }));

    if (process.env.RAG_METRICS === '1' || process.env.RAG_METRICS === 'true') {
        console.log('[RAG-Search]', JSON.stringify({
            query: cleanQuery.slice(0, 80),
            embedding_backend: embeddingBackend,
            vector_backend: vectorBackend,
            milvus_ready: state.milvusReady,
            keyword_only: keywordOnly,
            hits: final.length,
        }));
    }
    return final;
};

// 知识库检索 rerank 阈值：只对 rerank_score 生效；rerank 不可用时（无 rerank_score）不过滤
// 设为 0 可关闭阈值过滤；未配置环境变量时默认 0.6
const DEFAULT_SCORE_THRESHOLD = (() => {
    const v = Number(process.env.KNOWLEDGE_SCORE_THRESHOLD);
    return Number.isFinite(v) ? v : 0.6;
})();

// 多 query 拆分检索：对每个子 query 独立召回 + rerank，再按 content_hash 去重融合
// 适用于"合同类型 + 审查点 + 合同正文段落"这类多意图场景，避免长文本稀释聚焦词信号
const searchVectorDocumentsMulti = async (queries, {
    limit = 8,
    sourceTypes = [],
    rerank = true,
    scoreThreshold = DEFAULT_SCORE_THRESHOLD,
    perQueryLimit = 2,
    includeHistorical = false,
} = {}) => {
    const cleanQueries = (Array.isArray(queries) ? queries : [queries])
        .map((q) => normalizeText(q))
        .filter((q) => q && q.length >= 5);
    if (cleanQueries.length === 0) return [];
    const filterByThreshold = (items) => {
        if (scoreThreshold <= 0) return items;
        return items.filter((item) => {
            if (item.rerank_score === undefined || item.rerank_score === null) return true;
            return item.rerank_score >= scoreThreshold;
        });
    };

    if (cleanQueries.length === 1) {
        const results = await searchVectorDocuments(cleanQueries[0], { limit, sourceTypes, rerank, includeHistorical });
        return filterByThreshold(results).slice(0, limit);
    }

    // 多 query 时每条少取一些，靠融合补足；perQueryLimit 由调用方按通道配置
    const perQueryResults = await Promise.all(
        cleanQueries.map((q) => searchVectorDocuments(q, {
            limit: perQueryLimit,
            sourceTypes,
            rerank,
            includeHistorical,
        })),
    );
    // 硬阈值融合：只保留 above-threshold，按分数去重截断；不足也不回填低分项
    const getKey = (item) => item.content_hash || item.source_id || item.id;
    const scoreOf = (item) => item.rerank_score ?? item.score ?? 0;
    const sortByScoreDesc = (a, b) => scoreOf(b) - scoreOf(a);
    const isAboveThreshold = (item) => {
        if (scoreThreshold <= 0) return true;
        if (item.rerank_score === undefined || item.rerank_score === null) return true;
        return item.rerank_score >= scoreThreshold;
    };

    const merged = new Map();
    perQueryResults.forEach((results, queryIndex) => {
        results.filter(isAboveThreshold).forEach((item) => {
            const key = getKey(item) || `${queryIndex}-${scoreOf(item)}`;
            const existing = merged.get(key);
            if (!existing || scoreOf(item) > scoreOf(existing)) {
                merged.set(key, { ...item, matched_query_index: queryIndex });
            }
        });
    });
    return [...merged.values()].sort(sortByScoreDesc).slice(0, limit);
};

module.exports = {
    ensureVectorStore,
    seedLawsFromMarkdown,
    seedCasesFromJson,
    searchVectorDocuments,
    searchVectorDocumentsMulti,
    listKnowledgeDocuments,
    importKnowledgeEntries,
    deleteKnowledgeDocuments,
    clearAllVectorDocuments,
    syncAllVectorDocuments,
    splitTextIntoChunks,
    splitIntoParagraphs,
    splitIntoParagraphGroups,
};
