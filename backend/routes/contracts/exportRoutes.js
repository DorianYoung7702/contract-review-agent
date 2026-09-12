/**
 * @file routes/contracts/exportRoutes.js
 * @brief 审查报告导出、PDF 批注、强制保存与编辑器配置路由
 *
 * 核心职责：
 * - 导出审查报告（PDF/DOCX/HTML 三种格式）
 * - 导出「审查后批注版」合同 PDF（原文+批注附录，非一键采纳改写正文）
 * - 导出 PDF 合同批注意见为文本
 * - 触发 OnlyOffice 强制保存（force-save）
 * - 获取最新的 OnlyOffice 编辑器配置
 *
 * 关键实现：
 * - DOCX 导出使用真正的 OOXML 格式
 * - 强制保存通过 postOnlyOfficeCommand 调用 OnlyOffice 服务
 * - 带批注合同 PDF：annotated-review 快照 → OnlyOffice 转 PDF → 合并批注附录
 *
 * 依赖关系：
 * - 上游：database、services/contractAnalysis（auth、reportRendering、onlyoffice）
 * - 下游：被 routes/contracts/index.js 注册
 */
const db = require('../../database');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireRequestUserId, findAccessibleContract } = require('../../services/contractAnalysis/auth');
const {
    parseJsonField,
    renderReviewReportHtml,
    generateDocxBuffer,
    streamReviewReportPdf,
} = require('../../services/contractAnalysis/reportRendering');
const {
    postOnlyOfficeCommand,
    buildOnlyOfficeConfig,
    buildUploadFileUrl,
    convertDocumentToPdf,
} = require('../../services/contractAnalysis/onlyoffice');
const { applyRedlinesToDocx } = require('../../services/contractAnalysis/docxEdit');
const { collectRedlineItems } = require('../../services/contractAnalysis/redlineWorkflow');

