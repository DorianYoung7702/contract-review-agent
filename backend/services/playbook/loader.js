const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./simpleYaml');

const PLAYBOOK_DIR = path.join(__dirname, '../../data/playbooks');

let cache = null;

function validatePlaybook(raw, filename) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid playbook: ${filename}`);
  }
  if (!raw.contract_type || !raw.playbook_id) {
    throw new Error(`Playbook missing contract_type/playbook_id: ${filename}`);
  }
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  for (const rule of rules) {
    if (!rule.id || !rule.name) {
      throw new Error(`Playbook rule missing id/name in ${filename}`);
    }
    rule.severity = String(rule.severity || 'MEDIUM').toUpperCase();
    rule.auto_decision = String(rule.auto_decision || 'MANUAL').toUpperCase();
    rule.required = Boolean(rule.required);
    rule.forbidden = Boolean(rule.forbidden);
    rule.matcher = rule.matcher || {};
    if (!Array.isArray(rule.matcher.keywords)) {
      rule.matcher.keywords = [];
    }
  }
  return {
    contract_type: String(raw.contract_type),
    playbook_id: String(raw.playbook_id),
    version: String(raw.version || '1.0'),
    auto_approval_limit: Number(raw.auto_approval_limit ?? 500000),
    medium_risk_threshold: Number(raw.medium_risk_threshold ?? 2),
    type_keywords: Array.isArray(raw.type_keywords) ? raw.type_keywords.map(String) : [],
    rules,
    source_file: filename,
  };
}

function loadAllPlaybooks({ force = false } = {}) {
  if (cache && !force) return cache;
  if (!fs.existsSync(PLAYBOOK_DIR)) {
    cache = [];
    return cache;
  }
  const files = fs.readdirSync(PLAYBOOK_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  cache = files.map((filename) => {
    const text = fs.readFileSync(path.join(PLAYBOOK_DIR, filename), 'utf8');
    return validatePlaybook(parseYaml(text), filename);
  });
  return cache;
}

function getPlaybookById(playbookId) {
  return loadAllPlaybooks().find((pb) => pb.playbook_id === playbookId) || null;
}

function listPlaybooks() {
  return loadAllPlaybooks().map((pb) => ({
    playbook_id: pb.playbook_id,
    contract_type: pb.contract_type,
    version: pb.version,
    rule_count: pb.rules.length,
    source_file: pb.source_file,
  }));
}

module.exports = {
  PLAYBOOK_DIR,
  loadAllPlaybooks,
  getPlaybookById,
  listPlaybooks,
  validatePlaybook,
};
