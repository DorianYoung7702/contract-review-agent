<template>
  <main class="home-page">
    <section class="hero-section">
      <div class="hero-content">
        <p class="eyebrow">合同审查工作台</p>
        <h1>云伽智能AI合同审查工作台</h1>
        <p class="hero-copy">上传合同后，按步骤确认范围、查看结论，并在同一页面完成修改建议采纳。</p>
        <button class="primary-button" @click="startNewReview">开始审查</button>
      </div>
      <aside class="hero-config" aria-label="API 快速配置">
        <div class="config-head">
          <div>
            <p class="eyebrow">集成配置</p>
            <h2>API 快速更换</h2>
          </div>
          <button class="secondary-button config-refresh" type="button" :disabled="configLoading" @click="loadRuntimeConfig">
            {{ configLoading ? '读取中' : '刷新' }}
          </button>
        </div>
        <div class="config-cards">
          <button type="button" class="config-card" @click="openConfigDialog('llm')">
            <div class="config-card-top">
              <span class="config-label">DeepSeek</span>
              <span :class="['config-dot', configStatus.llm ? 'on' : 'off']" />
            </div>
            <p class="config-title">大模型 API</p>
            <p class="config-meta">{{ configPreview.llmModel || '未配置模型' }}</p>
            <p class="config-meta muted">{{ configStatus.llm ? 'Key 已配置 · 点击更换' : '未配置 · 点击填写' }}</p>
          </button>
          <button type="button" class="config-card" @click="openConfigDialog('embedding')">
            <div class="config-card-top">
              <span class="config-label">RAG</span>
              <span :class="['config-dot', configStatus.embedding ? 'on' : 'off']" />
            </div>
            <p class="config-title">向量 Embedding</p>
            <p class="config-meta">{{ configPreview.embeddingModel || 'BAAI/bge-m3' }}</p>
            <p class="config-meta muted">{{ configStatus.embedding ? '已配置 · 可探测/重嵌入' : '需硅基流动 Key' }}</p>
          </button>
        </div>
      </aside>
    </section>

    <el-dialog
      v-model="configDialogVisible"
      :title="configDialogTitle"
      width="520px"
      destroy-on-close
      class="runtime-config-dialog"
    >
      <div v-if="configDialogType === 'llm'" class="config-form">
        <label>
          <span>Base URL</span>
          <input v-model="llmForm.base_url" type="text" placeholder="https://api.deepseek.com/v1" />
        </label>
        <label>
          <span>API Key</span>
          <input v-model="llmForm.api_key" type="password" autocomplete="off" :placeholder="llmKeyPlaceholder" />
        </label>
        <label>
          <span>模型</span>
          <input v-model="llmForm.model" type="text" placeholder="deepseek-v4-flash" />
        </label>
        <p class="form-hint">留空密钥则保持原值不变。保存后立即生效，无需重启后端。</p>
      </div>
      <div v-else-if="configDialogType === 'embedding'" class="config-form">
        <label>
          <span>Embedding Base URL</span>
          <input v-model="embeddingForm.base_url" type="text" placeholder="https://api.siliconflow.cn/v1" />
        </label>
        <label>
          <span>Embedding API Key</span>
          <input v-model="embeddingForm.api_key" type="password" autocomplete="off" :placeholder="embeddingKeyPlaceholder" />
        </label>
        <label>
          <span>Embedding 模型</span>
          <input v-model="embeddingForm.model" type="text" placeholder="BAAI/bge-m3" />
        </label>
        <label>
          <span>Rerank Base URL</span>
          <input v-model="rerankForm.base_url" type="text" placeholder="https://api.siliconflow.cn/v1" />
        </label>
        <label>
          <span>Rerank API Key（可空=复用 Embedding Key）</span>
          <input v-model="rerankForm.api_key" type="password" autocomplete="off" :placeholder="rerankKeyPlaceholder" />
        </label>
        <label>
          <span>Rerank 模型</span>
          <input v-model="rerankForm.model" type="text" placeholder="BAAI/bge-reranker-v2-m3" />
        </label>
        <p class="form-hint">DeepSeek 不能做向量。请用硅基流动等支持 /embeddings 与 /rerank 的服务。改 Key 后需「探测」通过再「重嵌入」知识库，评测数字才有效。</p>
        <div class="form-actions-inline">
          <button class="rc-btn rc-btn-secondary" type="button" :disabled="embeddingBusy" @click="probeEmbedding">
            {{ embeddingBusy ? '处理中...' : '探测 Embedding/Rerank' }}
          </button>
          <button class="rc-btn rc-btn-secondary" type="button" :disabled="embeddingBusy" @click="runReembed">
            {{ embeddingBusy ? '处理中...' : '重嵌入知识库' }}
          </button>
        </div>
        <p v-if="embeddingProbeText" class="form-hint">{{ embeddingProbeText }}</p>
      </div>
      <template #footer>
        <button class="rc-btn rc-btn-secondary" type="button" @click="configDialogVisible = false">取消</button>
        <button class="rc-btn rc-btn-primary" type="button" :disabled="configSaving" @click="saveRuntimeConfig">
          {{ configSaving ? '保存中...' : '保存并生效' }}
        </button>
      </template>
    </el-dialog>

    <section class="content-grid">
      <div class="workflow-panel">
        <div class="section-head">
          <p class="eyebrow">审查步骤</p>
          <h2>四步完成审查</h2>
        </div>
        <div class="workflow-list">
          <article v-for="item in workflow" :key="item.title" class="workflow-item" :style="{ '--accent': item.color }">
            <span>{{ item.step }}</span>
            <div>
              <h3>{{ item.title }}</h3>
              <p>{{ item.copy }}</p>
            </div>
          </article>
        </div>
      </div>

      <div class="history-panel">
        <div class="section-head history-head">
          <div>
            <p class="eyebrow">审查记录</p>
            <h2>最近处理的合同</h2>
          </div>
          <button class="secondary-button" @click="fetchHistory">刷新</button>
        </div>

        <!-- 搜索与筛选 -->
        <div v-if="history.length > 0" class="history-filters">
          <input
            v-model="searchKeyword"
            class="history-search-input"
            type="text"
            placeholder="按文件名搜索..."
          />
          <select v-model="statusFilter" class="history-filter-select">
            <option value="">全部状态</option>
            <option value="Reviewed">已完成</option>
            <option value="Uploaded">已上传</option>
            <option value="PreAnalyzed">待确认</option>
          </select>
          <select v-model="typeFilter" class="history-filter-select">
            <option value="">全部类型</option>
            <option v-for="t in availableContractTypes" :key="t" :value="t">{{ t }}</option>
          </select>
          <select v-model="decisionFilter" class="history-filter-select">
            <option value="">全部决策</option>
            <option value="MANUAL">法务待办</option>
            <option value="PASS">自动通过</option>
            <option value="REJECT">自动驳回</option>
          </select>
          <select v-model="sourceFilter" class="history-filter-select">
            <option value="">全部来源</option>
            <option value="dingtalk">钉钉</option>
            <option value="web">网页</option>
          </select>
          <select v-model="confirmationFilter" class="history-filter-select">
            <option value="">确认状态</option>
            <option value="pending">待确认</option>
            <option value="confirmed">已确认</option>
            <option value="rejected">已驳回确认</option>
          </select>
        </div>

        <div v-if="loading" class="empty-block">正在加载审查记录...</div>
        <div v-else-if="error" class="empty-block danger">{{ error }}</div>
        <div v-else-if="history.length === 0" class="empty-block">
          <h3>暂无审查记录</h3>
          <p>开始审查后，记录会显示在这里。</p>
        </div>
        <div v-else-if="filteredHistory.length === 0" class="empty-block">
          <h3>未匹配到记录</h3>
          <p>请调整搜索关键词或筛选条件。</p>
        </div>
        <HistoryTable
          v-else
          :items="pagedHistory"
          :page="historyPage"
          :total-pages="totalHistoryPages"
          @view="viewReport"
          @delete="deleteReport"
          @update:page="historyPage = $event"
        />
      </div>
    </section>

    <GroupReportModal
      :visible="groupReportVisible"
      :loading="groupReportLoading"
      :report="groupReport"
      @close="closeGroupReport"
    />
  </main>
