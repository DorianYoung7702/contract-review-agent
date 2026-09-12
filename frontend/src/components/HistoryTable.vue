<template>
  <div class="table-wrap">
    <div class="table-scroll">
      <table class="record-table">
      <colgroup>
        <col class="col-file" />
        <col class="col-type" />
        <col class="col-perspective" />
        <col class="col-risk" />
        <col class="col-decision" />
        <col class="col-source" />
        <col class="col-confirm" />
        <col class="col-time" />
        <col class="col-status" />
        <col class="col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th>文件</th>
          <th>合同类型</th>
          <th>立场</th>
          <th>风险</th>
          <th>审批决策</th>
          <th>来源</th>
          <th>确认</th>
          <th>时间</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="`${item.record_type}-${item.id}`">
          <td class="file-cell">
            <div class="file-cell-inner">
              <span v-if="item.record_type === 'group'" class="record-type">多合同</span>
              <span class="file-name" :title="item.original_filename">{{ item.original_filename }}</span>
            </div>
          </td>
          <td class="type-cell" :title="item.contract_type || ''">{{ item.contract_type || '—' }}</td>
          <td class="perspective-cell" :title="item.perspective || ''">{{ item.perspective || '—' }}</td>
          <td class="risk-cell">
            <span v-if="item.risk_count > 0" class="risk-pill">{{ item.risk_count }}</span>
            <span v-else>—</span>
          </td>
          <td class="clip-cell">
            <span v-if="item.decision" :class="['decision-pill', item.decision]">{{ decisionText(item.decision) }}</span>
            <span v-else>—</span>
          </td>
          <td class="source-cell">
            <span :class="['source-pill', item.source || 'web']">{{ sourceText(item.source) }}</span>
            <span v-if="item.staff_nick" class="staff-nick" :title="item.staff_nick">{{ item.staff_nick }}</span>
          </td>
          <td class="clip-cell">
            <span :class="['confirm-pill', item.confirmation_status || 'none']">{{ confirmationText(item.confirmation_status) }}</span>
          </td>
          <td class="time-cell">{{ formatDate(item.created_at) }}</td>
          <td class="clip-cell"><span :class="['status-pill', item.status]">{{ statusText(item.status) }}</span></td>
          <td class="actions-cell">
            <div class="row-actions">
              <button class="text-button" @click="$emit('view', item)">查看</button>
              <el-popconfirm title="确认删除这份审查记录？" @confirm="$emit('delete', item)">
                <template #reference>
                  <button class="text-button danger">删除</button>
                </template>
              </el-popconfirm>
            </div>
          </td>
        </tr>
      </tbody>
      </table>
    </div>
    <div class="pager">
      <button :disabled="page === 1" @click="$emit('update:page', page - 1)">上一页</button>
      <span>第 {{ page }} / {{ totalPages }} 页</span>
      <button :disabled="page === totalPages" @click="$emit('update:page', page + 1)">下一页</button>
    </div>
  </div>
</template>

<script>
import { ElPopconfirm } from 'element-plus';
import {
  confirmationText, decisionText, formatDate, sourceText, statusText,
} from '../composables/useHomeHistory';

export default {
  name: 'HistoryTable',
  components: { ElPopconfirm },
  props: {
    items: { type: Array, default: () => [] },
    page: { type: Number, default: 1 },
    totalPages: { type: Number, default: 1 },
  },
  emits: ['view', 'delete', 'update:page'],
  setup() {
    return { formatDate, statusText, decisionText, sourceText, confirmationText };
  },
};
</script>

<style scoped>
.table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.table-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.record-table {
  width: 100%;
  min-width: 860px;
  border-collapse: collapse;
  table-layout: fixed;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px #e5e5e5;
}

.col-file { width: 22%; }
.col-type { width: 10%; }
.col-perspective { width: 9%; }
.col-risk { width: 6%; }
.col-decision { width: 9%; }
.col-source { width: 9%; }
.col-confirm { width: 8%; }
.col-time { width: 11%; }
.col-status { width: 8%; }
.col-actions { width: 8%; }

.record-table th,
.record-table td {
  min-height: 42px;
  height: 42px;
  padding: 8px 10px;
  border-bottom: 1px solid #eeeeee;
  text-align: left;
  vertical-align: middle;
  font-size: 12px;
  overflow: hidden;
}

.record-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  color: #666666;
  font-weight: 800;
  background: #fafafa;
  white-space: nowrap;
}

.file-cell {
  font-weight: 700;
}

.file-cell-inner {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}

.file-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-type {
  flex: 0 0 auto;
  display: inline-flex;
  border-radius: 8px;
  background: #e0f2fe;
  color: #075985;
  padding: 3px 6px;
  font-size: 11px;
  font-weight: 800;
  white-space: nowrap;
}

.status-pill {
  display: inline-flex;
  border-radius: 999px;
  padding: 4px 8px;
  background: #f5f5f5;
  color: #333333;
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
}

.status-pill.Reviewed {
  background: #dcfce7;
  color: #166534;
}

.status-pill.Uploaded,
.status-pill.PreAnalyzed {
  background: #dbeafe;
  color: #1d4ed8;
}

.type-cell,
.perspective-cell,
.time-cell,
.staff-nick {
  color: #666;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clip-cell,
.source-cell,
.actions-cell,
.risk-cell {
  overflow: hidden;
}

.risk-cell {
  text-align: center;
}

.risk-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: #fee2e2;
  color: #b91c1c;
  font-size: 12px;
  font-weight: 700;
}

.decision-pill {
  display: inline-flex;
  border-radius: 999px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 800;
  white-space: nowrap;
}

.decision-pill.PASS {
  background: #dcfce7;
  color: #166534;
}

.decision-pill.MANUAL {
  background: #fef3c7;
  color: #92400e;
}

.decision-pill.REJECT {
  background: #fee2e2;
  color: #b91c1c;
}

.source-pill {
  display: inline-flex;
  border-radius: 999px;
  padding: 3px 7px;
  font-size: 11px;
  font-weight: 800;
}

.source-pill.dingtalk {
  background: #e0f2fe;
  color: #075985;
}

.source-pill.web {
  background: #f3f4f6;
  color: #374151;
}

.staff-nick {
  display: block;
  margin-top: 2px;
  color: #888;
  font-size: 11px;
  max-width: 100%;
}

.confirm-pill {
  display: inline-flex;
  border-radius: 999px;
  padding: 3px 7px;
  font-size: 11px;
  font-weight: 800;
}

.confirm-pill.pending {
  background: #fef3c7;
  color: #92400e;
}

.confirm-pill.confirmed {
  background: #dcfce7;
  color: #166534;
}

.confirm-pill.rejected {
  background: #fee2e2;
  color: #b91c1c;
}

.confirm-pill.none {
  color: #999;
}

.row-actions,
.pager {
  display: flex;
  align-items: center;
  gap: 7px;
}

.text-button,
.pager button {
  background: #ffffff;
  color: #111111;
  padding: 6px 8px;
  box-shadow: inset 0 0 0 1px #e5e5e5;
  border: 0;
  border-radius: 8px;
  font-weight: 800;
  cursor: pointer;
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.text-button.danger {
  color: #ef4444;
}

.pager {
  flex: 0 0 auto;
  justify-content: flex-end;
  margin-top: 9px;
  color: #666666;
  font-size: 12px;
}
</style>
