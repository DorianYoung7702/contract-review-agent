const { loadAllPlaybooks } = require('./loader');

/**
 * Match a playbook by contract type text. Playbook is the approval source of truth.
 */
function matchPlaybook(contractType = '', { fallbackToGeneral = true } = {}) {
  const typeText = String(contractType || '').trim();
  const playbooks = loadAllPlaybooks();
  if (!playbooks.length) return null;

  const exact = playbooks.find((pb) => pb.contract_type === typeText);
  if (exact) return exact;

  const lower = typeText.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const pb of playbooks) {
    let score = 0;
    if (lower && pb.contract_type.toLowerCase().includes(lower)) score += 5;
    if (lower && lower.includes(pb.contract_type.toLowerCase())) score += 4;
    for (const kw of pb.type_keywords || []) {
      const k = String(kw).toLowerCase();
      if (k && lower.includes(k)) score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      best = pb;
    }
  }

  if (best && bestScore > 0) return best;
  if (!fallbackToGeneral) return null;

  // Prefer purchase as default commercial playbook when unknown
  return (
    playbooks.find((pb) => pb.playbook_id === 'purchase_v1')
    || playbooks[0]
    || null
  );
}

module.exports = {
  matchPlaybook,
};
