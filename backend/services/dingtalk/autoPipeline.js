/**
 * DingTalk intake → pre-analyze → full analysis pipeline.
 */
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const unidecode = require('unidecode');
const db = require('../../database');
const { extractTextFromFile, wrapContractContent } = require('../contractAnalysis/fileExtraction');
const { callJsonLLM } = require('../contractAnalysis/llm');
const { matchTemplate } = require('../reviewTemplates');
const { createAnalysisJob } = require('../contractAnalysis/analysisJob');
const { runAnalysisInBackground } = require('../contractAnalysis/backgroundAnalysis');
const { resolveReviewPerspective } = require('../contractAnalysis/perspective');

const ALLOWED_EXTENSIONS = ['.docx', '.pdf'];

/** Fix UTF-8 filenames that arrived as latin1 mojibake (common with Cyrillic/CJK). */
function decodeUploadFilename(name) {
  const raw = String(name || '');
  if (!raw) return 'contract.docx';
  try {
    const fixed = Buffer.from(raw, 'latin1').toString('utf8');
    if (
      (fixed.includes('�') === false)
      && ( /[\u0400-\u04FF]/.test(fixed) || /[\u4e00-\u9fff]/.test(fixed) )
      && fixed.length >= raw.length / 3
    ) {
      return fixed;
    }
  } catch { /* ignore */ }
  return raw;
}

async function ensureDingTalkUser(staffId, staffNick = '') {
  const fingerprint = `dingtalk:${staffId || 'unknown'}`;
  let user = await db('users').where({ fingerprint_id: fingerprint }).first();
  if (user) return user.id;
  const [row] = await db('users')
    .insert({ fingerprint_id: fingerprint })
    .returning(['id']);
  const id = typeof row === 'object' ? row.id : row;
  return id;
}

async function runPreAnalyzeForContract(contractId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new Error('Contract not found');
  const plainText = await extractTextFromFile(contract.storage_path);
  const prompt = `你是专业法务助手。阅读合同后只输出 JSON：
{
  "contract_type": "合同类型",
  "potential_parties": ["可选审查立场"],
  "suggested_review_points": ["关键审查点"],
  "suggested_core_purposes": ["核心审查目的"]
}

要求：
- 审查点和目的必须具体，优先贴合合同类型。
- 不输出自然语言解释。

合同原文：
---
${wrapContractContent(plainText)}
---`;
  const analysisResult = await callJsonLLM(prompt);
  const matchResult = await matchTemplate(analysisResult.contract_type, plainText);
  const template = Array.isArray(matchResult) ? (matchResult[0]?.template || null) : matchResult;
  analysisResult.template_id = template?.id || 'general';
  analysisResult.template_name = template?.name || '通用合同审查模板';
  analysisResult.suggested_template_id = template?.id || 'general';
  analysisResult.suggested_review_points = Array.from(new Set([
    ...(template?.review_points || []),
    ...(analysisResult.suggested_review_points || []),
  ]));
  analysisResult.suggested_core_purposes = Array.from(new Set([
    ...(template?.core_purposes || []),
    ...(analysisResult.suggested_core_purposes || []),
  ]));
  analysisResult.reviewPoints = analysisResult.suggested_review_points;
  analysisResult.core_purposes = analysisResult.suggested_core_purposes;

  await db('contracts').where({ id: contractId }).update({
    status: 'PreAnalyzed',
    analysis_status: 'pre_analyzed',
    pre_analysis_data: JSON.stringify(analysisResult),
  });
  return analysisResult;
}

/**
 * Persist uploaded file + start auto pipeline asynchronously.
 */
async function intakeAndStartPipeline({
  fileBuffer,
  originalFilename: originalFilenameRaw,
  staffId,
  staffNick,
  conversationId,
  msgId,
  sessionWebhook,
  perspective,
  contractTypeHint,
}) {
  const originalFilename = decodeUploadFilename(originalFilenameRaw);
  const ext = path.extname(originalFilename || '').toLowerCase()
    || path.extname(originalFilenameRaw || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const err = new Error(`UNSUPPORTED_FILE_TYPE:${ext}`);
    err.code = 'UNSUPPORTED_FILE_TYPE';
    throw err;
  }

  if (msgId) {
    const existing = await db('contracts').where({ external_id: String(msgId) }).first();
    if (existing) {
      return {
        contractId: existing.id,
        duplicate: true,
        status: existing.status,
        confirmation_status: existing.confirmation_status,
      };
    }
  }

  const userId = await ensureDingTalkUser(staffId, staffNick);
  const uploadDir = path.join(__dirname, '..', '..', 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const safeName = unidecode(originalFilename || `contract${ext}`).replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const storageName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`;
  const storagePath = path.join(uploadDir, storageName);
  fs.writeFileSync(storagePath, fileBuffer);

  const documentKey = uuidv4();
  const sourceMeta = {
    staff_id: staffId || '',
    staff_nick: staffNick || '',
    conversation_id: conversationId || '',
    session_webhook: sessionWebhook || '',
    msg_id: msgId || '',
    contract_type_hint: contractTypeHint || '',
  };

  const [inserted] = await db('contracts').insert({
    user_id: userId,
    original_filename: originalFilename || storageName,
    storage_path: storagePath,
    document_key: documentKey,
    status: 'Uploaded',
    source: 'dingtalk',
    external_id: msgId ? String(msgId) : null,
    source_meta: JSON.stringify(sourceMeta),
    confirmation_status: 'none',
  }).returning(['id', 'original_filename', 'user_id']);

  const contract = inserted?.id
    ? inserted
    : await db('contracts').where({ document_key: documentKey }).first();

  // Fire-and-forget pipeline
  setImmediate(() => {
    runDingTalkPipeline(contract.id, userId, {
      perspective: perspective || '我方',
      contractTypeHint,
    }).catch((err) => {
      console.error(`[DingTalk] pipeline failed for contract ${contract.id}:`, err);
    });
  });

  return {
    contractId: contract.id,
    duplicate: false,
    status: 'Uploaded',
    userId,
  };
}

async function runDingTalkPipeline(contractId, userId, { perspective, contractTypeHint } = {}) {
  let pre = await runPreAnalyzeForContract(contractId);
  if (contractTypeHint && !pre.contract_type) {
    pre.contract_type = contractTypeHint;
  }
  if (contractTypeHint && String(pre.contract_type || '').includes('通用')) {
    pre.contract_type = contractTypeHint;
  }

  const parties = Array.isArray(pre.potential_parties) ? pre.potential_parties : [];
  const userPerspective = resolveReviewPerspective(
    perspective,
    parties,
    parties[0] || '我方',
  );

  createAnalysisJob(contractId, userId);
  await db('contracts').where({ id: contractId }).update({
    analysis_status: 'analyzing',
    perspective: userPerspective,
    updated_at: db.fn.now(),
  });

  await runAnalysisInBackground(contractId, userId, userPerspective, pre);
}

module.exports = {
  ensureDingTalkUser,
  intakeAndStartPipeline,
  runPreAnalyzeForContract,
  runDingTalkPipeline,
  ALLOWED_EXTENSIONS,
};
