<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCheckbox,
  NInput,
  NModal,
  NSelect,
  NSwitch,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSheetStore } from '@/stores/sheetStore'
import type { RehearsalSheet, SheetDrift } from '@/types/sheet'
import { diffSheetAgainstCurrent } from '@/utils/sheetDiff'
import { buildSheetText, cueTotalSeconds, formatDateTime, formatSeconds } from '@/utils/fade'
import { buildSheetFilename, copyText, downloadTextFile } from '@/utils/export'

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const sessionStore = useSessionStore()
const cueStore = useCueStore()
const fixtureStore = useFixtureStore()
const levelStore = useLevelStore()
const sheetStore = useSheetStore()

const showAllSessions = ref(false)
const note = ref('')
const previewSheet = ref<RehearsalSheet | null>(null)
const driftSheet = ref<RehearsalSheet | null>(null)

const selectedSessionId = computed(() => sessionStore.currentSessionId ?? '')

const sessionOptions = computed(() =>
  sessionStore.sortedSessions.map((session) => ({ label: `${session.order}. ${session.title}`, value: session.id }))
)

const cues = computed(() => (selectedSessionId.value ? cueStore.sortedCuesOfSession(selectedSessionId.value) : []))
const selectedCount = computed(() => cues.value.filter((cue) => cueStore.isSelected(cue.id)).length)

const sheets = computed(() =>
  showAllSessions.value ? sheetStore.sheetsSorted : sheetStore.sheetsOfSession(selectedSessionId.value)
)

const previewText = computed(() => {
  if (!previewSheet.value) return ''
  return buildSheetText(previewSheet.value, sessionStore.sessionById(previewSheet.value.sessionId) ?? undefined)
})

/**
 * 各排演表与当前编排的对照结果。
 * 只对照每个编号系列的最新版，且只收录确实对不上的——没被动过的表不在这里出现。
 */
const driftMap = computed(() => {
  const map = new Map<string, SheetDrift>()
  sheetStore.sheets.forEach((sheet) => {
    if (!sheetStore.isLatestVersion(sheet)) return
    if (!sessionStore.sessionById(sheet.sessionId)) return
    const drift = diffSheetAgainstCurrent(sheet, {
      cues: cueStore.cuesOfSession(sheet.sessionId),
      fixtures: fixtureStore.fixturesOfSession(sheet.sessionId),
      levels: levelStore.levels
    })
    if (drift.staleCount > 0) map.set(sheet.id, drift)
  })
  return map
})

const previewDrift = computed(() => (previewSheet.value ? driftMap.value.get(previewSheet.value.id) ?? null : null))
const currentDrift = computed(() => (driftSheet.value ? driftMap.value.get(driftSheet.value.id) ?? null : null))
const nextVersion = computed(() => (driftSheet.value ? (driftSheet.value.version ?? 1) + 1 : 1))

function driftOf(sheet: RehearsalSheet): SheetDrift | null {
  return driftMap.value.get(sheet.id) ?? null
}

function openDrift(sheet: RehearsalSheet): void {
  driftSheet.value = sheet
}

/** 从预览弹窗跳转进变更对照 */
function openDriftFromPreview(): void {
  if (!previewSheet.value) return
  driftSheet.value = previewSheet.value
  previewSheet.value = null
}

/** 确认后按当前编排生成新一版，旧版仍保留可对照 */
async function confirmRefresh(): Promise<void> {
  if (!driftSheet.value) return
  const refreshed = await sheetStore.refreshSheet(driftSheet.value.id)
  if (!refreshed) {
    message.info('编排已与这张表一致，无需更新')
    driftSheet.value = null
    return
  }
  message.success(`已按当前编排生成 ${refreshed.sheetNo} v${refreshed.version ?? 1}，旧版仍保留可对照`)
  driftSheet.value = null
}

function handleSessionChange(value: string | number | Array<string | number> | null): void {
  if (typeof value === 'string') sessionStore.setCurrentSession(value)
}

function handleShowAll(value: string | number | boolean): void {
  showAllSessions.value = value === true
}

function selectAll(): void {
  cueStore.setSelection(cues.value.map((cue) => cue.id))
}

function invertSelection(): void {
  cueStore.setSelection(cues.value.filter((cue) => !cueStore.isSelected(cue.id)).map((cue) => cue.id))
}

function clearSelection(): void {
  cueStore.clearSelection()
}

async function generateSheet(): Promise<void> {
  if (!selectedSessionId.value) {
    message.warning('请先选择场次')
    return
  }
  if (selectedCount.value === 0) {
    message.warning('请至少勾选一条 Cue')
    return
  }
  const created = await sheetStore.createSheet({
    sessionId: selectedSessionId.value,
    cueIds: cues.value.filter((cue) => cueStore.isSelected(cue.id)).map((cue) => cue.id),
    note: note.value.trim()
  })
  if (!created) {
    message.error('生成失败：勾选的 Cue 已不存在')
    return
  }
  message.success(`已生成 ${created.sheetNo}，包含 ${created.cueLines.length} 条 Cue`)
  note.value = ''
  cueStore.clearSelection()
}

