/**
 * DingTalk sessionWebhook / private message notify helpers.
 */
const axios = require('axios');

let tokenCache = { token: '', expiresAt: 0 };

function parseSourceMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function getAccessToken() {
  const now = Date.now() / 1000;
  if (tokenCache.token && tokenCache.expiresAt > now + 60) return tokenCache.token;
  const appKey = process.env.DINGTALK_APP_KEY;
  const appSecret = process.env.DINGTALK_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error('DINGTALK_APP_KEY/DINGTALK_APP_SECRET required for private notify');
  }
  const resp = await axios.post('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    appKey,
    appSecret,
  }, { timeout: 15000 });
  tokenCache = {
    token: resp.data.accessToken,
    expiresAt: now + Number(resp.data.expireIn || 7200),
  };
  return tokenCache.token;
}

async function replySessionWebhook(sessionWebhook, content) {
  if (!sessionWebhook) return false;
  await axios.post(sessionWebhook, {
    msgtype: 'text',
    text: { content },
  }, { timeout: 15000 });
  return true;
}

async function sendPrivateText(staffId, content) {
  if (!staffId) return false;
  const robotCode = process.env.DINGTALK_ROBOT_CODE;
  if (!robotCode) throw new Error('DINGTALK_ROBOT_CODE required');
  const token = await getAccessToken();
  await axios.post(
    'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
    {
      robotCode,
      userIds: [staffId],
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content }),
    },
    {
      timeout: 15000,
      headers: { 'x-acs-dingtalk-access-token': token },
    },
  );
  return true;
}

async function notifyDingTalkUser({ sessionWebhook, staffId, content }) {
  if (sessionWebhook) {
    try {
      await replySessionWebhook(sessionWebhook, content);
      return { channel: 'session_webhook' };
    } catch (err) {
      console.warn('[DingTalk] sessionWebhook failed, fallback private:', err.message);
    }
  }
  if (staffId && process.env.DINGTALK_APP_KEY) {
    await sendPrivateText(staffId, content);
    return { channel: 'private' };
  }
  console.warn('[DingTalk] notify skipped (no webhook/credentials):', String(content).slice(0, 120));
  return { channel: 'skipped' };
}

function buildAwaitConfirmMessage({ contractId, filename, decision, riskScore, reasonCodes }) {
  const frontend = (process.env.FRONTEND_URL || process.env.APP_HOST || 'http://localhost:8080')
    .replace(':3001', ':8080')
    .replace(/\/$/, '');
  const reasons = (reasonCodes || []).slice(0, 5).join('；') || '—';
  return [
    '【合同审查】AI 审批已完成，等待您确认',
    `合同：${filename || '未命名'}（#${contractId}）`,
    `AI 决策：${decision || '—'}  风险分：${riskScore ?? '—'}`,
    `原因：${reasons}`,
    `请回复：确认 #${contractId}   或   驳回 #${contractId} 原因…`,
    `详情：${frontend}/review?contract_id=${contractId}`,
  ].join('\n');
}

module.exports = {
  parseSourceMeta,
  notifyDingTalkUser,
  buildAwaitConfirmMessage,
  replySessionWebhook,
};