</template>

<script>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElDialog } from 'element-plus';
import api from '../api';
import GroupReportModal from '../components/GroupReportModal.vue';
import HistoryTable from '../components/HistoryTable.vue';
import { useHomeHistory, formatDate, statusText } from '../composables/useHomeHistory';

export default {
  name: 'HomeView',
  components: { GroupReportModal, HistoryTable, ElDialog },
  setup() {
    const router = useRouter();
    const groupReportVisible = ref(false);
    const groupReportLoading = ref(false);
    const groupReport = ref(null);

    const configLoading = ref(false);
    const configSaving = ref(false);
    const configDialogVisible = ref(false);
    const configDialogType = ref('llm');
    const runtimeConfig = ref({ llm: {}, embedding: {}, rerank: {} });
    const llmForm = reactive({ base_url: '', api_key: '', model: '' });
    const embeddingForm = reactive({ base_url: '', api_key: '', model: 'BAAI/bge-m3' });
    const rerankForm = reactive({ base_url: '', api_key: '', model: 'BAAI/bge-reranker-v2-m3' });
    const embeddingBusy = ref(false);
    const embeddingProbeText = ref('');

    const configDialogTitle = computed(() => {
      if (configDialogType.value === 'llm') return '配置 DeepSeek API';
      return '配置 RAG Embedding / Rerank';
    });

    const {
      history, loading, error, historyPage,
      searchKeyword, statusFilter, typeFilter, decisionFilter, sourceFilter, confirmationFilter,
      availableContractTypes, filteredHistory, totalHistoryPages, pagedHistory,
      fetchHistory, deleteReport,
    } = useHomeHistory();

    const configStatus = computed(() => ({
      llm: Boolean(runtimeConfig.value?.llm?.api_key_configured),
      embedding: Boolean(runtimeConfig.value?.embedding?.api_key_configured),
    }));

    const configPreview = computed(() => ({
      llmModel: runtimeConfig.value?.llm?.model || '',
      embeddingModel: runtimeConfig.value?.embedding?.model || '',
    }));

    const llmKeyPlaceholder = computed(() => (
      runtimeConfig.value?.llm?.api_key_masked
        ? `已配置 ${runtimeConfig.value.llm.api_key_masked}，留空不修改`
        : 'sk-...'
    ));
    const embeddingKeyPlaceholder = computed(() => (
      runtimeConfig.value?.embedding?.api_key_masked
        ? `已配置 ${runtimeConfig.value.embedding.api_key_masked}，留空不修改`
        : '硅基流动 sk-...'
    ));
    const rerankKeyPlaceholder = computed(() => (
      runtimeConfig.value?.rerank?.api_key_masked
        ? `已配置 ${runtimeConfig.value.rerank.api_key_masked}，留空不修改`
        : '可留空复用 Embedding Key'
    ));

    const loadRuntimeConfig = async () => {
      configLoading.value = true;
      try {
        const res = await api.getRuntimeConfig();
        runtimeConfig.value = res.data || { llm: {}, embedding: {}, rerank: {} };
      } catch (err) {
        ElMessage.error(err.response?.data?.error || '读取 API 配置失败');
      } finally {
        configLoading.value = false;
      }
    };

    const openConfigDialog = (type) => {
      configDialogType.value = type;
      const llm = runtimeConfig.value?.llm || {};
      const embedding = runtimeConfig.value?.embedding || {};
      const rerank = runtimeConfig.value?.rerank || {};
      llmForm.base_url = llm.base_url || 'https://api.deepseek.com/v1';
      llmForm.model = llm.model || '';
      llmForm.api_key = '';
      embeddingForm.base_url = embedding.base_url || 'https://api.siliconflow.cn/v1';
      embeddingForm.model = embedding.model || 'BAAI/bge-m3';
      embeddingForm.api_key = '';
      rerankForm.base_url = rerank.base_url || embedding.base_url || 'https://api.siliconflow.cn/v1';
      rerankForm.model = rerank.model || 'BAAI/bge-reranker-v2-m3';
      rerankForm.api_key = '';
      embeddingProbeText.value = '';
      configDialogVisible.value = true;
    };

    const saveRuntimeConfig = async () => {
      configSaving.value = true;
      try {
        let payload = {};
        if (configDialogType.value === 'llm') {
          payload = {
            llm: {
              base_url: llmForm.base_url,
              model: llmForm.model,
              api_key: llmForm.api_key,
            },
          };
        } else if (configDialogType.value === 'embedding') {
          payload = {
            embedding: {
              base_url: embeddingForm.base_url,
              model: embeddingForm.model,
              api_key: embeddingForm.api_key,
              allow_hash_fallback: false,
            },
            rerank: {
              base_url: rerankForm.base_url || embeddingForm.base_url,
              model: rerankForm.model,
              api_key: rerankForm.api_key,
            },
          };
        }
        const res = await api.updateRuntimeConfig(payload);
        runtimeConfig.value = {
          llm: res.data?.llm || {},
          embedding: res.data?.embedding || {},
          rerank: res.data?.rerank || {},
        };
        configDialogVisible.value = false;
        ElMessage.success('配置已保存并立即生效');
      } catch (err) {
        ElMessage.error(err.response?.data?.error || '保存失败');
      } finally {
        configSaving.value = false;
      }
    };

    const probeEmbedding = async () => {
      embeddingBusy.value = true;
      embeddingProbeText.value = '';
      try {
        const res = await api.probeEmbeddingConfig();
        const emb = res.data?.embedding || {};
        const rr = res.data?.rerank || {};
        embeddingProbeText.value = `Embedding: ${emb.ok ? `OK (${emb.model}, dim=${emb.dim})` : `FAIL ${emb.error}`}；Rerank: ${rr.ok ? `OK (${rr.model})` : `FAIL ${rr.error}`}`;
        if (emb.ok && rr.ok) ElMessage.success('Embedding / Rerank 探测通过');
        else ElMessage.warning('探测未完全通过，请检查 Key 与模型名');
      } catch (err) {
        ElMessage.error(err.response?.data?.error || '探测失败');
      } finally {
        embeddingBusy.value = false;
      }
    };

    const runReembed = async () => {
      embeddingBusy.value = true;
      try {
        ElMessage.info('开始重嵌入（全量可能较久，请耐心等待）');
        const res = await api.reembedKnowledge({});
        embeddingProbeText.value = `重嵌入完成：${res.data?.updated}/${res.data?.total}，backend=${res.data?.backend}，dim=${res.data?.dim}`;
        ElMessage.success('知识库重嵌入完成，可运行 npm run eval:rag');
      } catch (err) {
        ElMessage.error(err.response?.data?.error || '重嵌入失败');
      } finally {
        embeddingBusy.value = false;
      }
    };

    const viewReport = async (item) => {
      if (item.record_type !== 'group') {
        router.push({ path: '/review', query: { contract_id: item.id } });
        return;
      }
      groupReportVisible.value = true;
      groupReportLoading.value = true;
      groupReport.value = null;
      try {
        const response = await api.getContractGroup(item.id);
        groupReport.value = response.data;
      } catch (err) {
        ElMessage.error('加载关联合同分析报告失败。');
        groupReportVisible.value = false;
      } finally {
        groupReportLoading.value = false;
      }
    };

    const closeGroupReport = () => {
      groupReportVisible.value = false;
      groupReport.value = null;
    };

    const startNewReview = () => {
      localStorage.removeItem('review_session');
      router.push({ path: '/review' });
    };

    const workflow = [
      { step: '01', title: '上传合同', color: '#3b82f6', copy: '选择文件，进入在线预览。' },
      { step: '02', title: '确认范围', color: '#ec4899', copy: '确认立场、重点和目标。' },
      { step: '03', title: '查看结果', color: '#ef4444', copy: '集中查看风险和建议。' },
      { step: '04', title: '采纳修改', color: '#111111', copy: '把修改同步到文档。' },
    ];

    onMounted(() => {
      loadRuntimeConfig();
    });

    return {
      workflow,
      history, loading, error, historyPage,
      groupReportVisible, groupReportLoading, groupReport,
      totalHistoryPages, pagedHistory,
      fetchHistory, formatDate, statusText,
      viewReport, closeGroupReport, deleteReport, startNewReview,
      searchKeyword, statusFilter, typeFilter, decisionFilter, sourceFilter, confirmationFilter,
      availableContractTypes, filteredHistory,
      configLoading, configSaving, configDialogVisible, configDialogType, configDialogTitle,
      llmForm, embeddingForm, rerankForm, configStatus, configPreview,
      llmKeyPlaceholder,
      embeddingKeyPlaceholder, rerankKeyPlaceholder, embeddingBusy, embeddingProbeText,
      loadRuntimeConfig, openConfigDialog, saveRuntimeConfig, probeEmbedding, runReembed,
    };
  },
};
</script>

