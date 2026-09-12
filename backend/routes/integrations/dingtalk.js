/**
 * DingTalk intake + human confirmation APIs (internal token auth).
 */
const express = require('express');
const multer = require('multer');
const { intakeAndStartPipeline } = require('../../services/dingtalk/autoPipeline');
const { applyHumanConfirmation } = require('../../services/dingtalk/confirmation');
const { getRequestUserId } = require('../../services/contractAnalysis/auth');
const db = require('../../database');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function requireInternalToken(req, res) {
  const expected = process.env.DINGTALK_INTAKE_TOKEN || '';
  const token = req.header('X-Internal-Token') || req.header('x-internal-token') || '';
  if (!expected) {
    // Dev fallback: allow if explicitly disabled
    if (process.env.DINGTALK_INTAKE_ALLOW_OPEN === 'true') return true;
    res.status(503).json({ error: 'DINGTALK_INTAKE_TOKEN is not configured' });
    return false;
  }
  if (token !== expected) {
    res.status(401).json({ error: 'Invalid internal token' });
    return false;
  }
  return true;
}

router.post('/intake', upload.single('file'), async (req, res) => {
  if (!requireInternalToken(req, res)) return;
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const result = await intakeAndStartPipeline({
      fileBuffer: req.file.buffer,
      originalFilename: req.file.originalname || req.body.filename || 'contract.docx',
      staffId: req.body.staff_id || '',
      staffNick: req.body.staff_nick || '',
      conversationId: req.body.conversation_id || '',
      msgId: req.body.msg_id || '',
      sessionWebhook: req.body.session_webhook || '',
      perspective: req.body.perspective || '',
      contractTypeHint: req.body.contract_type_hint || '',
    });
    res.status(result.duplicate ? 200 : 202).json({
      ok: true,
      ...result,
      message: result.duplicate
        ? 'Duplicate message; returning existing contract'
        : 'Accepted; auto pipeline started',
    });
  } catch (error) {
    if (error.code === 'UNSUPPORTED_FILE_TYPE' || String(error.message).startsWith('UNSUPPORTED_FILE_TYPE')) {
      return res.status(400).json({ error: '仅支持 .docx 和 .pdf', code: 'UNSUPPORTED_FILE_TYPE' });
    }
    console.error('[DingTalk] intake failed:', error);
    res.status(500).json({ error: error.message || 'intake failed' });
  }
});

router.post('/confirm', async (req, res) => {
  const internalOk = (() => {
    const expected = process.env.DINGTALK_INTAKE_TOKEN || '';
    const token = req.header('X-Internal-Token') || '';
    if (expected && token === expected) return true;
    if (!expected && process.env.DINGTALK_INTAKE_ALLOW_OPEN === 'true') return true;
    return false;
  })();
  const userId = getRequestUserId(req);

  if (!internalOk && !userId) {
    return res.status(401).json({ error: 'Auth required (internal token or X-User-ID)' });
  }

  try {
    const contractId = Number(req.body.contract_id || req.body.contractId);
    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: 'contract_id required' });
    }

    if (!internalOk && userId) {
      const contract = await db('contracts').where({ id: contractId }).first();
      if (!contract) return res.status(404).json({ error: 'Contract not found' });
      if (contract.user_id !== userId && contract.source !== 'dingtalk') {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const result = await applyHumanConfirmation({
      contractId,
      action: req.body.action,
      actor: req.body.staff_id || req.body.actor || (userId ? `user:${userId}` : 'unknown'),
      reason: req.body.reason || '',
    });
    res.json(result);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[DingTalk] confirm failed:', error);
    res.status(status).json({ error: error.message || 'confirm failed' });
  }
});

module.exports = router;
