import type { SheetChannelLine, SheetCueLine } from '@/types/sheet'
import { formatSeconds } from '@/utils/fade'

/** 单个字段的前后对照 */
export interface SheetFieldChange {
  /** 字段名，如「提示语」「CH3 亮度」 */
  label: string
  from: string
  to: string
}

/** 一条仍存在的 Cue 上发生的字段变化 */
export interface SheetChangedCue {
  cueId: string
  /** 当前编号（编号本身被改过时为改后的） */
  cueNo: string
  changes: SheetFieldChange[]
}

/** 新增 / 被去掉的 Cue 摘要 */
export interface SheetDiffCueRef {
  cueId: string
  cueNo: string
  label: string
}

/** 排演表快照与当前编排的对照结果 */
export interface SheetDiff {
  /** 生成排演表之后才加入编排的 Cue */
  added: SheetDiffCueRef[]
  /** 快照里有、当前编排里已不存在的 Cue */
  removed: SheetDiffCueRef[]
  /** 两边都在、但字段变过的 Cue */
  changed: SheetChangedCue[]
}

export const EMPTY_SHEET_DIFF: SheetDiff = { added: [], removed: [], changed: [] }

/** 对不上的条目总数：后来加的 + 被去掉的 + 有字段变化的 Cue 条数 */
export function sheetDiffTotal(diff: SheetDiff): number {
  return diff.added.length + diff.removed.length + diff.changed.length
}

function displayText(value: string | undefined): string {
  const text = (value ?? '').trim()
  return text === '' ? '（空）' : text
}

function describeChannel(line: SheetChannelLine): string {
  return `亮度 ${line.intensity}% / 色温 ${line.colorTempK}K`
}

/** 逐通道对照电平快照：新增 / 移除的通道与亮度、色温、对焦变化 */
function diffChannels(before: SheetChannelLine[], after: SheetChannelLine[]): SheetFieldChange[] {
  const changes: SheetFieldChange[] = []
  const beforeByChannel = new Map(before.map((line) => [line.channel, line]))
  const afterByChannel = new Map(after.map((line) => [line.channel, line]))
  const channelNos = Array.from(new Set([...beforeByChannel.keys(), ...afterByChannel.keys()])).sort((a, b) => a - b)

  channelNos.forEach((channel) => {
    const previous = beforeByChannel.get(channel)
    const current = afterByChannel.get(channel)
    if (previous && !current) {
      changes.push({ label: `CH${channel} 通道电平`, from: describeChannel(previous), to: '（已移除）' })
      return
    }
    if (!previous && current) {
      changes.push({ label: `CH${channel} 通道电平`, from: '（未设定）', to: describeChannel(current) })
      return
    }
    if (!previous || !current) return
    if (previous.intensity !== current.intensity) {
      changes.push({ label: `CH${channel} 亮度`, from: `${previous.intensity}%`, to: `${current.intensity}%` })
    }
    if (previous.colorTempK !== current.colorTempK) {
      changes.push({ label: `CH${channel} 色温`, from: `${previous.colorTempK}K`, to: `${current.colorTempK}K` })
    }
    if ((previous.focusNote ?? '') !== (current.focusNote ?? '')) {
      changes.push({ label: `CH${channel} 对焦`, from: displayText(previous.focusNote), to: displayText(current.focusNote) })
    }
  })
  return changes
}

/** 对照同一条 Cue 的快照与现状，逐项列出变过的字段 */
function diffCueLine(before: SheetCueLine, after: SheetCueLine): SheetFieldChange[] {
  const changes: SheetFieldChange[] = []
  const push = (label: string, from: string, to: string): void => {
    if (from !== to) changes.push({ label, from, to })
  }
  push('编号', before.cueNo, after.cueNo)
  push('提示语', displayText(before.label), displayText(after.label))
  push('触发方式', before.trigger, after.trigger)
  push('渐亮', formatSeconds(before.fadeInSec), formatSeconds(after.fadeInSec))
  push('保持', formatSeconds(before.holdSec), formatSeconds(after.holdSec))
  push('渐暗', formatSeconds(before.fadeOutSec), formatSeconds(after.fadeOutSec))
  push('备注', displayText(before.note), displayText(after.note))
  changes.push(...diffChannels(before.channels ?? [], after.channels ?? []))
  return changes
}

/**
 * 把排演表快照与当前编排条目逐条对照。
 * @param addedCueIds 生成排演表之后才创建的 Cue id（由调用方按 createdAt 判定），
 *                    其余不在快照里的现存 Cue 视为当初未勾选，不计入差异
 */
export function diffSheetLines(
  snapshot: SheetCueLine[],
  current: SheetCueLine[],
  addedCueIds: ReadonlySet<string>
): SheetDiff {
  const currentById = new Map(current.map((line) => [line.cueId, line]))
  const added = current
    .filter((line) => addedCueIds.has(line.cueId))
    .map((line) => ({ cueId: line.cueId, cueNo: line.cueNo, label: line.label }))
  const removed = snapshot
    .filter((line) => !currentById.has(line.cueId))
    .map((line) => ({ cueId: line.cueId, cueNo: line.cueNo, label: line.label }))
  const changed: SheetChangedCue[] = []
  snapshot.forEach((before) => {
    const after = currentById.get(before.cueId)
    if (!after) return
    const changes = diffCueLine(before, after)
    if (changes.length > 0) changed.push({ cueId: before.cueId, cueNo: after.cueNo, changes })
  })
  return { added, removed, changed }
}
