import type { Cue } from '@/types/cue'
import type { Fixture } from '@/types/fixture'
import type { CueLevel } from '@/types/level'
import type {
  RehearsalSheet,
  SheetAddedCue,
  SheetChannelLine,
  SheetCueChange,
  SheetCueLine,
  SheetDrift,
  SheetFieldChange,
  SheetRemovedCue
} from '@/types/sheet'
import { sortCues } from '@/utils/cueOrder'
import { formatSeconds } from '@/utils/fade'
import { sortFixturesByChannel } from '@/utils/patch'

/** 对照所需的当前编排数据 */
export interface SheetDriftSource {
  /** 当前本场全部 Cue（顺序不限，函数内自行排序） */
  cues: Cue[]
  /** 当前本场全部灯位通道 */
  fixtures: Fixture[]
  /** 当前通道电平（可跨场次传入，函数内按 cueId 过滤） */
  levels: CueLevel[]
}

/** 文本值展示：空串显示为（空），其余加直角引号 */
function quoteText(value: string): string {
  return value ? `「${value}」` : '（空）'
}

/** 通道电平一行摘要，用于「新增 / 移除」对照 */
function summarizeChannel(line: SheetChannelLine): string {
  const base = `亮度 ${line.intensity}% / 色温 ${line.colorTempK}K`
  return line.focusNote ? `${base} / 对焦 ${line.focusNote}` : base
}

/** 字段值不同则记录一条对照 */
function compareField<T>(
  changes: SheetFieldChange[],
  label: string,
  before: T,
  after: T,
  format: (value: T) => string
): void {
  if (before === after) return
  changes.push({ label, before: format(before), after: format(after) })
}

/** 按当前灯位与电平记录，组装某条 Cue 的通道明细（与生成排演表时同一口径） */
export function buildChannelLines(
  cueId: string,
  fixtures: readonly Fixture[],
  levels: readonly CueLevel[]
): SheetChannelLine[] {
  const levelByFixture = new Map<string, CueLevel>()
  levels.forEach((level) => {
    if (level.cueId === cueId) levelByFixture.set(level.fixtureId, level)
  })
  return sortFixturesByChannel(fixtures)
    .map((fixture) => {
      const level = levelByFixture.get(fixture.id)
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
}

/** 对比一条 Cue 快照与当前 Cue，逐项列出变过的字段 */
function diffCueLine(line: SheetCueLine, cue: Cue, source: SheetDriftSource): SheetFieldChange[] {
  const changes: SheetFieldChange[] = []
  compareField(changes, '编号', line.cueNo, cue.cueNo, (value) => value)
  compareField(changes, '提示语', line.label, cue.label, quoteText)
  compareField(changes, '触发方式', line.trigger, cue.trigger, (value) => value)
  compareField(changes, '渐亮', line.fadeInSec, cue.fadeInSec, formatSeconds)
  compareField(changes, '保持', line.holdSec, cue.holdSec, formatSeconds)
  compareField(changes, '渐暗', line.fadeOutSec, cue.fadeOutSec, formatSeconds)
  compareField(changes, '备注', line.note, cue.note, quoteText)

  const beforeByChannel = new Map(line.channels.map((channel) => [channel.channel, channel]))
  const afterByChannel = new Map(
    buildChannelLines(cue.id, source.fixtures, source.levels).map((channel) => [channel.channel, channel])
  )
  const channelNos = Array.from(new Set([...beforeByChannel.keys(), ...afterByChannel.keys()])).sort((a, b) => a - b)
  channelNos.forEach((channelNo) => {
    const before = beforeByChannel.get(channelNo)
    const after = afterByChannel.get(channelNo)
    const prefix = `CH${channelNo}`
    if (before && !after) {
      changes.push({ label: `${prefix} 电平`, before: summarizeChannel(before), after: '（已移除）' })
      return
    }
    if (!before && after) {
      changes.push({ label: `${prefix} 电平`, before: '（未设定）', after: summarizeChannel(after) })
      return
    }
    if (before && after) {
      compareField(changes, `${prefix} 亮度`, before.intensity, after.intensity, (value) => `${value}%`)
      compareField(changes, `${prefix} 色温`, before.colorTempK, after.colorTempK, (value) => `${value}K`)
      compareField(changes, `${prefix} 对焦`, before.focusNote, after.focusNote, quoteText)
    }
  })

  return changes
}

/** 判断某条当前 Cue 是否为生成排演表之后才加的 */
function isAddedAfterGeneration(sheet: RehearsalSheet, cue: Cue): boolean {
  if (sheet.knownCueIds) return !sheet.knownCueIds.includes(cue.id)
  const generatedAtMs = Date.parse(sheet.generatedAt)
  return Number.isFinite(generatedAtMs) && cue.createdAt > generatedAtMs
}

/**
 * 把排演表快照与当前编排逐条对照：
 * 后来加的、被去掉的 Cue，以及仍在但字段变过的 Cue（含具体字段的前后值）。
 */
export function diffSheetAgainstCurrent(sheet: RehearsalSheet, source: SheetDriftSource): SheetDrift {
  const currentById = new Map(source.cues.map((cue) => [cue.id, cue]))
  const removed: SheetRemovedCue[] = []
  const changed: SheetCueChange[] = []

  sheet.cueLines.forEach((line) => {
    const current = currentById.get(line.cueId)
    if (!current) {
      removed.push({ cueId: line.cueId, cueNo: line.cueNo, label: line.label })
      return
    }
    const changes = diffCueLine(line, current, source)
    if (changes.length > 0) {
      changed.push({ cueId: current.id, cueNo: current.cueNo, label: current.label, changes })
    }
  })

  const added: SheetAddedCue[] = sortCues(source.cues)
    .filter((cue) => isAddedAfterGeneration(sheet, cue))
    .map((cue) => ({ cueId: cue.id, cueNo: cue.cueNo, label: cue.label }))

  return {
    sheetId: sheet.id,
    added,
    removed,
    changed,
    staleCount: added.length + removed.length + changed.length
  }
}
