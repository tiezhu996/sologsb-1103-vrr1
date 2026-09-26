import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RehearsalSheet, SheetChannelLine, SheetCueLine, SheetDraft } from '@/types/sheet'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { sortFixturesByChannel } from '@/utils/patch'
import { diffSheetLines, type SheetDiff } from '@/utils/sheetDiff'
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

  function sheetsOfSession(sessionId: string): RehearsalSheet[] {
    return sheetsSorted.value.filter((sheet) => sheet.sessionId === sessionId)
  }

  function sheetById(id: string): RehearsalSheet | null {
    return sheets.value.find((sheet) => sheet.id === id) ?? null
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

  /** 组装场次当前 Cue 的条目快照；传 cueIds 时只取勾选项 */
  function buildCueLines(sessionId: string, cueIds?: readonly string[]): SheetCueLine[] {
    const cueStore = useCueStore()
    const levelStore = useLevelStore()
    const fixtureStore = useFixtureStore()
    const fixtures = sortFixturesByChannel(fixtureStore.fixturesOfSession(sessionId))

    return cueStore
      .sortedCuesOfSession(sessionId)
      .filter((cue) => !cueIds || cueIds.includes(cue.id))
      .map((cue) => {
        const channels: SheetChannelLine[] = fixtures
          .map((fixture) => {
            const level = levelStore.levelOf(cue.id, fixture.id)
            if (!level) return null
            return {
              channel: fixture.channel,
              position: fixture.position,
              fixtureType: fixture.fixtureType,
              gel: fixture.gel,
              intensity: level.intensity,
              colorTempK: level.colorTempK,
              focusNote: level.focusNote
            }
          })
          .filter((line): line is SheetChannelLine => line !== null)

        return {
          cueId: cue.id,
          cueNo: cue.cueNo,
          label: cue.label,
          trigger: cue.trigger,
          fadeInSec: cue.fadeInSec,
          fadeOutSec: cue.fadeOutSec,
          holdSec: cue.holdSec,
          note: cue.note,
          channels
        }
      })
  }

  /** 依据勾选的 Cue 组装条目快照并落库 */
  async function createSheet(draft: SheetDraft): Promise<RehearsalSheet | null> {
    const cueLines = buildCueLines(draft.sessionId, draft.cueIds)
    if (cueLines.length === 0) return null

    const generatedAt = new Date()
    const created: RehearsalSheet = {
      id: createId('sheet'),
      sessionId: draft.sessionId,
      sheetNo: buildSheetNo(nextSequence(generatedAt), generatedAt),
      generatedAt: generatedAt.toISOString(),
      includedCueIds: cueLines.map((line) => line.cueId),
      note: draft.note,
      cueLines
    }
    await db.sheets.put(created)
    sheets.value = [...sheets.value, created]
    return created
  }

  /** 把一张排演表的快照与当前编排逐条对照（场次已删除时由调用方先行排除） */
  function diffSheet(sheet: RehearsalSheet): SheetDiff {
    const cueStore = useCueStore()
    const snapshotIds = new Set(sheet.cueLines.map((line) => line.cueId))
    const generatedAtMs = new Date(sheet.generatedAt).getTime()
    const addedCueIds = new Set(
      cueStore
        .cuesOfSession(sheet.sessionId)
        .filter((cue) => !snapshotIds.has(cue.id) && cue.createdAt > generatedAtMs)
        .map((cue) => cue.id)
    )
    return diffSheetLines(sheet.cueLines, buildCueLines(sheet.sessionId), addedCueIds)
  }

  /** 按当前编排重新生成一份：沿用原编号与制表备注，原表保留可对照 */
  async function refreshSheet(id: string): Promise<RehearsalSheet | null> {
    const target = sheetById(id)
    if (!target) return null
    const cueLines = buildCueLines(target.sessionId)
    if (cueLines.length === 0) return null

    const created: RehearsalSheet = {
      id: createId('sheet'),
      sessionId: target.sessionId,
      sheetNo: target.sheetNo,
      generatedAt: new Date().toISOString(),
      includedCueIds: cueLines.map((line) => line.cueId),
      note: target.note,
      cueLines,
      revisionOf: target.id
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
    sheetsOfSession,
    sheetById,
    hydrate,
    createSheet,
    diffSheet,
    refreshSheet,
    removeSheet,
    removeBySession
  }
})
