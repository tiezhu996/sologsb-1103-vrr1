import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RehearsalSheet, SheetCueLine, SheetDraft } from '@/types/sheet'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { buildChannelLines, diffSheetAgainstCurrent } from '@/utils/sheetDiff'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 以生成日期 + 序号拼排演表编号 */
function buildSheetNo(sequence: number, generatedAt: Date): string {
  return `RS-${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}-${pad(sequence)}`
}

/**
 * 排演表仓库：勾选 Cue 生成条目快照并本地留存历史。
 */
export const useSheetStore = defineStore('sheet', () => {
  const sheets = ref<RehearsalSheet[]>([])
  const hydrated = ref(false)

  const sheetsSorted = computed(() =>
    [...sheets.value].sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
  )

  /** 每个排演表编号目前的最高版本号 */
  const latestVersionBySheetNo = computed(() => {
    const map = new Map<string, number>()
    sheets.value.forEach((sheet) => {
      const version = sheet.version ?? 1
      if (version > (map.get(sheet.sheetNo) ?? 0)) map.set(sheet.sheetNo, version)
    })
    return map
  })

  function sheetsOfSession(sessionId: string): RehearsalSheet[] {
    return sheetsSorted.value.filter((sheet) => sheet.sessionId === sessionId)
  }

  function sheetById(id: string): RehearsalSheet | null {
    return sheets.value.find((sheet) => sheet.id === id) ?? null
  }

  /** 是否为该编号系列的最新一版（只有最新版才参与与当前编排的对照） */
  function isLatestVersion(sheet: RehearsalSheet): boolean {
    return (sheet.version ?? 1) >= (latestVersionBySheetNo.value.get(sheet.sheetNo) ?? 1)
  }

  /** 下一张排演表在当天内的序号 */
  function nextSequence(generatedAt: Date): number {
    const prefix = `RS-${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}-`
    const used = sheets.value
      .filter((sheet) => sheet.sheetNo.startsWith(prefix))
      .map((sheet) => Number.parseInt(sheet.sheetNo.slice(prefix.length), 10))
      .filter((value) => Number.isFinite(value))
    return used.length === 0 ? 1 : Math.max(...used) + 1
  }

  async function hydrate(): Promise<void> {
    sheets.value = await db.sheets.toArray()
    hydrated.value = true
  }

  /** 按当前时间轴顺序为给定 Cue 组装条目快照（生成与更新排演表共用同一口径） */
  function snapshotCueLines(sessionId: string, cueIds: readonly string[]): SheetCueLine[] {
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()
    const wanted = new Set(cueIds)
    const fixtures = fixtureStore.fixturesOfSession(sessionId)
    return cueStore
      .sortedCuesOfSession(sessionId)
      .filter((cue) => wanted.has(cue.id))
      .map((cue) => ({
        cueId: cue.id,
        cueNo: cue.cueNo,
        label: cue.label,
        trigger: cue.trigger,
        fadeInSec: cue.fadeInSec,
        fadeOutSec: cue.fadeOutSec,
        holdSec: cue.holdSec,
        note: cue.note,
        channels: buildChannelLines(cue.id, fixtures, levelStore.levels)
      }))
  }

  /** 依据勾选的 Cue 组装条目快照并落库 */
  async function createSheet(draft: SheetDraft): Promise<RehearsalSheet | null> {
    const cueStore = useCueStore()
    const cueLines = snapshotCueLines(draft.sessionId, draft.cueIds)
    if (cueLines.length === 0) return null

    const generatedAt = new Date()
    const created: RehearsalSheet = {
      id: createId('sheet'),
      sessionId: draft.sessionId,
      sheetNo: buildSheetNo(nextSequence(generatedAt), generatedAt),
      version: 1,
      generatedAt: generatedAt.toISOString(),
      includedCueIds: cueLines.map((line) => line.cueId),
      knownCueIds: cueStore.cuesOfSession(draft.sessionId).map((cue) => cue.id),
      note: draft.note,
      cueLines
    }
    await db.sheets.put(created)
    sheets.value = [...sheets.value, created]
    return created
  }

  /**
   * 按当前编排为排演表生成下一版：
   * 沿用原编号与制表备注，保留原先勾选（已删除的除外）并纳入后来加的 Cue；
   * 旧版原样留存，仍可翻出来对照。没有任何对不上的条目时返回 null。
   */
  async function refreshSheet(id: string): Promise<RehearsalSheet | null> {
    const target = sheetById(id)
    if (!target) return null
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()

    const drift = diffSheetAgainstCurrent(target, {
      cues: cueStore.cuesOfSession(target.sessionId),
      fixtures: fixtureStore.fixturesOfSession(target.sessionId),
      levels: levelStore.levels
    })
    if (drift.staleCount === 0) return null

    const currentIds = new Set(cueStore.cuesOfSession(target.sessionId).map((cue) => cue.id))
    const nextCueIds = [
      ...target.cueLines.map((line) => line.cueId).filter((cueId) => currentIds.has(cueId)),
      ...drift.added.map((item) => item.cueId)
    ]
    const cueLines = snapshotCueLines(target.sessionId, nextCueIds)

    const generatedAt = new Date()
    const created: RehearsalSheet = {
      id: createId('sheet'),
      sessionId: target.sessionId,
      sheetNo: target.sheetNo,
      version: (target.version ?? 1) + 1,
      generatedAt: generatedAt.toISOString(),
      includedCueIds: cueLines.map((line) => line.cueId),
      knownCueIds: cueStore.cuesOfSession(target.sessionId).map((cue) => cue.id),
      note: target.note,
      cueLines
    }
    await db.sheets.put(created)
    sheets.value = [...sheets.value, created]
    return created
  }

  async function removeSheet(id: string): Promise<void> {
    const target = sheetById(id)
    if (!target) return
    await db.sheets.delete(id)
    sheets.value = sheets.value.filter((sheet) => sheet.id !== id)
  }

  async function removeBySession(sessionId: string): Promise<void> {
    const targets = sheetsOfSession(sessionId)
    if (targets.length === 0) return
    await db.sheets.bulkDelete(targets.map((sheet) => sheet.id))
    sheets.value = sheets.value.filter((sheet) => sheet.sessionId !== sessionId)
  }

  return {
    sheets,
    hydrated,
    sheetsSorted,
    latestVersionBySheetNo,
    sheetsOfSession,
    sheetById,
    isLatestVersion,
    hydrate,
    createSheet,
    refreshSheet,
    removeSheet,
    removeBySession
  }
})
