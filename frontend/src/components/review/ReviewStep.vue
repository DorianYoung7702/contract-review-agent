<template>
  <div class="flex-grow min-h-0 flex space-x-4">
    <!-- Left Side: OnlyOffice Editor -->
    <div class="w-2/3 bg-white rounded-lg shadow-md overflow-hidden h-full flex flex-col">
      <div class="px-3 py-2 border-b border-border-color bg-bg-subtle flex items-center justify-between gap-3">
        <div class="text-sm text-text-main">
          左侧为合同实时预览与编辑区。可选中文本后进行专项审查。
        </div>
        <button @click="prepareFocusedReviewFromSelection" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark">
          读取选中文本审查
        </button>
      </div>
      <DocumentEditor
        v-if="contract.editorConfig"
        id="docEditorComponent"
        ref="docEditorComponent"
        class="flex-grow min-h-0"
        :documentServerUrl="onlyOfficeUrl"
        :config="contract.editorConfig"
        :events_onDocumentReady="onDocumentReady"
        :events_onDocumentStateChange="onDocumentStateChange"
      />
      <div v-if="selectedSuggestionPreview" class="border-t border-border-color bg-white p-3 max-h-44 overflow-y-auto">
        <div class="flex items-center justify-between">
          <p class="text-sm font-semibold text-text-dark">最近采纳预览</p>
          <span class="text-xs text-green-700">{{ selectedSuggestionPreview.status }}</span>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-3 text-xs">
          <div>
            <p class="text-gray-500 font-medium">采纳前原文</p>
            <p class="mt-1 p-2 bg-red-50 text-red-800 border border-red-100 rounded whitespace-pre-line">{{ selectedSuggestionPreview.before }}</p>
          </div>
          <div>
            <p class="text-gray-500 font-medium">采纳后文本</p>
            <p class="mt-1 p-2 bg-green-50 text-green-800 border border-green-100 rounded whitespace-pre-line">{{ selectedSuggestionPreview.after }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Right Side: AI Review Panel -->
    <div class="w-1/3 bg-white rounded-lg shadow-md flex flex-col h-full">
      <!-- Panel Header -->
      <div class="review-panel-header">
        <div class="review-panel-title-row">
          <h3 class="text-lg font-semibold text-text-dark leading-none">AI 审查报告</h3>
          <label class="plain-language-toggle">
            <span>大白话模式</span>
            <el-switch v-model="showPlainLanguage" size="small"></el-switch>
          </label>
        </div>

        <div class="review-panel-toolbar">
          <div class="review-export-actions">
            <button
              @click="exportRedlineVersion"
              class="review-primary-action"
              title="带 Word 修订记录和审查批注的 DOCX"
            >
              导出红线 DOCX
            </button>
            <el-dropdown trigger="click" placement="bottom-end" @command="handleExportCommand">
              <button class="review-secondary-action" type="button">
                更多导出
                <svg viewBox="0 0 20 20" aria-hidden="true" class="h-4 w-4">
                  <path d="M5.75 7.5 10 11.75 14.25 7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="report-html">审查报告 · HTML</el-dropdown-item>
                  <el-dropdown-item command="report-word">审查报告 · Word</el-dropdown-item>
                  <el-dropdown-item command="redline-pdf">红线批注 · PDF</el-dropdown-item>
                  <el-dropdown-item command="formal-docx" divided>正式版 · DOCX</el-dropdown-item>
                  <el-dropdown-item command="annotations-txt">PDF 批注意见 · TXT</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>

          <div class="review-navigation-actions">
            <button v-if="cameFromHistory" @click="goBackToUpload" class="review-text-action">重新上传</button>
            <button @click="goBackSmart" class="review-text-action review-back-action">
              {{ cameFromHistory ? '返回历史' : '返回上一步' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Tab Navigation -->
      <div class="px-4 border-b border-border-color flex-shrink-0">
        <nav class="-mb-px grid grid-cols-4 gap-2">
          <button @click="activeAiTab = 'summary'" :class="[activeAiTab === 'summary' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">总览</button>
          <button @click="activeAiTab = 'suggestions'" :class="[activeAiTab === 'suggestions' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">修改</button>
          <button @click="activeAiTab = 'knowledge'" :class="[activeAiTab === 'knowledge' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">依据</button>
          <button @click="activeAiTab = 'workspace'" :class="[activeAiTab === 'workspace' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">工作台</button>
        </nav>
      </div>

      <!-- Tab Content -->
      <div class="p-3 overflow-y-auto flex-grow">
        <ReviewSummaryTab v-if="activeAiTab === 'summary'" />
        <ReviewSuggestionsTab v-if="activeAiTab === 'suggestions'" />
        <!-- Relevant Laws (Knowledge tab) -->
        <div v-if="activeAiTab === 'knowledge'">
          <div v-if="reviewData.relevant_laws && reviewData.relevant_laws.length > 0" class="space-y-4">
            <div v-for="(item, index) in reviewData.relevant_laws" :key="'law-' + index" :class="['p-4 rounded-md border', isLawOutdated(item) ? 'bg-red-50 border-red-200 border-l-4 border-l-red-500' : 'bg-blue-50 border-blue-100']">
              <div class="flex justify-between gap-3">
                <p class="font-bold text-blue-900">【{{ item.law }}】{{ item.clause }}</p>
                <el-tag v-if="isLawOutdated(item)" type="danger" size="small">{{ item.law_status === '已废止' ? '已废止' : '已修订' }}</el-tag>
                <el-tag v-else type="success" size="small">现行</el-tag>
              </div>
              <p class="mt-2 text-sm text-blue-900 leading-6">{{ item.content }}</p>
              <p v-if="isLawOutdated(item)" class="mt-2 text-xs text-red-700">{{ item.updateNotice || '该条文已被修订，仅作历史参考' }}</p>
            </div>
          </div>
          <div v-else class="text-center text-text-light py-8">未命中相关法条</div>
        </div>
        <ReviewWorkspaceTab v-if="activeAiTab === 'workspace'" />
      </div>
    </div>
  </div>
</template>

<script>
import { inject } from 'vue';
import { ElDropdown, ElDropdownItem, ElDropdownMenu, ElSwitch, ElTag } from 'element-plus';
import { DocumentEditor } from '@onlyoffice/document-editor-vue';
import ReviewSummaryTab from './ReviewSummaryTab.vue';
import ReviewSuggestionsTab from './ReviewSuggestionsTab.vue';
import ReviewWorkspaceTab from './ReviewWorkspaceTab.vue';

export default {
  name: 'ReviewStep',
  components: {
    DocumentEditor, ElDropdown, ElDropdownItem, ElDropdownMenu, ElSwitch, ElTag,
    ReviewSummaryTab, ReviewSuggestionsTab, ReviewWorkspaceTab,
  },
  setup() {
    const review = inject('review');
    const {
      contract, onlyOfficeUrl, onDocumentReady, onDocumentStateChange,
      docEditorComponent, selectedSuggestionPreview,
      prepareFocusedReviewFromSelection,
      showPlainLanguage, exportReport, downloadPdfAnnotations, exportAnnotatedPdf, exportRedlineVersion, exportFormalVersion,
      cameFromHistory, goBackToUpload, goBackSmart,
      activeAiTab, reviewData, isLawOutdated,
    } = review;

    const handleExportCommand = (command) => {
      const handlers = {
        'report-html': () => exportReport('html'),
        'report-word': () => exportReport('word'),
        'redline-pdf': () => exportAnnotatedPdf(),
        'formal-docx': () => exportFormalVersion('docx'),
        'annotations-txt': () => downloadPdfAnnotations(),
      };
      handlers[command]?.();
    };

    return {
      contract, onlyOfficeUrl, onDocumentReady, onDocumentStateChange,
      docEditorComponent, selectedSuggestionPreview,
      prepareFocusedReviewFromSelection,
      showPlainLanguage, exportReport, downloadPdfAnnotations, exportAnnotatedPdf, exportRedlineVersion, exportFormalVersion,
      handleExportCommand,
      cameFromHistory, goBackToUpload, goBackSmart,
      activeAiTab, reviewData, isLawOutdated,
    };
  },
};
</script>

<style scoped>
.review-panel-header {
  @apply flex-shrink-0 border-b border-border-color bg-white p-3;
}

.review-panel-title-row {
  @apply flex min-w-0 items-center justify-between gap-3;
}

.plain-language-toggle {
  @apply flex flex-shrink-0 cursor-pointer items-center gap-2 rounded-full bg-bg-subtle px-2.5 py-1 text-xs text-text-light;
}

.review-panel-toolbar {
  @apply mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2;
}

.review-export-actions,
.review-navigation-actions {
  @apply flex items-center gap-2;
}

.review-primary-action,
.review-secondary-action,
.review-text-action {
  @apply inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1;
}

.review-primary-action {
  @apply bg-primary text-white shadow-sm hover:bg-primary-dark;
}

.review-secondary-action {
  @apply gap-1 border border-border-color bg-white text-text-main hover:border-primary hover:bg-primary-light hover:text-primary-dark;
}

.review-text-action {
  @apply px-2 text-text-light hover:bg-bg-subtle hover:text-primary-dark;
}

.review-back-action {
  @apply text-primary;
}

@media (max-width: 1280px) {
  .review-navigation-actions {
    @apply w-full justify-end border-t border-border-color pt-2;
  }
}
</style>