function sheetTitle(sheet: RehearsalSheet): string {
  const session = sessionStore.sessionById(sheet.sessionId)
  return session ? `${session.order}. ${session.title}` : '（场次已删除）'
}

function cueNoSummary(sheet: RehearsalSheet): string {
  return sheet.cueLines.map((line) => line.cueNo).join('、')
}

function totalOf(sheet: RehearsalSheet): string {
  const total = sheet.cueLines.reduce(
    (sum, line) => sum + cueTotalSeconds({ fadeInSec: line.fadeInSec, holdSec: line.holdSec, fadeOutSec: line.fadeOutSec }),
    0
  )
  return formatSeconds(total)
}

async function handleCopy(sheet: RehearsalSheet): Promise<void> {
  const ok = await copyText(buildSheetText(sheet, sessionStore.sessionById(sheet.sessionId) ?? undefined))
  if (ok) message.success('排演表文本已复制到剪贴板')
  else message.error('复制失败，请改用下载')
}

function handleDownload(sheet: RehearsalSheet): void {
  downloadTextFile(
    buildSheetFilename(sheet.sheetNo, sheet.generatedAt, sheet.version ?? 1),
    buildSheetText(sheet, sessionStore.sessionById(sheet.sessionId) ?? undefined)
  )
  message.success('已导出纯文本排演表')
}

