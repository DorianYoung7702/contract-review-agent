/**
 * @file services/contractAnalysis/redlineWorkflow.js
 * @brief 红线稿 → 对方确认 → 采纳正式版 工作流
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../../database');
const { parseJsonField } = require('./reportRendering');
const { createContractVersionSnapshot } = require('./version');
const {
    applyRedlinesToDocx,
    replaceTextInDocx,
} = require('./docxEdit');
const { buildOnlyOfficeConfig } = require('./onlyoffice');

const collectRedlineItems = (reviewData = {}) => {
    const fromSuggestions = Array.isArray(reviewData.modification_suggestions)
        ? reviewData.modification_suggestions
            .filter((item) => item?.redline_kind !== 'company_info_block')
            .map((item) => ({
            original_text: item.original_text || item.original_clause || '',
            suggested_text: item.suggested_text || item.modification || '',
            comment: item.reason || item.rationale || item.title || '',
            title: item.title || item.clause || '',
        }))
        : [];
    if (fromSuggestions.some((i) => i.original_text && i.suggested_text)) {
        return fromSuggestions.filter((i) => i.original_text && i.suggested_text);
    }
    // Annotation targets carry review comments, not replacement clauses. Treating
    // a comment as suggested_text would strike the whole sentence and insert the
    // commentary into the contract body, so redline generation must fail closed.
    return [];
};

const getAnalysis = (contract) => parseJsonField(
    contract.analysis_result,
    parseJsonField(contract.analysis_partial_result, {}),
);

const saveAnalysis = async (contractId, analysis) => {
    await db('contracts').where({ id: contractId }).update({
        analysis_result: JSON.stringify(analysis),
        analysis_partial_result: JSON.stringify(analysis),
        updated_at: db.fn.now(),
    });
};

const getRedlineStatus = (contract) => {
    const analysis = getAnalysis(contract);
    return analysis?.redline_workflow?.status || 'none';
};

/** 红线稿待对方确认时，禁止直接采纳正式改写 */
const assertAdoptAllowed = (contract, { force = false } = {}) => {
    if (force) return;
    const status = getRedlineStatus(contract);
    if (status === 'awaiting_counterpart') {
        const err = new Error('红线稿待对方确认，确认后再采纳生成正式版。可先导出红线 PDF 发送对方。');
        err.status = 409;
        err.code = 'ADOPT_LOCKED_UNTIL_CONFIRM';
        throw err;
    }
};

const findBaseVersionPath = async (contract) => {
    const versions = await db('contract_versions')
        .where({ contract_id: contract.id })
        .whereIn('source_action', ['pre-review', 'pre-redline'])
        .orderBy('version_no', 'desc');
    const preReview = versions.find((v) => v.source_action === 'pre-review');
    if (preReview?.storage_path && fs.existsSync(preReview.storage_path)) {
        return { path: preReview.storage_path, source: 'pre-review', version: preReview };
    }
    if (contract.storage_path && fs.existsSync(contract.storage_path)) {
        return { path: contract.storage_path, source: 'live', version: null };
    }
    return null;
};

/** 将修改建议以红线写入当前合同，进入「待对方确认」 */
const materializeRedlineDraft = async (contract) => {
    const ext = path.extname(contract.storage_path || '').toLowerCase();
    if (ext !== '.docx') {
        const err = new Error('仅 DOCX 支持正文红线稿');
        err.status = 409;
        err.code = 'REDLINE_NOT_DOCX';
        throw err;
    }

    const analysis = getAnalysis(contract);
    const items = collectRedlineItems(analysis);
    if (!items.length) {
        const err = new Error('没有可用于红线的修改建议（需含原文与建议文本）');
        err.status = 409;
        err.code = 'REDLINE_ITEMS_MISSING';
        throw err;
    }

    const base = await findBaseVersionPath(contract);
    if (!base) {
        const err = new Error('找不到可用原件，请先完成一次 AI 审查');
        err.status = 409;
        err.code = 'REDLINE_BASE_MISSING';
        throw err;
    }

    // 先在临时副本上完整生成并校验；定位全部失败时绝不覆盖当前合同。
    const tempPath = `${contract.storage_path}.redline-${uuidv4()}.tmp.docx`;
    let applied = 0;
    let failed = 0;
    try {
        await fs.promises.copyFile(base.path, tempPath);
        ({ applied, failed } = applyRedlinesToDocx(tempPath, items));
        if (applied === 0) {
            const err = new Error('未能在合同原文中定位到可红线的条款');
            err.status = 409;
            err.code = 'REDLINE_LOCATE_FAILED';
            err.details = { attempted: items.length, failed };
            throw err;
        }

        await createContractVersionSnapshot(contract, 'pre-redline');
        await fs.promises.copyFile(tempPath, contract.storage_path);
    } finally {
        await fs.promises.unlink(tempPath).catch(() => {});
    }

    const redlineVersion = await createContractVersionSnapshot(contract, 'redline-review');
    const nextKey = uuidv4();
    analysis.redline_workflow = {
        status: 'awaiting_counterpart',
        applied,
        failed,
        item_count: items.length,
        base_source: base.source,
        redline_version_id: redlineVersion.id,
        redline_version_no: redlineVersion.version_no,
        updated_at: new Date().toISOString(),
    };
    analysis.version_meta = {
        ...(analysis.version_meta || {}),
        redline_version_id: redlineVersion.id,
        redline_version_no: redlineVersion.version_no,
    };

    await db('contracts').where({ id: contract.id }).update({
        document_key: nextKey,
        analysis_result: JSON.stringify(analysis),
        analysis_partial_result: JSON.stringify(analysis),
        updated_at: db.fn.now(),
    });

    return {
        applied,
        failed,
        item_count: items.length,
        redline_workflow: analysis.redline_workflow,
        editorConfig: buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, 'docx'),
        document_key: nextKey,
    };
};

