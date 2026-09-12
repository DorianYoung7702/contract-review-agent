#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../database');
const { insertCompanyInfoBlocksInDocx } = require('../services/contractAnalysis/docxEdit');
const { getYunjiaFixedProfile } = require('../services/contractAnalysis/creditCodeAutofill');

const LEGACY_CODE = '91440300MA5FXU44XR';
const CORRECTED_CODE = '91440300MA5FXU44XF';
const apply = process.argv.includes('--apply');
const uploadsRoot = path.resolve(__dirname, '..', 'uploads');

const containsLegacy = (column) => db.raw('CAST(?? AS TEXT) LIKE ?', [column, `%${LEGACY_CODE}%`]);

const run = async () => {
    const contracts = await db('contracts')
        .select('id', 'storage_path')
        .where(function () {
            this.where(containsLegacy('analysis_result'))
                .orWhere(containsLegacy('analysis_partial_result'))
                .orWhere(containsLegacy('decision_payload'));
        });
    const versions = await db('contract_versions')
        .select('id', 'contract_id', 'storage_path')
        .where(containsLegacy('plain_text'));
    const targets = [
        ...contracts.map((row) => ({ kind: 'contract', id: row.id, filePath: row.storage_path })),
        ...versions.map((row) => ({ kind: 'version', id: row.id, contractId: row.contract_id, filePath: row.storage_path })),
    ].filter((item) => {
        if (!item.filePath) return false;
        const resolved = path.resolve(item.filePath);
        return resolved === uploadsRoot || resolved.startsWith(`${uploadsRoot}${path.sep}`);
    });

    const report = {
        apply,
        legacy_code: LEGACY_CODE,
        corrected_code: CORRECTED_CODE,
        contracts: contracts.map((row) => row.id),
        versions: versions.map((row) => row.id),
        files: targets.map((item) => item.filePath),
    };
    if (!apply) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = path.join(uploadsRoot, '.correction-backups', `yunjia-credit-code-${stamp}`);
    fs.mkdirSync(backupRoot, { recursive: true });
    const profile = getYunjiaFixedProfile();
    const fileResults = [];
    for (const target of targets) {
        if (!fs.existsSync(target.filePath) || path.extname(target.filePath).toLowerCase() !== '.docx') continue;
        const backupName = `${target.kind}-${target.id}-${path.basename(target.filePath)}`;
        const backupPath = path.join(backupRoot, backupName);
        fs.copyFileSync(target.filePath, backupPath);
        const result = insertCompanyInfoBlocksInDocx(target.filePath, [{
            companyName: profile.company_name,
            unified_code: profile.unified_code,
            registered_address: profile.registered_address,
            source: profile.data_source,
        }]);
        fileResults.push({ ...target, backupPath, result });
    }

    await db.transaction(async (trx) => {
        for (const column of ['analysis_result', 'analysis_partial_result', 'decision_payload']) {
            await trx('contracts')
                .whereRaw('CAST(?? AS TEXT) LIKE ?', [column, `%${LEGACY_CODE}%`])
                .update({ [column]: trx.raw('replace(??, ?, ?)', [column, LEGACY_CODE, CORRECTED_CODE]) });
        }
        await trx('contract_versions')
            .whereRaw('CAST(?? AS TEXT) LIKE ?', ['plain_text', `%${LEGACY_CODE}%`])
            .update({ plain_text: trx.raw('replace(??, ?, ?)', ['plain_text', LEGACY_CODE, CORRECTED_CODE]) });
    });

    const manifest = { ...report, backup_root: backupRoot, file_results: fileResults };
    const manifestPath = path.join(backupRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(JSON.stringify({ ...manifest, manifest_path: manifestPath }, null, 2));
};

run()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => db.destroy());