function confirmRemove(sheet: RehearsalSheet): void {
  dialog.warning({
    title: '删除排演表',
    content: `将删除 ${sheet.sheetNo}（生成于 ${formatDateTime(sheet.generatedAt)}），不影响场次与 Cue。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await sheetStore.removeSheet(sheet.id)
      message.success('排演表已删除')
    }
  })
}

function goCues(): void {
  if (!selectedSessionId.value) {
    void router.push('/sessions')
    return
  }
  void router.push(`/sessions/${selectedSessionId.value}/cues`)
}

function goSessions(): void {
  void router.push('/sessions')
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">排演表生成与导出</h1>
        <p class="page__subtitle">
          勾选若干 Cue 组合成排演表并本地留存历史；之后编排动过，列表会标出对不上的条数，可逐条对照后再更新出新版。
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goSessions">场次编排</NButton>
        <NButton @click="goCues">Cue 时间轴</NButton>
      </div>
    </header>

    <NAlert v-if="sessionStore.sortedSessions.length === 0" type="info" :bordered="false">
      还没有场次。请先在场次编排中创建场次并插入 Cue，再来生成排演表。
    </NAlert>

    <template v-else>
      <section class="panel">
        <h2 class="panel__title">选择 Cue<span class="panel__title-tag">勾选集合跨页保存在 cueStore</span></h2>

        <div class="sheet-toolbar">
          <NSelect
            :value="selectedSessionId || null"
            :options="sessionOptions"
            placeholder="选择场次"
            style="width: 260px"
            @update:value="handleSessionChange"
          />
          <NButton size="small" @click="selectAll">全选本场</NButton>
          <NButton size="small" @click="invertSelection">反选</NButton>
          <NButton size="small" quaternary @click="clearSelection">清空勾选</NButton>
          <span class="toolbar__spacer" />
          <NTag size="small" :bordered="false" type="warning">
            已勾选 {{ selectedCount }} / {{ cues.length }}
          </NTag>
        </div>

        <div v-if="cues.length === 0" class="sheet-empty">
          <BlankHint
            title="本场还没有 Cue"
            description="排演表由 Cue 组合而成。先到 Cue 编排时间轴插入提示点，再回来勾选生成。"
            action-text="去插入 Cue"
            @action="goCues"
          />
        </div>

        <div v-else class="cue-select-list">
          <label
            v-for="cue in cues"
            :key="cue.id"
            class="cue-select"
            :class="{ 'cue-select--checked': cueStore.isSelected(cue.id) }"
          >
            <NCheckbox :checked="cueStore.isSelected(cue.id)" @update:checked="() => cueStore.toggleSelected(cue.id)" />
            <span class="cue-select__no mono">{{ cue.cueNo }}</span>
            <span class="cue-select__label">{{ cue.label || '（未填写提示语）' }}</span>
            <NTag size="tiny" :bordered="false">{{ cue.trigger }}</NTag>
            <span class="cue-select__duration mono">{{ formatSeconds(cueTotalSeconds(cue)) }}</span>
          </label>
        </div>

        <div class="sheet-generate">
          <NInput v-model:value="note" placeholder="制表备注，例如「技术合成第 2 版」" style="max-width: 420px" />
          <NButton type="primary" :disabled="selectedCount === 0" @click="generateSheet">生成排演表</NButton>
        </div>
      </section>

      <section class="panel">
        <div class="sheet-history-head">
          <h2 class="panel__title">历史排演表<span class="panel__title-tag">共 {{ sheets.length }} 张</span></h2>
          <span class="sheet-history-head__switch">
            <span class="muted">显示全部场次</span>
            <NSwitch :value="showAllSessions" size="small" @update:value="(value) => handleShowAll(value)" />
          </span>
        </div>

        <BlankHint
          v-if="sheets.length === 0"
          title="还没有生成过排演表"
          description="勾选上半部分的 Cue 后点击「生成排演表」，历史记录会保存在浏览器本地。"
          tip="排演表以生成时的快照留档；之后编排有变动会标出对不上的条数，对照确认后可更新出新版，旧版仍保留。"
        />

        <div v-else class="sheet-list">
          <article v-for="sheet in sheets" :key="sheet.id" class="sheet-card">
            <div class="sheet-card__head">
              <span class="sheet-card__no mono">{{ sheet.sheetNo }}</span>
              <NTag size="tiny" :bordered="false">v{{ sheet.version ?? 1 }}</NTag>
              <NTag v-if="!sheetStore.isLatestVersion(sheet)" size="tiny" :bordered="false" type="default">旧版</NTag>
              <NTag v-if="driftOf(sheet)" size="tiny" :bordered="false" type="warning">
                对不上 {{ driftOf(sheet)!.staleCount }} 条
              </NTag>
              <span class="toolbar__spacer" />
              <span class="sheet-card__time mono">{{ formatDateTime(sheet.generatedAt) }}</span>
            </div>

            <p class="sheet-card__cues mono">{{ cueNoSummary(sheet) || '（空表）' }}</p>

            <div class="sheet-card__meta">
              <span>{{ sheetTitle(sheet) }}</span>
              <span>Cue {{ sheet.cueLines.length }} 条</span>
              <span>过渡合计 {{ totalOf(sheet) }}</span>
              <span v-if="sheet.note">备注：{{ sheet.note }}</span>
            </div>

            <div class="sheet-card__actions">
              <NButton size="tiny" @click="previewSheet = sheet">预览</NButton>
              <NButton v-if="driftOf(sheet)" size="tiny" type="warning" @click="openDrift(sheet)">变更对照</NButton>
              <NButton size="tiny" quaternary @click="handleCopy(sheet)">复制文本</NButton>
              <NButton size="tiny" quaternary @click="handleDownload(sheet)">下载 .txt</NButton>
              <NButton size="tiny" quaternary type="error" @click="confirmRemove(sheet)">删除</NButton>
            </div>
          </article>
        </div>
      </section>
    </template>

    <NModal
      :show="previewSheet !== null"
      preset="card"
      :title="previewSheet ? `排演表预览 · ${previewSheet.sheetNo} v${previewSheet.version ?? 1}` : '排演表预览'"
      class="preview-modal"
      @update:show="(value) => { if (!value) previewSheet = null }"
    >
      <NAlert v-if="previewDrift" type="warning" :bordered="false" class="preview-drift">
        <div class="preview-drift__row">
          <span>这张表与当前编排有 {{ previewDrift.staleCount }} 条对不上。</span>
          <NButton size="tiny" type="warning" @click="openDriftFromPreview">查看变更对照</NButton>
        </div>
      </NAlert>
      <pre class="preview-text">{{ previewText }}</pre>
      <template #footer>
        <div class="modal-footer">
          <NButton @click="previewSheet = null">关闭</NButton>
          <NButton v-if="previewSheet" quaternary @click="handleCopy(previewSheet)">复制文本</NButton>
          <NButton v-if="previewSheet" type="primary" @click="handleDownload(previewSheet)">下载 .txt</NButton>
        </div>
      </template>
    </NModal>

    <NModal
      :show="driftSheet !== null"
      preset="card"
      :title="driftSheet ? `变更对照 · ${driftSheet.sheetNo} v${driftSheet.version ?? 1}` : '变更对照'"
      class="drift-modal"
      @update:show="(value) => { if (!value) driftSheet = null }"
    >
      <template v-if="driftSheet">
        <NAlert v-if="currentDrift" type="warning" :bordered="false" class="drift-summary">
          生成后编排动过，共 {{ currentDrift.staleCount }} 条对不上。确认后将按当前编排生成
          {{ driftSheet.sheetNo }} v{{ nextVersion }}，沿用原编号与制表备注，这一版仍保留可对照。
        </NAlert>
        <NAlert v-else type="success" :bordered="false" class="drift-summary">
          这张表已与当前编排一致，没有需要更新的内容。
        </NAlert>

        <template v-if="currentDrift">
          <section v-if="currentDrift.added.length > 0" class="drift-section">
            <h3 class="drift-section__title">后来加的 Cue（{{ currentDrift.added.length }}）</h3>
            <div v-for="item in currentDrift.added" :key="item.cueId" class="drift-cue-row">
              <span class="drift-cue-row__no mono">{{ item.cueNo }}</span>
              <span class="drift-cue-row__label">{{ item.label || '（未填写提示语）' }}</span>
            </div>
          </section>

          <section v-if="currentDrift.removed.length > 0" class="drift-section">
            <h3 class="drift-section__title">被去掉的 Cue（{{ currentDrift.removed.length }}）</h3>
            <div v-for="item in currentDrift.removed" :key="item.cueId" class="drift-cue-row">
              <span class="drift-cue-row__no mono">{{ item.cueNo }}</span>
              <span class="drift-cue-row__label">{{ item.label || '（未填写提示语）' }}</span>
            </div>
          </section>

          <section v-if="currentDrift.changed.length > 0" class="drift-section">
            <h3 class="drift-section__title">变过的字段（{{ currentDrift.changed.length }} 条 Cue）</h3>
            <div v-for="cue in currentDrift.changed" :key="cue.cueId" class="drift-cue-block">
              <header class="drift-cue-block__head">
                <span class="drift-cue-block__no mono">{{ cue.cueNo }}</span>
                <span>{{ cue.label || '（未填写提示语）' }}</span>
              </header>
              <div v-for="change in cue.changes" :key="change.label" class="drift-field">
                <span class="drift-field__label">{{ change.label }}</span>
                <span class="drift-field__before">{{ change.before }}</span>
                <span class="drift-field__arrow">→</span>
                <span class="drift-field__after">{{ change.after }}</span>
              </div>
            </div>
          </section>
        </template>
      </template>

      <template #footer>
        <div class="modal-footer">
          <NButton @click="driftSheet = null">取消</NButton>
          <NButton v-if="currentDrift" type="primary" @click="confirmRefresh">
            按当前编排更新为 v{{ nextVersion }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.sheet-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.sheet-empty {
  margin-top: 14px;
}

.cue-select-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
  max-height: 360px;
  overflow-y: auto;
  padding-right: 4px;
}

.cue-select {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease;
}

.cue-select:hover {
  background: rgba(255, 255, 255, 0.045);
}

.cue-select--checked {
  border-color: rgba(242, 181, 68, 0.55);
  background: rgba(242, 181, 68, 0.08);
}

.cue-select__no {
  font-weight: 600;
  color: #f2b544;
  min-width: 62px;
}

.cue-select__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.cue-select__duration {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.sheet-generate {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.sheet-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sheet-history-head__switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.sheet-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 12px;
}

.sheet-card {
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sheet-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sheet-card__no {
  font-weight: 600;
  color: #f2b544;
}

.sheet-card__time {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
}

.sheet-card__cues {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  line-height: 1.7;
  word-break: break-all;
}

.sheet-card__meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.sheet-card__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.preview-modal {
  width: 720px;
  max-width: 94vw;
}

.preview-drift {
  margin-bottom: 12px;
}

.preview-drift__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.drift-modal {
  width: 640px;
  max-width: 94vw;
}

.drift-summary {
  margin-bottom: 14px;
}

.drift-section {
  margin-bottom: 16px;
}

.drift-section__title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.75);
}

.drift-cue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 13px;
}

.drift-cue-row + .drift-cue-row {
  margin-top: 6px;
}

.drift-cue-row__no {
  min-width: 56px;
  font-weight: 600;
  color: #f2b544;
}

.drift-cue-row__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.75);
}

.drift-cue-block {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.drift-cue-block + .drift-cue-block {
  margin-top: 8px;
}

.drift-cue-block__head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
  margin-bottom: 6px;
}

.drift-cue-block__no {
  font-weight: 600;
  color: #f2b544;
}

.drift-field {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 1.9;
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
}

.drift-field__label {
  min-width: 96px;
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.45);
}

.drift-field__before {
  color: rgba(255, 255, 255, 0.45);
  text-decoration: line-through;
  text-decoration-color: rgba(255, 255, 255, 0.25);
  word-break: break-all;
}

.drift-field__arrow {
  color: rgba(255, 255, 255, 0.35);
  flex-shrink: 0;
}

.drift-field__after {
  color: #f2b544;
  word-break: break-all;
}

.preview-text {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  padding: 14px 16px;
  border-radius: 10px;
  background: #0b0d12;
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.75;
  white-space: pre;
  color: rgba(255, 255, 255, 0.82);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
