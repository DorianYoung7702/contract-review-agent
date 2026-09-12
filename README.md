# Contract Review Agent · 合同审查智能体

面向企业合同审查的 AI 应用，覆盖文件接入、审查立场识别、法律知识检索、风险分析、规则审批、红线修订与人工确认。将合同理解、规则判断和文档操作组织为可追踪的业务流程，辅助法务与业务人员完成审查和修改。

**维护者：杨朕骁 / [DorianYoung7702](https://github.com/DorianYoung7702)**  
**工程方向：Agent Harness · RAG · 规则决策 · Human-in-the-loop · 文档自动化**

本仓库是我在开源合同审查应用基础上持续开发的项目版本，重点扩展可配置审批规则、审查立场处理、DOCX 红线工作流、钉钉接入、审计记录与检索评测。上游来源和许可证见文末。

## 业务流程

```mermaid
flowchart TD
    A[Web 上传 DOCX / 文本型 PDF] --> C[预分析：合同类型、主体与审查立场]
    B[钉钉文件接入] --> C
    C --> D[匹配审查模板与 Playbook]
    D --> E[法条 / 案例检索、主体核验与硬性规则检查]
    E --> F[LLM 生成结构化风险与修改建议]
    F --> G[审批引擎：PASS / MANUAL / REJECT]
    G --> H[审查报告、决策记录与审计事件]
    H --> I[人工确认 / 人工改判]
    H --> J[DOCX 红线稿]
    J --> K[标记对方确认]
    K --> L[采纳修改并生成正式版]
```

审批确认和红线稿确认分别维护状态：前者记录审查结论的处理结果，后者控制合同修改稿的采纳流程。

## Agent Harness 工程设计

系统采用代码编排的领域工作流。模型负责合同理解与建议生成，业务代码负责规则计算、任务进度、文档写入、确认流程和结果持久化。

| 工程设计 | 当前实现 | 代码入口 |
| --- | --- | --- |
| 任务生命周期 | 按文本提取、检索、核验、规则检查、模型审查等阶段追踪任务，通过 Socket.IO 推送进度，并保存业务状态与分析结果 | [analysisJob.js](backend/services/contractAnalysis/analysisJob.js)、[backgroundAnalysis.js](backend/services/contractAnalysis/backgroundAnalysis.js) |
| 可配置决策策略 | 按合同类型匹配 Playbook，结合禁止条款、风险等级、缺失条款和金额阈值输出 `PASS / MANUAL / REJECT`，记录规则 ID、原因码与策略版本 | [playbook/](backend/services/playbook/)、[approvalEngine.js](backend/services/approvalEngine.js) |
| 审查上下文约束 | 优先采用用户明确选择的审查立场，支持按我方组织匹配合同主体；结合独立的金额算术检查，补充模型审查结果 | [perspective.js](backend/services/contractAnalysis/perspective.js)、[amountArithmeticCheck.js](backend/services/amountArithmeticCheck.js) |
| 文档写入保护 | 仅将同时包含原文与替换文本的建议转为红线；先在临时副本生成，定位全部失败时不覆盖当前合同；记录成功与失败数量 | [redlineWorkflow.js](backend/services/contractAnalysis/redlineWorkflow.js)、[docxEdit.js](backend/services/contractAnalysis/docxEdit.js) |
| 人工确认与版本管理 | 红线稿进入 `awaiting_counterpart` 状态后，默认禁止直接采纳；标记确认后生成正式版，并保存版本快照 | [redlineWorkflow.js](backend/services/contractAnalysis/redlineWorkflow.js)、[version.js](backend/services/contractAnalysis/version.js) |
| 外部接入与操作留痕 | 钉钉 Worker 接收文件和确认指令，后端执行审查流程；按消息 ID 检查重复接入，记录决策、确认及人工改判事件 | [dingtalk-worker/](dingtalk-worker/)、[dingtalk/](backend/services/dingtalk/)、[auditService.js](backend/services/auditService.js) |
| 模型容错与检索评测 | LLM 调用支持超时、有限重试与退避；Chat、Embedding、Rerank 分别配置，并使用固定样本评估检索召回、排序和时延 | [llmClient.js](backend/services/llmClient.js)、[eval-rag.js](backend/scripts/eval-rag.js) |

## 功能范围

- **合同审查**：DOCX / 文本型 PDF 上传、类型与主体识别、风险分级、条款建议、专项与增量审查、审查历史和报告导出。
- **文档协作**：OnlyOffice 在线审阅、条款定位、批注、DOCX 红线稿、修改采纳及版本对比。
- **知识增强**：法律法规、裁判文书、审查规则与行业标准条款管理，结合合同内容和审查维度检索依据。
- **辅助分析**：合同上下文问答、谈判建议、企业主体信息查询及印章分析；相关能力依赖对应模型或外部服务配置。
- **企业接入**：可选钉钉文件接入、结果通知，以及 `确认 #id` / `驳回 #id` 指令处理。

## 技术栈

| 层次 | 技术 |
| --- | --- |
| 前端 | Vue 3、Vite、Element Plus、Tailwind CSS、OnlyOffice |
| 后端与数据 | Node.js、Express、Knex、PostgreSQL、Socket.IO |
| 模型与检索 | OpenAI 兼容接口、独立 Embedding / Rerank 客户端、Milvus 或 PostgreSQL 存储检索 |
| 接入与运行 | Python 钉钉 Worker、Docker Compose、Windows 启动脚本 |

检索模式由 `VECTOR_STORE` 控制：

| 模式 | 行为 |
| --- | --- |
| `keyword` | 使用关键词与 n-gram 检索，检索过程不调用 Embedding / Rerank / Milvus |
| `pg` | 在 PostgreSQL 中存储向量，应用侧计算相似度，并结合关键词召回 |
| `milvus` | 使用 Milvus 向量召回，并结合关键词检索与重排 |

## 本地启动

以下为 **Windows PowerShell** 示例，统一使用前端 `8080`、后端 `3001`、PostgreSQL `5434`、OnlyOffice `8082`。需要 Node.js / npm 和 Docker Compose；钉钉 Worker 可按需启用。

### 1. 获取代码并准备配置

私有仓库需要具备访问权限的 GitHub 账号。

```powershell
git clone https://github.com/DorianYoung7702/contract-review-agent.git
Set-Location contract-review-agent
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env.development
```

在 `backend/.env` 中填写可用的 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL`，并调整以下配置。示例以关键词检索启动，向量模式可在后续配置。

```dotenv
PORT=3001
DATABASE_URL=postgres://contract_review:contract_review@127.0.0.1:5434/contract_review
POSTGRES_PORT=5434
VECTOR_STORE=keyword

ONLYOFFICE_URL=http://localhost:8082
ONLYOFFICE_JWT_SECRET=替换为你自己的随机密钥
APP_HOST=http://localhost:3001
BACKEND_URL_FOR_DOCKER=http://host.docker.internal:3001
FRONTEND_URL=http://localhost:8080
DEFAULT_REVIEW_ORGANIZATION=填写我方企业名称
```

在 `frontend/.env.development` 中设置：

```dotenv
VITE_APP_BACKEND_API_URL=http://localhost:3001
VITE_APP_ONLYOFFICE_URL=http://localhost:8082/
```

后端地址不包含 `/api`，前端会自动拼接。OnlyOffice 的浏览器访问地址与容器回调后端地址分别配置。

### 2. 启动基础服务

在仓库根目录执行。显式加载 `backend/.env`，使 OnlyOffice 容器与后端使用同一 JWT 密钥。

```powershell
docker compose --env-file backend/.env up -d postgres onlyoffice
```

本地 Compose 管理基础服务；前后端分别通过下面的命令启动。

### 3. 启动后端

新开终端，进入仓库的 `backend` 目录：

```powershell
npm ci
npm run dev
```

后端启动时初始化数据库表、模板与标准条款，并在后台导入法律和案例知识。入口地址为 `http://localhost:3001`，浏览器页面入口仍为前端地址。

### 4. 启动前端

新开终端，进入仓库的 `frontend` 目录：

```powershell
npm ci
npm run dev
```

打开 `http://localhost:8080`，上传一份 DOCX 或可复制文本的 PDF，选择审查立场后开始分析。

### 5. 可选：向量检索与钉钉

启用向量检索时，在 `backend/.env` 中将 `VECTOR_STORE` 改为 `pg` 或 `milvus`，分别填写 `EMBEDDING_*` 与 `RERANK_*`。使用 Milvus 时，在仓库根目录执行：

```powershell
docker compose --env-file backend/.env up -d milvus
```

更换向量模型、维度或从 hash 回退向量切换到真实 Embedding 后，在 `backend` 目录重建向量并评测：

```powershell
npm run reembed:rag
npm run eval:rag
```

进行语义检索效果评测时设置 `EMBEDDING_ALLOW_HASH_FALLBACK=false`，并确认实际使用的 Embedding / Rerank 服务，避免将回退路径计为在线模型效果。

钉钉配置见 [Worker 说明](dingtalk-worker/README.md)。从 `dingtalk-worker/.env.example` 复制配置后填写应用凭据，并将其中的 `DINGTALK_INTAKE_TOKEN` 与 `backend/.env` 保持一致，再在根目录执行：

```powershell
docker compose --env-file backend/.env --profile dingtalk up -d dingtalk-worker
```

## 验证与评测

后端已有审批规则、审查立场、金额计算、企业信息补全、DOCX 红线、钉钉确认和检索模式的测试文件。在 `backend` 目录执行：

```powershell
npm test
npm run eval:rag -- --k=5,10 --limit=10
```

RAG 评测基于 [固定样本集](backend/tests/fixtures/rag/golden.json)，输出 Recall@5、Recall@10、MRR 和时延指标，报告保存到 `backend/evals/results/`。效果数据应同时记录样本集、模型、检索模式和运行环境。

前端构建验证在 `frontend` 目录执行：

```powershell
npm run build
```

## 目录结构

```text
backend/
  routes/                 合同、知识库、模板、审批与外部接入 API
  services/
    contractAnalysis/     审查编排、进度、立场、文档编辑与版本流程
    playbook/             审批策略加载与匹配
    dingtalk/             文件接入、审查通知与人工确认
    vectorStore/          知识导入、向量与关键词检索
    approvalEngine.js     审批规则计算
    auditService.js       审计事件读写
  data/                   法律、案例、规则、模板与 Playbook
  tests/                  测试及固定评测样本
  scripts/                RAG 评测与向量重建
frontend/                 Vue 审查工作台
dingtalk-worker/           钉钉消息接入服务
scripts/                  Windows 本地运行脚本
docker-compose.yml        基础服务与可选 Worker 配置
```

## 当前实现边界

- 文件审查支持 DOCX 和文本型 PDF。扫描件 PDF 会被识别并提示转换；正文红线生成仅支持 DOCX。
- 分析任务使用进程内任务表，业务状态和结果写入数据库；当前实现未提供跨进程任务队列和进程崩溃后的自动续跑。
- 本 README 描述仓库实现与运行方法。真实合同效果、外部服务联通情况及生产身份权限，需要在具体部署环境中验证。

本地 `.env`、上传合同、数据库、日志和浏览器配置不纳入源码版本管理。`scripts/Start-ContractService.ps1` 使用固定本机路径及容器名称，迁移环境时需先调整。

## 来源与许可证

基于 [xiaodingfeng/contract-review](https://github.com/xiaodingfeng/contract-review) 二次开发，本仓库包含面向业务流程和工程可靠性的扩展。

项目采用 [MIT License](LICENSE)，保留原作者 Xiaodingfeng 的版权声明。
