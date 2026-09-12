/**
 * @file routes/contracts/crudRoutes.js
 * @brief 合同基础 CRUD 路由（详情、删除、历史列表）
 *
 * 核心职责：
 * - 获取单个合同详情（含编辑器配置、预分析数据、审查数据）
 * - 删除合同及其本地存储文件
 * - 获取用户合同历史列表（合并普通合同与分组合同）
 *
 * 关键实现：
 * - 必须最后注册（包含 /:id 和 / 通配路由）
 * - 历史列表从 pre_analysis_data 和 analysis_result 解析元数据
 * - 删除时级联清理本地文件
 *
 * 依赖关系：
 * - 上游：database、services/contractAnalysis（auth、onlyoffice、reportRendering）
 * - 下游：被 routes/contracts/index.js 注册
 */
const db = require('../../database');
const fs = require('fs');
const path = require('path');
const { requireRequestUserId, findOwnedContract, findAccessibleContract } = require('../../services/contractAnalysis/auth');
const { buildOnlyOfficeConfig } = require('../../services/contractAnalysis/onlyoffice');
const { parseJsonField } = require('../../services/contractAnalysis/reportRendering');

module.exports = function (router) {
    router.get('/:id', async (req, res) => {
        const { id } = req.params;
        const userId = req.header('X-User-ID');
        if (!userId) return res.status(401).json({ error: 'User ID is required for access.' });

        try {
            const contractRecord = await findAccessibleContract(id, userId);
            if (!contractRecord) return res.status(404).json({ error: 'Contract not found or you do not have permission to access it.' });

            const ext = path.extname(contractRecord.storage_path).toLowerCase().replace('.', '') || 'docx';
            const preAnalysisData = contractRecord.pre_analysis_data ? JSON.parse(contractRecord.pre_analysis_data) : {};
            const reviewData = contractRecord.analysis_result
                ? JSON.parse(contractRecord.analysis_result)
                : parseJsonField(contractRecord.analysis_partial_result, {});
            let decisionPayload = null;
            try {
                decisionPayload = contractRecord.decision_payload
                    ? (typeof contractRecord.decision_payload === 'string'
                        ? JSON.parse(contractRecord.decision_payload)
                        : contractRecord.decision_payload)
                    : (reviewData?.approval || null);
            } catch { decisionPayload = reviewData?.approval || null; }
            let sourceMeta = null;
            try {
                sourceMeta = contractRecord.source_meta
                    ? (typeof contractRecord.source_meta === 'string'
                        ? JSON.parse(contractRecord.source_meta)
                        : contractRecord.source_meta)
                    : null;
            } catch { sourceMeta = null; }

            res.json({
                contract: {
                    id: contractRecord.id,
                    original_filename: contractRecord.original_filename,
                    editorConfig: buildOnlyOfficeConfig(contractRecord, ext),
                    decision: contractRecord.decision || reviewData?.approval?.decision || null,
                    decision_at: contractRecord.decision_at || null,
                    playbook_id: contractRecord.playbook_id || reviewData?.playbook?.playbook_id || null,
                    playbook_version: contractRecord.playbook_version || reviewData?.playbook?.version || null,
                    source: contractRecord.source || 'web',
                    confirmation_status: contractRecord.confirmation_status || 'none',
                    confirmed_at: contractRecord.confirmed_at || null,
                    confirmed_by: contractRecord.confirmed_by || null,
                    source_meta: sourceMeta,
                },
                preAnalysisData,
                reviewData,
                approval: decisionPayload,
                analysisStatus: contractRecord.analysis_status,
                perspective: contractRecord.perspective,
                selectedReviewPoints: preAnalysisData.reviewPoints || preAnalysisData.suggested_review_points || [],
                customPurposes: preAnalysisData.core_purposes ? preAnalysisData.core_purposes.map((value) => ({ value })) : [],
            });
        } catch (error) {
            console.error(`[ERROR] Failed to fetch contract details for id ${id}:`, error);
            res.status(500).json({ error: 'Server error while fetching contract details.' });
        }
    });

    router.delete('/:id', async (req, res) => {
        const { id } = req.params;
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        try {
            const contract = await findOwnedContract(id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found, cannot delete.' });
            if (contract.storage_path) await fs.promises.unlink(contract.storage_path).catch(() => {});
            await db('contracts').where({ id, user_id: userId }).del();
            res.status(200).json({ message: 'Contract deleted successfully.' });
        } catch (error) {
            console.error(`[ERROR] Failed to delete contract with ID ${id}:`, error);
            res.status(500).json({ error: 'Failed to delete contract.' });
        }
    });

    router.get('/', async (req, res) => {
        const userId = req.header('X-User-ID');
        if (!userId) return res.status(401).json({ error: 'User ID is required to fetch history.' });

        try {
            const contracts = await db('contracts')
                .whereNull('group_id')
                .andWhere(function () {
                    this.where({ user_id: userId }).orWhere({ source: 'dingtalk' });
                })
                .select(
                    'id', 'original_filename', 'created_at', 'status', 'perspective',
                    'pre_analysis_data', 'analysis_result', 'decision', 'playbook_id',
                    'source', 'confirmation_status', 'source_meta',
                )
                .orderBy('created_at', 'desc');
            const groups = await db('contract_groups')
                .where({ user_id: userId })
                .select('id', 'name', 'created_at', 'updated_at', 'status')
                .orderBy('created_at', 'desc');

            const extractMeta = (contract) => {
                let contractType = '';
                try {
                    const pre = typeof contract.pre_analysis_data === 'string'
                        ? JSON.parse(contract.pre_analysis_data) : contract.pre_analysis_data;
                    contractType = pre?.contract_type || '';
                } catch { /* ignore */ }
                let riskCount = 0;
                let decision = contract.decision || '';
                try {
                    const result = typeof contract.analysis_result === 'string'
                        ? JSON.parse(contract.analysis_result) : contract.analysis_result;
                    riskCount = Array.isArray(result?.dispute_points) ? result.dispute_points.length : 0;
                    if (!decision) decision = result?.approval?.decision || '';
                } catch { /* ignore */ }
                let staffNick = '';
                try {
                    const meta = typeof contract.source_meta === 'string'
                        ? JSON.parse(contract.source_meta) : contract.source_meta;
                    staffNick = meta?.staff_nick || '';
                } catch { /* ignore */ }
                return {
                    contract_type: contractType,
                    perspective: contract.perspective || '',
                    risk_count: riskCount,
                    decision,
                    playbook_id: contract.playbook_id || '',
                    source: contract.source || 'web',
                    confirmation_status: contract.confirmation_status || 'none',
                    staff_nick: staffNick,
                };
            };

            const records = [
                ...contracts.map((contract) => ({
                    id: contract.id,
                    original_filename: contract.original_filename,
                    created_at: contract.created_at,
                    status: contract.status,
                    record_type: 'contract',
                    ...extractMeta(contract),
                })),
                ...groups.map((group) => ({
                    id: group.id,
                    original_filename: group.name,
                    created_at: group.created_at,
                    updated_at: group.updated_at,
                    status: group.status || 'Reviewed',
                    record_type: 'group',
                    contract_type: '',
                    perspective: '',
                    risk_count: 0,
                    decision: '',
                    playbook_id: '',
                    source: 'web',
                    confirmation_status: 'none',
                    staff_nick: '',
                })),
            ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            res.json(records);
        } catch (error) {
            console.error(`[ERROR] Failed to fetch contract history for user ${userId}:`, error);
            res.status(500).json({ error: 'Failed to fetch contract history.' });
        }
    });
};