module.exports = function (router) {
    router.get('/:id/export-report', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const format = String(req.query.format || 'html').toLowerCase();
        const reviewData = parseJsonField(contract.analysis_result, parseJsonField(contract.analysis_partial_result, {}));
        const basename = path.basename(contract.original_filename, path.extname(contract.original_filename)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'contract';

        if (format === 'pdf') {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${basename}-review-report.pdf"`);
            return streamReviewReportPdf(res, contract, reviewData);
        }

        if (format === 'word' || format === 'docx') {
            // 真正的 DOCX 格式（OOXML），非 HTML 伪装
            const docxBuffer = generateDocxBuffer(contract, reviewData);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${basename}-review-report.docx"`);
            return res.send(docxBuffer);
        }

        const html = renderReviewReportHtml(contract, reviewData, format);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${basename}-review-report.html"`);
        res.send(html);
    });

    /**
     * Export contract PDF with in-body redline markup (red strike + red underline).
     * Source prefers pre-review snapshot (clean original), else annotated-review.
     * Never uses live storage_path after「一键采纳」rewrites as the default source.
     */
    router.get('/:id/export-annotated-pdf', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const versions = await db('contract_versions')
            .where({ contract_id: contract.id })
            .whereIn('source_action', ['redline-review', 'pre-review', 'annotated-review'])
            .orderBy('version_no', 'desc');

        const redline = versions.find((v) => v.source_action === 'redline-review');
        const preReview = versions.find((v) => v.source_action === 'pre-review');
        const annotated = versions.find((v) => v.source_action === 'annotated-review');
        // 已有红线稿则直接转 PDF；否则从原件现场打红线
        const version = redline || preReview || annotated;

        if (!version?.storage_path) {
            return res.status(409).json({
                error: '尚无可用原件快照。请先完成一次 AI 审查（会生成审查前原件），再导出红线批注 PDF。',
                code: 'ANNOTATED_VERSION_MISSING',
            });
        }

        if (!fs.existsSync(version.storage_path)) {
            return res.status(404).json({
                error: '快照文件缺失，请重新审查以生成原件快照。',
                code: 'ANNOTATED_FILE_MISSING',
            });
        }

        const ext = path.extname(version.storage_path).toLowerCase();
        if (ext !== '.docx') {
            return res.status(409).json({
                error: '当前合同不是 DOCX，无法导出正文红线 PDF。请使用「PDF批注TXT」。',
                code: 'ANNOTATED_NOT_DOCX',
            });
        }

        const reviewData = parseJsonField(
            contract.analysis_result,
            parseJsonField(contract.analysis_partial_result, {}),
        );
        const redlineItems = collectRedlineItems(reviewData);
        if (!redlineItems.length && version.source_action !== 'redline-review') {
            return res.status(409).json({
                error: '没有可用于红线批注的修改建议（需含原文与建议文本）。',
                code: 'REDLINE_ITEMS_MISSING',
            });
        }

        const basename = path.basename(contract.original_filename, path.extname(contract.original_filename))
            .replace(/[^a-zA-Z0-9._-]/g, '_') || 'contract';

        const tempDir = path.join(__dirname, '..', '..', 'uploads', 'tmp');
        await fs.promises.mkdir(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, `${contract.id}-redline-${uuidv4()}.docx`);

        try {
            await fs.promises.copyFile(version.storage_path, tempPath);
            let applied = 0;
            let failed = 0;
            if (version.source_action === 'redline-review') {
                // 已是正文红线稿，直接转 PDF
                applied = collectRedlineItems(reviewData).length || 1;
            } else {
                const result = applyRedlinesToDocx(tempPath, redlineItems);
                applied = result.applied;
                failed = result.failed;
                if (applied === 0) {
                    return res.status(409).json({
                        error: '未能在合同原文中定位到可红线的条款，请检查修改建议中的原文锚点。',
                        code: 'REDLINE_LOCATE_FAILED',
                        details: { attempted: redlineItems.length, failed },
                    });
                }
            }

            const fileUrl = buildUploadFileUrl(tempPath);
            const pdfBuffer = await convertDocumentToPdf({
                fileUrl,
                key: `redline-pdf-${contract.id}-v${version.version_no}-${uuidv4()}`,
                title: `${contract.original_filename || 'contract'}-redline.docx`,
            });

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${basename}-redline.pdf"`,
            );
            res.setHeader('X-Redline-Applied', String(applied));
            res.setHeader('X-Redline-Failed', String(failed));
            res.setHeader('X-Source-Version-No', String(version.version_no));
            return res.send(pdfBuffer);
        } catch (error) {
            console.error(`[ERROR] export-annotated-pdf contract ${contract.id}:`, error.message);
            return res.status(502).json({
                error: `导出红线批注 PDF 失败：${error.message}`,
                code: 'ANNOTATED_PDF_CONVERT_FAILED',
            });
        } finally {
            fs.promises.unlink(tempPath).catch(() => {});
        }
    });

    router.get('/:id/pdf-annotations', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findAccessibleContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const reviewData = parseJsonField(contract.analysis_result, parseJsonField(contract.analysis_partial_result, {}));
        const suggestions = reviewData.modification_suggestions || [];
        const lines = [
            `PDF 合同批注意见：${contract.original_filename}`,
            `导出时间：${new Date().toISOString()}`,
            '',
            ...suggestions.flatMap((item, index) => [
                `#${index + 1} ${item.title || item.clause || '修改建议'}`,
                `原文：${item.original_text || item.original_clause || ''}`,
                `建议修改为：${item.suggested_text || item.modification || ''}`,
                `修改理由：${item.reason || item.rationale || ''}`,
                '',
            ]),
        ];
        const basename = path.basename(contract.original_filename, path.extname(contract.original_filename)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'contract';
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${basename}-pdf-annotations.txt"`);
        res.send(lines.join('\n'));
    });

    router.post('/:id/force-save', async (req, res) => {
        const userId = req.header('X-User-ID');
        const { documentKey } = req.body || {};
        if (!userId) return res.status(401).json({ error: 'User ID is required for access.' });

        try {
            const contract = await findAccessibleContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found or you do not have permission to access it.' });
            const key = String(documentKey || contract.document_key || '').trim();
            if (!key) return res.status(400).json({ error: 'Document key is required for force-save.' });

            const result = await postOnlyOfficeCommand({
                c: 'forcesave',
                key,
            });

            if (result?.error && result.error !== 0) {
                return res.status(502).json({ error: `OnlyOffice force-save failed: ${result.error}`, result });
            }

            res.json({ ok: true, result });
        } catch (error) {
            console.error(`[ERROR] Failed to force-save contract ${req.params.id}:`, error.response?.data || error.message);
            res.status(500).json({ error: 'Failed to trigger OnlyOffice force-save.' });
        }
    });

    router.get('/:id/editor-config', async (req, res) => {
        const { id } = req.params;
        const userId = req.header('X-User-ID');
        if (!userId) return res.status(401).json({ error: 'User ID is required for access.' });

        try {
            const contractRecord = await findAccessibleContract(id, userId);
            if (!contractRecord) return res.status(404).json({ error: 'Contract not found or you do not have permission to access it.' });

            // Optional: open a specific version snapshot (comments preserved)
            if (req.query.versionId) {
                const version = await db('contract_versions')
                    .where({ id: req.query.versionId, contract_id: contractRecord.id })
                    .first();
                if (!version?.storage_path) {
                    return res.status(404).json({ error: 'Version not found.' });
                }
                const fileExt = path.extname(version.storage_path).toLowerCase().replace('.', '') || 'docx';
                return res.json({
                    editorConfig: buildOnlyOfficeConfig(contractRecord, fileExt, {
                        storagePath: version.storage_path,
                        documentKey: `ver-${version.id}-${uuidv4()}`,
                        title: `${contractRecord.original_filename}（v${version.version_no}）`,
                        readOnly: true,
                    }),
                    versionId: version.id,
                });
            }

            const fileExt = path.extname(contractRecord.storage_path).toLowerCase().replace('.', '') || 'docx';
            res.json({
                editorConfig: buildOnlyOfficeConfig(contractRecord, fileExt),
            });
        } catch (error) {
            console.error(`[ERROR] Failed to fetch fresh editor config for id ${id}:`, error);
            res.status(500).json({ error: 'Server error while fetching editor config.' });
        }
    });
};
