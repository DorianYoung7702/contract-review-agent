/**
 * @file routes/contracts/versionRoutes.js
 * @brief 合同版本快照列表与版本对比路由
 *
 * 核心职责：
 * - 查询指定合同的版本快照列表
 * - 支持两种对比模式：任意两版本对比、当前版本与历史版本对比
 *
 * 关键实现：
 * - 版本按 version_no 倒序排列
 * - 当前版本文本通过 extractTextFromFile 实时提取
 *
 * 依赖关系：
 * - 上游：database、services/contractAnalysis（auth、fileExtraction、version）
 * - 下游：被 routes/contracts/index.js 注册
 */
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../../database');
const { requireRequestUserId, findAccessibleContract } = require('../../services/contractAnalysis/auth');
const { extractTextFromFile } = require('../../services/contractAnalysis/fileExtraction');
const { createContractVersionSnapshot, diffText } = require('../../services/contractAnalysis/version');
const { buildOnlyOfficeConfig } = require('../../services/contractAnalysis/onlyoffice');
const { parseJsonField } = require('../../services/contractAnalysis/reportRendering');

const ACTION_LABELS = {
    'pre-review': '审查前原件',
    'annotated-review': '审查后批注版',
    'pre-redline': '红线稿生成前',
    'redline-review': '红线批注稿',
    'pre-formal': '正式版生成前',
    'accepted-clean': '已采纳正式版',
    'replace-text': '采纳修改前',
    'batch-replace-text': '批量采纳前',
    'append-clause': '追加条款前',
};

module.exports = function (router) {
    router.get('/:id/versions', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const versions = await db('contract_versions')
            .where({ contract_id: contract.id })
            .select('id', 'version_no', 'source_action', 'created_at')
            .orderBy('version_no', 'desc');
        res.json({
            versions: versions.map((v) => ({
                ...v,
                label: ACTION_LABELS[v.source_action] || v.source_action,
            })),
        });
    });

    /** Snapshot current on-disk DOCX (call after OnlyOffice force-save with comments). */
    router.post('/:id/snapshot', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        try {
            const sourceAction = String(req.body?.source_action || 'annotated-review');
            const version = await createContractVersionSnapshot(contract, sourceAction);

            // Persist annotated version id onto analysis_result.version_meta when available
            if (sourceAction === 'annotated-review' && contract.analysis_result) {
                try {
                    const analysis = parseJsonField(contract.analysis_result, {});
                    analysis.version_meta = {
                        ...(analysis.version_meta || {}),
                        annotated_version_id: version.id,
                        annotated_version_no: version.version_no,
                    };
                    await db('contracts').where({ id: contract.id }).update({
                        analysis_result: JSON.stringify(analysis),
                        analysis_partial_result: JSON.stringify(analysis),
                    });
                } catch { /* ignore */ }
            }

            res.status(201).json({
                version: {
                    ...version,
                    label: ACTION_LABELS[sourceAction] || sourceAction,
                },
            });
        } catch (error) {
            console.error('[snapshot] failed', error);
            res.status(500).json({ error: error.message || 'Failed to create snapshot' });
        }
    });

    /** Open a historical version (with comments) in OnlyOffice view mode. */
    router.get('/:id/versions/:versionId/editor-config', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const version = await db('contract_versions')
            .where({ id: req.params.versionId, contract_id: contract.id })
            .first();
        if (!version?.storage_path) return res.status(404).json({ error: 'Version not found.' });

        const ext = path.extname(version.storage_path).toLowerCase().replace('.', '') || 'docx';
        const label = ACTION_LABELS[version.source_action] || version.source_action;
        const editorConfig = buildOnlyOfficeConfig(contract, ext, {
            storagePath: version.storage_path,
            documentKey: `ver-${version.id}-${uuidv4()}`,
            title: `${contract.original_filename}（${label} v${version.version_no}）`,
            readOnly: true,
        });
        res.json({
            editorConfig,
            version: {
                id: version.id,
                version_no: version.version_no,
                source_action: version.source_action,
                label,
                created_at: version.created_at,
            },
        });
    });

    // 支持任意两个版本对比（issue 5.5）
    router.get('/:id/diff', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const { fromVersionId, toVersionId, versionId } = req.query;

        // 模式1: 对比两个指定版本
        if (fromVersionId && toVersionId) {
            const fromVersion = await db('contract_versions')
                .where({ id: fromVersionId, contract_id: contract.id }).first();
            const toVersion = await db('contract_versions')
                .where({ id: toVersionId, contract_id: contract.id }).first();
            if (!fromVersion || !toVersion) {
                return res.status(404).json({ error: '未找到指定的版本快照。' });
            }
            return res.json({
                fromVersion: { id: fromVersion.id, version_no: fromVersion.version_no, source_action: fromVersion.source_action, created_at: fromVersion.created_at },
                toVersion: { id: toVersion.id, version_no: toVersion.version_no, source_action: toVersion.source_action, created_at: toVersion.created_at },
                diff: diffText(fromVersion.plain_text || '', toVersion.plain_text || ''),
            });
        }

        // 模式2: 对比当前版本 vs 指定历史版本（原有逻辑）
        const versionQuery = db('contract_versions').where({ contract_id: contract.id });
        if (versionId) versionQuery.andWhere({ id: versionId });
        const version = await versionQuery.orderBy('version_no', 'desc').first();
        if (!version) return res.status(404).json({ error: '暂无可对比的版本快照。' });

        const currentText = await extractTextFromFile(contract.storage_path);
        res.json({
            version: {
                id: version.id,
                version_no: version.version_no,
                source_action: version.source_action,
                created_at: version.created_at,
            },
            diff: diffText(version.plain_text || '', currentText),
        });
    });
};