<style scoped>
.home-page {
  height: calc(100vh - 56px);
  overflow: hidden;
  background: #ffffff;
  color: #111111;
  font-size: 13px;
}

.hero-section {
  position: relative;
  width: calc(100% - 36px);
  max-width: 1180px;
  min-height: 196px;
  margin: 12px auto 0;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 12px;
  background: #f7f7f7;
  box-shadow: inset 0 0 0 1px #e5e5e5;
}

.hero-content {
  position: relative;
  z-index: 1;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 640px;
  padding: 22px 28px;
  color: #111111;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.hero-config {
  flex: 0 0 420px;
  max-width: 440px;
  margin: 12px 12px 12px 0;
  padding: 12px;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: inset 0 0 0 1px #e5e5e5;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.config-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
}

.config-head h2 {
  margin: 0;
  font-size: 15px;
  line-height: 1.25;
  font-weight: 850;
}

.config-refresh {
  min-height: 28px !important;
  padding: 0 10px !important;
  font-size: 12px;
}

.config-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.form-actions-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.config-card {
  text-align: left;
  padding: 10px;
  border-radius: 8px;
  background: #fafafa;
  box-shadow: inset 0 0 0 1px #e5e5e5;
  color: #111111;
  transition: background 0.15s ease, box-shadow 0.15s ease;
}

