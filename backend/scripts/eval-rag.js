/**
 * @file scripts/eval-rag.js
 * @brief RAG 评测：Recall@k / MRR / 延迟，基于 tests/fixtures/rag/golden.json
 *
 * 用法：
 *   npm run eval:rag
 *   npm run eval:rag -- --k=5,10 --limit=10
 *   npm run eval:rag -- --case=labor-probation-6m
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { getRelevantKnowledge } = require('../services/contractAnalysis/knowledge');
const { searchVectorDocumentsMulti } = require('../services/vectorStore');
const { getLastBackend, probeEmbedding, probeRerank, getConfig } = require('../services/embeddingClient');

const GOLDEN_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'rag', 'golden.json');
const RESULTS_DIR = path.join(__dirname, '..', 'evals', 'results');
const REPORT_PATH = path.join(RESULTS_DIR, 'rag-metrics.md');
const JSON_PATH = path.join(RESULTS_DIR, 'rag-metrics.json');

const parseArgs = (argv) => {
    const args = { k: [5, 10], limit: 10, caseId: null, json: false };
    for (const raw of argv) {
        if (raw.startsWith('--k=')) {
            args.k = raw.slice(4).split(',').map((n) => Number(n)).filter((n) => n > 0);
        } else if (raw.startsWith('--limit=')) {
            args.limit = Math.max(1, Number(raw.slice(8)) || 10);
        } else if (raw.startsWith('--case=')) {
            args.caseId = raw.slice(7);
        } else if (raw === '--json') {
            args.json = true;
        }
    }
    if (!args.k.length) args.k = [5, 10];
    return args;
};

const hitMatches = (hit, gold) => {
    const title = String(hit.law || hit.title || '');
    const clause = String(hit.clause || hit.clause_id || '');
    const sourceId = String(hit.source_id || hit.metadata?.source_id || '');
    const hash = String(hit.content_hash || hit.metadata?.content_hash || '');

    if (gold.content_hash && hash && gold.content_hash === hash) return true;
    if (gold.source_id && sourceId && gold.source_id === sourceId) return true;
    if (gold.clause_id && clause.includes(gold.clause_id)) {
        if (!gold.title_contains) return true;
        return title.includes(gold.title_contains);
    }
    return false;
};

const recallAtK = (hits, relevant, k) => {
    if (!relevant.length) return null;
    const top = hits.slice(0, k);
    let found = 0;
    for (const g of relevant) {
        if (top.some((h) => hitMatches(h, g))) found += 1;
    }
    return found / relevant.length;
};

const mrr = (hits, relevant) => {
    if (!relevant.length) return null;
    let best = Infinity;
    for (const g of relevant) {
        const idx = hits.findIndex((h) => hitMatches(h, g));
        if (idx >= 0) best = Math.min(best, idx + 1);
    }
    return best === Infinity ? 0 : 1 / best;
};

const percentile = (values, p) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
};

const runCase = async (item, limit) => {
    const started = Date.now();
    let hits = [];
    if (item.mode === 'searchMulti') {
        const queries = item.queries || [item.query].filter(Boolean);
        const raw = await searchVectorDocumentsMulti(queries, {
            limit,
            sourceTypes: ['law', 'case', 'rule', 'guide'],
            rerank: true,
        });
        hits = raw.map((r) => ({
            law: r.title,
            clause: r.clause_id || r.source_id,
            content: r.content,
            score: r.rerank_score ?? r.score,
            source_id: r.source_id,
            content_hash: r.content_hash,
            title: r.title,
            clause_id: r.clause_id,
        }));
    } else {
        hits = await getRelevantKnowledge(item.query, limit);
    }
    const latencyMs = Date.now() - started;
    return { hits, latencyMs };
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(GOLDEN_PATH)) {
        console.error(`Golden file missing: ${GOLDEN_PATH}`);
        process.exit(1);
    }
    let cases = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    if (args.caseId) {
        cases = cases.filter((c) => c.id === args.caseId);
        if (!cases.length) {
            console.error(`Case not found: ${args.caseId}`);
            process.exit(1);
        }
    }

    const embProbe = await probeEmbedding();
    const rerankProbe = await probeRerank();
    const cfg = getConfig();
    console.log(`[RAG backend] embedding=${embProbe.ok ? 'online' : 'FAIL'} model=${cfg.model} | rerank=${rerankProbe.ok ? 'online' : 'FAIL'} model=${cfg.rerankModel}`);
    if (!embProbe.ok) {
        console.warn(`[RAG backend] embedding probe: ${embProbe.error}`);
        if (!cfg.allowHash) {
            console.error('Embedding 未就绪且未开启 hash 回退。请配置硅基流动 EMBEDDING_* 后重试。');
            process.exit(1);
        }
    }

    const maxK = Math.max(...args.k, args.limit);
    const rows = [];
    for (const item of cases) {
        process.stdout.write(`Evaluating ${item.id} ... `);
        try {
            const { hits, latencyMs } = await runCase(item, maxK);
            const metrics = {};
            for (const k of args.k) {
                metrics[`recall@${k}`] = recallAtK(hits, item.relevant, k);
            }
            metrics.mrr = mrr(hits, item.relevant);
            metrics.latency_ms = latencyMs;
            metrics.hit_count = hits.length;
            metrics.embedding_backend = getLastBackend();
            metrics.top = hits.slice(0, 3).map((h) => `${h.law || ''} ${h.clause || ''}`.trim());
            rows.push({ id: item.id, description: item.description, ok: true, ...metrics });
            console.log(`ok  recall@10=${(metrics['recall@10'] ?? metrics[`recall@${args.k[0]}`]).toFixed(2)}  ${latencyMs}ms  [${getLastBackend()}]`);
        } catch (error) {
            rows.push({ id: item.id, description: item.description, ok: false, error: error.message });
            console.log(`FAIL  ${error.message}`);
        }
    }

    const okRows = rows.filter((r) => r.ok);
    const summary = {
        cases: rows.length,
        succeeded: okRows.length,
        failed: rows.length - okRows.length,
        latency_p50_ms: percentile(okRows.map((r) => r.latency_ms), 50),
        latency_p95_ms: percentile(okRows.map((r) => r.latency_ms), 95),
        embedding_probe: embProbe,
        rerank_probe: rerankProbe,
        embedding_model: cfg.model,
        rerank_model: cfg.rerankModel,
        embedding_base_url: cfg.baseUrl,
        evaluated_at: new Date().toISOString(),
    };
    for (const k of args.k) {
        const key = `recall@${k}`;
        const vals = okRows.map((r) => r[key]).filter((v) => typeof v === 'number');
        summary[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    const mrrVals = okRows.map((r) => r.mrr).filter((v) => typeof v === 'number');
    summary.mrr = mrrVals.length ? mrrVals.reduce((a, b) => a + b, 0) / mrrVals.length : null;

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(JSON_PATH, JSON.stringify({ summary, rows }, null, 2), 'utf8');
    const md = [
        '# RAG Evaluation Metrics',
        '',
        `Generated: ${summary.evaluated_at}`,
        '',
        '## Stack',
        '',
        `- Embedding: \`${summary.embedding_model}\` @ \`${summary.embedding_base_url || '(unset)'}\` → ${embProbe.ok ? 'online OK' : `FAIL (${embProbe.error})`}`,
        `- Rerank: \`${summary.rerank_model}\` → ${rerankProbe.ok ? 'online OK' : `FAIL (${rerankProbe.error})`}`,
        `- Golden set: \`${path.relative(path.join(__dirname, '..'), GOLDEN_PATH)}\` (${summary.cases} cases)`,
        '',
        '## Summary (resume-ready)',
        '',
        '| Metric | Value |',
        '|--------|-------|',
        ...args.k.map((k) => `| Recall@${k} | ${summary[`recall@${k}`] == null ? 'n/a' : summary[`recall@${k}`].toFixed(3)} |`),
        `| MRR | ${summary.mrr == null ? 'n/a' : summary.mrr.toFixed(3)} |`,
        `| Latency P50 | ${summary.latency_p50_ms} ms |`,
        `| Latency P95 | ${summary.latency_p95_ms} ms |`,
        `| Cases passed | ${summary.succeeded}/${summary.cases} |`,
        '',
        '## Per-case',
        '',
        '| ID | Recall@10 | MRR | Latency(ms) | Backend |',
        '|----|-----------|-----|-------------|---------|',
        ...rows.map((r) => {
            if (!r.ok) return `| ${r.id} | FAIL | - | - | ${r.error || ''} |`;
            return `| ${r.id} | ${(r['recall@10'] ?? 0).toFixed(2)} | ${(r.mrr ?? 0).toFixed(2)} | ${r.latency_ms} | ${r.embedding_backend} |`;
        }),
        '',
        '## Resume bullet (edit numbers after real embed+reembed)',
        '',
        `> Built contract-review RAG (BGE embedding + reranker + dual-channel retrieve) on ${summary.cases}-case golden set: Recall@10=${summary['recall@10'] == null ? 'n/a' : summary['recall@10'].toFixed(2)}, MRR=${summary.mrr == null ? 'n/a' : summary.mrr.toFixed(2)}, P95 latency=${summary.latency_p95_ms}ms.`,
        '',
    ].join('\n');
    fs.writeFileSync(REPORT_PATH, md, 'utf8');

    if (args.json) {
        console.log(JSON.stringify({ summary, rows }, null, 2));
    } else {
        console.log('\n=== RAG Eval Summary ===');
        console.log(`cases: ${summary.succeeded}/${summary.cases}`);
        for (const k of args.k) {
            const v = summary[`recall@${k}`];
            console.log(`Recall@${k}: ${v == null ? 'n/a' : v.toFixed(3)}`);
        }
        console.log(`MRR: ${summary.mrr == null ? 'n/a' : summary.mrr.toFixed(3)}`);
        console.log(`Latency P50: ${summary.latency_p50_ms}ms  P95: ${summary.latency_p95_ms}ms`);
        console.log(`Report: ${REPORT_PATH}`);
    }

    process.exit(summary.failed ? 1 : 0);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