const markCounterpartConfirmed = async (contract, { actor = '', note = '' } = {}) => {
    const analysis = getAnalysis(contract);
    const current = analysis.redline_workflow?.status || 'none';
    if (current === 'accepted') {
        const err = new Error('已生成正式版，无需再次确认');
        err.status = 409;
        err.code = 'REDLINE_CONFIRM_INVALID';
        throw err;
    }
    if (current === 'none') {
        const err = new Error('请先生成红线稿再标记对方确认');
        err.status = 409;
        err.code = 'REDLINE_CONFIRM_INVALID';
        throw err;
    }
    if (current === 'counterpart_confirmed') {
        return { redline_workflow: analysis.redline_workflow, idempotent: true };
    }

    analysis.redline_workflow = {
        ...(analysis.redline_workflow || {}),
        status: 'counterpart_confirmed',
        confirmed_at: new Date().toISOString(),
        confirmed_by: String(actor || ''),
        confirm_note: String(note || ''),
    };
    await saveAnalysis(contract.id, analysis);
    return { redline_workflow: analysis.redline_workflow };
};

/** 对方确认后：从原件干净采纳建议，生成正式版 */
const acceptFormalVersion = async (contract, { indexes = null } = {}) => {
    const status = getRedlineStatus(contract);
    if (status === 'awaiting_counterpart') {
        const err = new Error('请先标记「对方已确认」，再采纳生成正式版');
        err.status = 409;
        err.code = 'ADOPT_LOCKED_UNTIL_CONFIRM';
        throw err;
    }
    if (status !== 'counterpart_confirmed' && status !== 'accepted') {
        const err = new Error('请先完成：生成红线稿 → 对方确认，再生成正式版');
        err.status = 409;
        err.code = 'FORMAL_STATUS_INVALID';
        throw err;
    }

    const ext = path.extname(contract.storage_path || '').toLowerCase();
    if (ext !== '.docx') {
        const err = new Error('仅 DOCX 支持生成正式版');
        err.status = 409;
        throw err;
    }

    const analysis = getAnalysis(contract);
    const suggestions = Array.isArray(analysis.modification_suggestions)
        ? analysis.modification_suggestions
        : [];
    const selected = Array.isArray(indexes) && indexes.length
        ? indexes.map((i) => suggestions[i]).filter((s) => s && s.redline_kind !== 'company_info_block')
        : suggestions.filter((s) => s && s.redline_kind !== 'company_info_block' && (s.original_text || s.original_clause) && (s.suggested_text || s.modification));

    if (!selected.length) {
        const err = new Error('没有可采纳的修改建议');
        err.status = 409;
        err.code = 'NO_SUGGESTIONS';
        throw err;
    }

    const base = await findBaseVersionPath(contract);
    if (!base) {
        const err = new Error('找不到审查前原件，无法生成干净正式版');
        err.status = 409;
        throw err;
    }

    await createContractVersionSnapshot(contract, 'pre-formal');
    await fs.promises.copyFile(base.path, contract.storage_path);

    let succeeded = 0;
    let failed = 0;
    const results = [];
    for (const [index, item] of selected.entries()) {
        if (item.redline_kind === 'company_info_block') continue;
        const originalText = item.original_text || item.original_clause || '';
        const suggestedText = item.suggested_text || item.modification || '';
        if (!originalText || !suggestedText) {
            failed += 1;
            results.push({ index, ok: false, error: '缺少原文或建议' });
            continue;
        }
        try {
            const replacements = replaceTextInDocx(contract.storage_path, originalText, suggestedText);
            succeeded += 1;
            item.adopted = true;
            results.push({ index, ok: true, replacements });
        } catch (error) {
            failed += 1;
            results.push({ index, ok: false, error: error.message });
        }
    }

    if (succeeded === 0) {
        const err = new Error('未能在原件中定位到任何可采纳条款');
        err.status = 409;
        err.code = 'FORMAL_LOCATE_FAILED';
        err.details = { failed, results };
        throw err;
    }

    const formalVersion = await createContractVersionSnapshot(contract, 'accepted-clean');
    const nextKey = uuidv4();
    analysis.redline_workflow = {
        ...(analysis.redline_workflow || {}),
        status: 'accepted',
        formal_version_id: formalVersion.id,
        formal_version_no: formalVersion.version_no,
        formal_succeeded: succeeded,
        formal_failed: failed,
        accepted_at: new Date().toISOString(),
    };
    analysis.version_meta = {
        ...(analysis.version_meta || {}),
        formal_version_id: formalVersion.id,
        formal_version_no: formalVersion.version_no,
    };
    analysis.modification_suggestions = suggestions;

    await db('contracts').where({ id: contract.id }).update({
        document_key: nextKey,
        analysis_result: JSON.stringify(analysis),
        analysis_partial_result: JSON.stringify(analysis),
        updated_at: db.fn.now(),
    });

    return {
        succeeded,
        failed,
        results,
        redline_workflow: analysis.redline_workflow,
        editorConfig: buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, 'docx'),
        document_key: nextKey,
        formal_version: formalVersion,
    };
};

module.exports = {
    collectRedlineItems,
    getAnalysis,
    getRedlineStatus,
    assertAdoptAllowed,
    materializeRedlineDraft,
    markCounterpartConfirmed,
    acceptFormalVersion,
};