.config-card:hover {
  background: #ffffff;
  box-shadow: inset 0 0 0 1px #111111;
}

.config-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.config-label {
  font-size: 11px;
  font-weight: 800;
  color: #666666;
}

.config-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d4d4d4;
}

.config-dot.on {
  background: #16a34a;
}

.config-dot.off {
  background: #f59e0b;
}

.config-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 850;
  line-height: 1.25;
}

.config-meta {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: #444444;
  word-break: break-all;
}

.config-meta.muted {
  color: #888888;
}

.config-form {
  display: grid;
  gap: 12px;
}

.config-form label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: #333333;
}

.config-form input,
.config-form select {
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  outline: none;
  background: #fff;
}

.config-form input:focus,
.config-form select:focus {
  border-color: #111111;
}

.form-hint {
  margin: 0;
  font-size: 12px;
  color: #888888;
  line-height: 1.45;
  font-weight: 500;
}

.eyebrow {
  margin: 0 0 5px;
  color: inherit;
  opacity: 0.66;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0;
}

h1, h2, h3, p {
  letter-spacing: 0;
}

h1 {
  margin: 0;
  font-size: clamp(26px, 3.4vw, 40px);
  line-height: 1.08;
  font-weight: 850;
}

.hero-copy {
  max-width: 620px;
  margin: 8px 0 14px;
  color: #555555;
  font-size: 14px;
  line-height: 1.55;
}

