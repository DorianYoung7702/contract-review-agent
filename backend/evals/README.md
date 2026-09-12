# RAG 落地与评测

## 问题根因

DeepSeek 只提供 Chat，**没有** `/embeddings`、`/rerank`。  
旧逻辑把 `LLM_BASE_URL` 当成向量服务 → HTTP 404 → 退回 hash 向量（不是真 RAG）。

## 正确配置（硅基流动）

1. 打开 [硅基流动](https://cloud.siliconflow.cn/) 创建 API Key  
2. 填入 `backend/.env` 或首页「RAG 向量」配置：

```env
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_API_KEY=sk-xxx
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIM=1024
RERANK_BASE_URL=https://api.siliconflow.cn/v1
RERANK_API_KEY=sk-xxx
RERANK_MODEL=BAAI/bge-reranker-v2-m3
EMBEDDING_ALLOW_HASH_FALLBACK=false
```

3. **重嵌入知识库**（必须，否则库内仍是旧 hash 向量）：

```bash
cd backend
npm run reembed:rag
# 可先小样本：npm run reembed:rag -- --limit=100
```

4. **跑测评集 → 简历指标**：

```bash
npm run eval:rag
```

产物：
- `evals/results/rag-metrics.md`（含简历 bullet）
- `evals/results/rag-metrics.json`

金标：`tests/fixtures/rag/golden.json`（可继续扩到 50+）

## 指标

| 指标 | 用途 |
|------|------|
| Recall@5 / @10 | 检索召回 |
| MRR | 首条正确法条排名 |
| Latency P50/P95 | 检索时延 |

## 链路（真 RAG）

合同/审查点 → **Embedding 检索** → **Rerank** → 法条上下文注入 LLM → 生成审查结论（Retrieve → Augment → Generate）
