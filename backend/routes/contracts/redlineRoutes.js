/**
 * @file routes/contracts/redlineRoutes.js
 * @brief 红线稿生成、对方确认、正式版采纳与导出
 */
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../../database');
const { requireRequestUserId, findAccessibleContract } = require('../../services/contractAnalysis/auth');
const {
    materializeRedlineDraft,
    markCounterpartConfirmed,
    acceptFormalVersion,
    getAnalysis,
} = require('../../services/contractAnalysis/redlineWorkflow');
const {
    buildUploadFileUrl,
    convertDocumentToPdf,
} = require('../../services/contractAnalysis/onlyoffice');

module.exports = function (router) {
    /** 生成红线稿并刷新编辑器（正文红删除线+红下划线） */
    router.post('/:id/apply-redlines', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        try {
            const result = await materializeRedlineDraft(contract);
            res.json({
                ok: true,
                message: `已生成红线稿（成功 ${result.applied} 处），请导出给对方确认后再采纳正式版。`,
                ...result,
            });
        } catch (error) {
            const status = error.status || 500;
            console.error(`[ERROR] apply-redlines contract ${req.params.id}:`, error.message);
            res.status(status).json({
                error: error.message || '生成红线稿失败',
                code: error.code || 'REDLINE_APPLY_FAILED',
                details: error.details,
            });
        }
    });

    /** 标记对方已确认红线建议 */
    router.post('/:id/counterpart-confirm', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        try {
            const result = await markCounterpartConfirmed(contract, {
                actor: req.body?.actor || userId,
                note: req.body?.note || '',
            });
            res.json({ ok: true, message: '已记录对方确认，可以采纳并导出正式版。', ...result });
        } catch (error) {
            res.status(error.status || 500).json({
                error: error.message,
                code: error.code || 'REDLINE_CONFIRM_FAILED',
            });
        }
    });

    /** 对方确认后：采纳建议生成干净正式版 */
    router.post('/:id/accept-formal', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        try {
            const indexes = Array.isArray(req.body?.indexes) ? req.body.indexes : null;
            const result = await acceptFormalVersion(contract, { indexes });
            res.json({
                ok: true,
                message: `正式版已生成（成功采纳 ${result.succeeded} 处）`,
                ...result,
            });
        } catch (error) {
            res.status(error.status || 500).json({
                error: error.message,
                code: error.code || 'FORMAL_ACCEPT_FAILED',
                details: error.details,
            });
        }
    });

    /** 导出可继续在 Word 中审阅、接受或拒绝修订的红线批注 DOCX。 */
    router.get('/:id/export-redline', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const version = await db('contract_versions')
            .where({ contract_id: contract.id, source_action: 'redline-review' })
            .orderBy('version_no', 'desc')
            .first();
        if (!version?.storage_path) {
            return res.status(409).json({
                error: '尚无红线批注稿，请先生成红线稿。',
                code: 'REDLINE_VERSION_MISSING',
            });
        }
        if (!fs.existsSync(version.storage_path)) {
            return res.status(404).json({
                error: '红线批注稿文件缺失，请重新生成。',
                code: 'REDLINE_FILE_MISSING',
            });
        }

        const ext = path.extname(version.storage_path).toLowerCase();
        if (ext !== '.docx') {
            return res.status(409).json({
                error: '红线批注稿不是 DOCX，无法导出。',
                code: 'REDLINE_NOT_DOCX',
            });
        }

        const basename = path.basename(
            contract.original_filename || 'contract.docx',
            path.extname(contract.original_filename || 'contract.docx'),
        ).replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '_') || 'contract';
        const asciiName = basename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'contract';
        const downloadName = `${basename}-红线批注稿.docx`;
        const analysis = getAnalysis(contract);
        const workflow = analysis?.redline_workflow || {};

        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${asciiName}-redline.docx"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        );
        res.setHeader('X-Redline-Applied', String(workflow.applied || 0));
        res.setHeader('X-Redline-Failed', String(workflow.failed || 0));
        res.setHeader('X-Source-Version-No', String(version.version_no));
        return res.send(fs.readFileSync(version.storage_path));
    });

    /** 导出正式版 DOCX / PDF（优先 accepted-clean 快照） */
    router.get('/:id/export-formal', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const format = String(req.query.format || 'docx').toLowerCase();
        const versions = await db('contract_versions')
            .where({ contract_id: contract.id })
            .whereIn('source_action', ['accepted-clean'])
            .orderBy('version_no', 'desc');
        const formal = versions[0];
        const analysis = getAnalysis(contract);
        const status = analysis?.redline_workflow?.status;

        let sourcePath = formal?.storage_path;
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            if (status === 'accepted' && contract.storage_path && fs.existsSync(contract.storage_path)) {
                sourcePath = contract.storage_path;
            } else {
                return res.status(409).json({
                    error: '尚无正式版。请先：生成红线稿 → 对方确认 → 采纳正式版。',
                    code: 'FORMAL_VERSION_MISSING',
                });
            }
        }

        const basename = path.basename(contract.original_filename, path.extname(contract.original_filename))
            .replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '_') || 'contract';

        if (format === 'pdf') {
            try {
                const pdfBuffer = await convertDocumentToPdf({
                    fileUrl: buildUploadFileUrl(sourcePath),
                    key: `formal-pdf-${contract.id}-${uuidv4()}`,
                    title: `${contract.original_filename || 'contract'}-formal.docx`,
                });
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="${basename}-正式版.pdf"`);
                return res.send(pdfBuffer);
            } catch (error) {
                return res.status(502).json({ error: `正式版 PDF 转换失败：${error.message}` });
            }
        }

        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
        res.setHeader('Content-Disposition', `attachment; filename="${basename}-正式版.docx"`);
        return res.send(fs.readFileSync(sourcePath));
    });
};