button {
  border: 0;
  border-radius: 8px;
  font-weight: 800;
  cursor: pointer;
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.primary-button,
.secondary-button {
  min-height: 34px;
  padding: 0 13px;
}

.primary-button {
  background: #111111;
  color: #ffffff;
}

.secondary-button {
  background: #ffffff;
  color: #111111;
  box-shadow: inset 0 0 0 1px #e5e5e5;
}

.content-grid {
  height: calc(100vh - 288px);
  max-width: 1180px;
  margin: 12px auto 0;
  padding: 0 18px 12px;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 12px;
}

.workflow-panel,
.history-panel {
  min-height: 0;
  border-radius: 8px;
  padding: 14px;
  background: #ffffff;
  box-shadow: inset 0 0 0 1px #e5e5e5, 0 10px 26px rgba(0, 0, 0, 0.04);
}

.workflow-panel {
  overflow: auto;
}

.history-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.section-head {
  margin-bottom: 10px;
}

.section-head h2 {
  margin: 0;
  font-size: 19px;
  line-height: 1.24;
}

.history-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
}

.workflow-list {
  display: grid;
  gap: 8px;
}

.workflow-item {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 9px;
  align-items: start;
  border-radius: 8px;
  padding: 10px;
  background: #fafafa;
  box-shadow: inset 0 0 0 1px #e5e5e5;
}

