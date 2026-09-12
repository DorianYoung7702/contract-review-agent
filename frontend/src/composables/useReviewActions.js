// Review.vue 采纳/批量/导出/差异对比
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';

export function useReviewActions(state, editor, helpers) {
    const {
        contract, reviewData, activeAiTab, adoptedHighlights,
        selectedSuggestionPreview,
    } = state;
    const {
        executeEditorMethod, ensureEditorReady, findTextRange,
        buildSuggestionCandidates, replaceTextInEditorFinal, previewSuggestion,
        forceSaveCurrentDocument,
    } = editor;
    const { suggestionOriginal, suggestionText, suggestionTitle } = helpers;

    const selectedSuggestionIndexes = ref([]);
    const batchApplying = ref(false);
    const diffItems = ref([]);
    const diffLoading = ref(false);
    const contractVersions = ref([]);
    const versionsLoading = ref(false);

    const addDocComment = async (text, comment, { silent = false } = {}) => {
        if (!text) {
            if (!silent) ElMessage.info('AI 未返回可批注定位的原文，请手动添加批注。');
            return false;
        }
        if (!ensureEditorReady()) return false;
        try {
            const range = await findTextRange(text);
            if (!range) {
                if (!silent) ElMessage.info('定位原文失败，无法添加批注。');
                return false;
            }
            await executeEditorMethod('SelectRange', [range]);
            const bookmark = `ai_review_${Date.now()}`;
            await executeEditorMethod('AddBookmark', [bookmark]).catch(() => null);
            await executeEditorMethod('AddComment', [comment || 'AI 审查建议', 'AI 审查专家']).catch(async () => {
                await executeEditorMethod('AddComment', [comment || 'AI 审查建议']);
            });
            if (!silent) ElMessage.success('已在文档中添加批注，并尝试写入书签锚点。');
            return true;
        } catch (error) {
            if (!silent) ElMessage.error('添加批注失败：当前 OnlyOffice 未开放批注接口。');
            return false;
        }
    };

    /** 审查完成后写入 OnlyOffice 批注，再生成正文红线稿供对方确认 */
    const applyAutoAnnotations = async () => {
        const targets = Array.isArray(reviewData.auto_annotation_targets)
            ? reviewData.auto_annotation_targets
            : [];
        if (!contract.id) return;

        const decision = reviewData.approval?.decision || 'DONE';
        const stamp = `${contract.id}:${decision}:${targets.map((t) => t.rule_id || t.title).join('|')}`;
        const key = `auto_annotated_${stamp}`;
        if (sessionStorage.getItem(key)) return;

        let ok = 0;
        for (const target of targets.slice(0, 15)) {
            const placed = await addDocComment(
                target.original_text || target.title,
                target.comment || `${target.rule_id || ''} ${target.title || ''}`.trim(),
                { silent: true },
            );
            if (placed) ok += 1;
        }

        try {
            if (typeof forceSaveCurrentDocument === 'function') {
                await forceSaveCurrentDocument(true);
                await new Promise((r) => setTimeout(r, 2000));
            }
            const snap = await api.createContractSnapshot(contract.id, { source_action: 'annotated-review' });
            if (reviewData.version_meta) {
                reviewData.version_meta.annotated_version_id = snap.data?.version?.id;
                reviewData.version_meta.annotated_version_no = snap.data?.version?.version_no;
            } else {
                reviewData.version_meta = {
                    annotated_version_id: snap.data?.version?.id,
                    annotated_version_no: snap.data?.version?.version_no,
                };
            }
        } catch (err) {
            console.warn('[annotate] snapshot after review failed', err);
        }

        sessionStorage.setItem(key, '1');
        if (ok > 0) {
            ElMessage.success(`已写入 ${ok} 条批注`);
        }

        // 自动生成正文红线稿（覆盖批注版显示为红线）
        await generateRedlineDraft({ silent: true });
    };

    const syncRedlineWorkflow = (workflow) => {
        if (!workflow) return;
        reviewData.redline_workflow = workflow;
        if (reviewData.version_meta) {
            Object.assign(reviewData.version_meta, {
                redline_version_id: workflow.redline_version_id,
                redline_version_no: workflow.redline_version_no,
                formal_version_id: workflow.formal_version_id,
                formal_version_no: workflow.formal_version_no,
            });
        }
    };

    const generateRedlineDraft = async ({ silent = false } = {}) => {
        if (!contract.id) return;
        try {
            const res = await api.applyRedlines(contract.id);
            if (res.data.editorConfig) contract.editorConfig = res.data.editorConfig;
            syncRedlineWorkflow(res.data.redline_workflow);
            await loadContractVersions();
            if (!silent) {
                ElMessage.success(res.data.message || `已生成红线稿（${res.data.applied || 0} 处）`);
            } else if (res.data.applied > 0) {
                ElMessage.success(`已在合同中写入红线批注（${res.data.applied} 处），可导出给对方确认`);
            }
        } catch (error) {
            if (!silent) {
                ElMessage.error(error.response?.data?.error || '生成红线稿失败');
            } else {
                console.warn('[redline] auto apply failed', error.response?.data || error.message);
                ElMessage.info('批注已写入；红线稿可稍后在工作台手动生成');
            }
        }
    };

    const markCounterpartConfirmed = async () => {
        if (!contract.id) return;
        try {
            const res = await api.confirmCounterpartRedlines(contract.id);
            syncRedlineWorkflow(res.data.redline_workflow);
            ElMessage.success(res.data.message || '已记录对方确认');
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '确认失败');
        }
    };

    const acceptAndExportFormal = async () => {
        if (!contract.id) return;
        batchApplying.value = true;
        try {
            const indexes = selectedSuggestionIndexes.value.length
                ? selectedSuggestionIndexes.value
                : null;
            const res = await api.acceptFormalVersion(contract.id, { indexes });
            if (res.data.editorConfig) contract.editorConfig = res.data.editorConfig;
            syncRedlineWorkflow(res.data.redline_workflow);
            (reviewData.modification_suggestions || []).forEach((item) => {
                if (item) item.adopted = true;
            });
            await loadContractVersions();
            ElMessage.success(res.data.message || '正式版已生成');
            await exportFormalVersion('docx');
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '生成正式版失败');
        } finally {
            batchApplying.value = false;
        }
    };

    const exportFormalVersion = async (format = 'docx') => {
        if (!contract.id) return;
        try {
            const response = await api.exportFormalVersion(contract.id, format);
            const nameBase = String(contract.original_filename || 'contract')
                .replace(/\.[^.]+$/, '')
                .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
                || 'contract';
            downloadBlob(response.data, `${nameBase}-正式版.${format === 'pdf' ? 'pdf' : 'docx'}`);
            ElMessage.success('已导出正式版');
        } catch (error) {
            ElMessage.error(await readBlobErrorMessage(error, '导出正式版失败'));
        }
    };

    const redlineStatus = () => reviewData.redline_workflow?.status || 'none';
    const canAdoptSuggestions = () => {
        const s = redlineStatus();
        return s !== 'awaiting_counterpart';
    };

    const adoptSuggestion = (item) => {
        if (!canAdoptSuggestions()) {
            ElMessage.warning('红线稿待对方确认，确认后再采纳生成正式版。请先导出红线 PDF。');
            return;
        }
        const originalText = suggestionOriginal(item);
        const suggestedText = suggestionText(item);

        if (!originalText || !suggestedText) {
            ElMessage.warning('该建议缺少可自动替换的原文或建议文本，请手动修改。');
            return;
        }

        previewSuggestion(item, '正在采纳');
        replaceTextInEditorFinal(originalText, suggestedText, (result = {}) => {
            item.adopted = true;
            item.adopted_original = originalText;
            adoptedHighlights.value[suggestionTitle(item, 0)] = originalText;
            if (result.fallback) {
                selectedSuggestionPreview.value.status = '已写入源文件，当前页面未刷新';
                ElMessage.success('建议已采纳，源文件已更新；当前页面未刷新。');
            } else {
                selectedSuggestionPreview.value.status = '已实时更新到左侧文档';
                ElMessage.success('建议已采纳，左侧文档已更新。');
            }
        }, (status) => {
            selectedSuggestionPreview.value.status = status;
        }, item);
    };

    const downloadBlob = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    const applySelectedSuggestions = async () => {
        if (!canAdoptSuggestions()) {
            ElMessage.warning('红线稿待对方确认，请先标记「对方已确认」，再采纳或生成正式版。');
            return;
        }
        const indexes = selectedSuggestionIndexes.value;
        if (!indexes.length) {
            ElMessage.warning('请选择要批量采纳的修改建议。');
            return;
        }
        batchApplying.value = true;
        try {
            const suggestions = indexes.map((index) => {
                const item = reviewData.modification_suggestions[index];
                return {
                    originalText: suggestionOriginal(item),
                    suggestedText: suggestionText(item),
                    originalCandidates: buildSuggestionCandidates(suggestionOriginal(item), item),
                };
            });
            const response = await api.batchReplaceContractText(contract.id, { suggestions });
            if (response.data.editorConfig) contract.editorConfig = response.data.editorConfig;
            indexes.forEach((index) => {
                if (reviewData.modification_suggestions[index]) reviewData.modification_suggestions[index].adopted = true;
            });
            ElMessage.success(`批量采纳完成，成功替换 ${response.data.totalReplacements || 0} 处。`);
            await loadLatestDiff();
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '批量采纳失败。');
        } finally {
            batchApplying.value = false;
        }
    };

    const loadContractVersions = async () => {
        if (!contract.id) return;
        versionsLoading.value = true;
        try {
            const res = await api.getContractVersions(contract.id);
            contractVersions.value = res.data.versions || [];
        } catch {
            contractVersions.value = [];
        } finally {
            versionsLoading.value = false;
        }
    };

    const openContractVersion = async (versionId) => {
        if (!contract.id || !versionId) return;
        try {
            const res = await api.getVersionEditorConfig(contract.id, versionId);
            if (res.data.editorConfig) {
                contract.editorConfig = res.data.editorConfig;
                ElMessage.success(`已打开：${res.data.version?.label || '历史版本'}（只读）`);
            }
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '打开历史版本失败');
        }
    };

    const openCurrentEditable = async () => {
        if (!contract.id) return;
        try {
            const res = await api.getFreshEditorConfig(contract.id);
            if (res.data.editorConfig) {
                contract.editorConfig = res.data.editorConfig;
                ElMessage.success('已回到当前可编辑合同');
            }
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '加载当前合同失败');
        }
    };

    const compareVersionPair = async (fromVersionId, toVersionId) => {
        if (!contract.id || !fromVersionId || !toVersionId) return;
        diffLoading.value = true;
        try {
            const response = await api.getContractDiff(contract.id, { fromVersionId, toVersionId });
            diffItems.value = response.data.diff || [];
            activeAiTab.value = 'workspace';
        } catch (error) {
            ElMessage.info(error.response?.data?.error || '版本对比失败');
        } finally {
            diffLoading.value = false;
        }
    };

    const loadLatestDiff = async () => {
        if (!contract.id) return;
        diffLoading.value = true;
        try {
            const response = await api.getContractDiff(contract.id);
            diffItems.value = response.data.diff || [];
            activeAiTab.value = 'workspace';
        } catch (error) {
            ElMessage.info(error.response?.data?.error || '暂无可对比的合同版本。');
        } finally {
            diffLoading.value = false;
        }
    };

    const exportReport = async (format = 'html') => {
        try {
            const response = await api.exportReviewReport(contract.id, format);
            downloadBlob(response.data, `合同审查报告.${format === 'word' ? 'doc' : format}`);
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '导出审查报告失败。');
        }
    };

    const downloadPdfAnnotations = async () => {
        try {
            const response = await api.downloadPdfAnnotations(contract.id);
            downloadBlob(response.data, 'PDF批注意见.txt');
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '导出 PDF 批注意见失败。');
        }
    };

    const readBlobErrorMessage = async (error, fallback) => {
        const data = error?.response?.data;
        if (data instanceof Blob) {
            try {
                const text = await data.text();
                const parsed = JSON.parse(text);
                return parsed.error || fallback;
            } catch {
                return fallback;
            }
        }
        return data?.error || fallback;
    };

    const exportAnnotatedPdf = async () => {
        if (!contract.id) return;
        try {
            const response = await api.exportAnnotatedPdf(contract.id);
            const nameBase = String(contract.original_filename || 'contract')
                .replace(/\.[^.]+$/, '')
                .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
                || 'contract';
            downloadBlob(response.data, `${nameBase}-红线批注.pdf`);
            ElMessage.success('已导出红线批注 PDF（正文内红删除线+红下划线）');
        } catch (error) {
            ElMessage.error(await readBlobErrorMessage(error, '导出红线批注 PDF 失败。'));
        }
    };

    const exportRedlineVersion = async () => {
        if (!contract.id) return;
        try {
            const response = await api.exportRedlineVersion(contract.id);
            const nameBase = String(contract.original_filename || 'contract')
                .replace(/\.[^.]+$/, '')
                .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
                || 'contract';
            downloadBlob(response.data, `${nameBase}-红线批注稿.docx`);
            ElMessage.success('已导出红线批注 DOCX，可在 Word 中接受或拒绝修订');
        } catch (error) {
            ElMessage.error(await readBlobErrorMessage(error, '导出红线批注稿失败。'));
        }
    };

    return {
        selectedSuggestionIndexes, batchApplying, diffItems, diffLoading,
        contractVersions, versionsLoading,
        addDocComment, applyAutoAnnotations, adoptSuggestion, downloadBlob,
        applySelectedSuggestions, loadLatestDiff, loadContractVersions,
        openContractVersion, openCurrentEditable, compareVersionPair,
        exportReport, downloadPdfAnnotations, exportAnnotatedPdf, exportRedlineVersion,
        generateRedlineDraft, markCounterpartConfirmed, acceptAndExportFormal,
        exportFormalVersion, redlineStatus, canAdoptSuggestions,
    };
}