.workflow-item span {
  color: var(--accent);
  font-size: 12px;
  font-weight: 900;
}

.workflow-item h3 {
  margin: 0 0 3px;
  font-size: 14px;
  line-height: 1.25;
}

.workflow-item p,
.empty-block {
  margin: 0;
  color: #666666;
  line-height: 1.45;
}

.empty-block {
  padding: 26px;
  text-align: center;
  background: #fafafa;
  border-radius: 8px;
}

.empty-block h3 {
  margin: 0 0 5px;
  color: #111111;
  font-size: 16px;
}

.empty-block.danger {
  color: #ef4444;
}

.history-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.history-search-input,
.history-filter-select {
  padding: 6px 10px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  background: #fff;
}

.history-search-input {
  flex: 1;
  min-width: 160px;
}

.history-search-input:focus,
.history-filter-select:focus {
  border-color: #3b82f6;
}

.history-filter-select {
  cursor: pointer;
}

@media (max-width: 900px) {
  .home-page {
    height: auto;
    overflow: visible;
  }

  .content-grid {
    height: auto;
    grid-template-columns: 1fr;
  }

  .hero-section {
    width: calc(100% - 28px);
    flex-direction: column;
    align-items: stretch;
  }

  .hero-content {
    max-width: none;
    padding-bottom: 8px;
  }

  .hero-config {
    flex: none;
    max-width: none;
    margin: 0 12px 12px;
  }
}

@media (max-width: 520px) {
  .config-cards {
    grid-template-columns: 1fr;
  }
}
</style>

<style>
.runtime-config-dialog .el-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.rc-btn {
  min-height: 34px;
  padding: 0 13px;
  border: 0;
  border-radius: 8px;
  font-weight: 800;
  cursor: pointer;
}
.rc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.rc-btn-primary { background: #111111; color: #ffffff; }
.rc-btn-secondary { background: #ffffff; color: #111111; box-shadow: inset 0 0 0 1px #e5e5e5; }
</style>
