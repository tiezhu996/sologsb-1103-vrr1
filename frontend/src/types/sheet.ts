import type { FixturePosition, FixtureType } from '@/types/fixture'
import type { CueTrigger } from '@/types/cue'

/** 排演表中的一行通道明细（生成时快照，便于历史留档） */
export interface SheetChannelLine {
  channel: number
  position: FixturePosition
  fixtureType: FixtureType
  gel: string
  intensity: number
  colorTempK: number
  focusNote: string
}

/** 排演表中的一条 Cue 条目 */
export interface SheetCueLine {
  cueId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  fadeInSec: number
  fadeOutSec: number
  holdSec: number
  note: string
  channels: SheetChannelLine[]
}

/** 排演表（RehearsalSheet）：勾选若干 Cue 组合出的可导出表 */
export interface RehearsalSheet {
  /** 主键 */
  id: string
  /** 所属场次 */
  sessionId: string
  /** 排演表编号，形如 `RS-20250925-01`；按当前编排更新时沿用原编号 */
  sheetNo: string
  /** 版本号：同一编号下每次「按当前编排更新」递增，老数据缺省视为 1 */
  version?: number
  /** 生成时间，ISO 字符串 */
  generatedAt: string
  /** 生成时勾选的 Cue id 列表 */
  includedCueIds: string[]
  /** 生成时本场全部 Cue id，用于识别「后来加的 Cue」；老数据缺省时按创建时间回退判断 */
  knownCueIds?: string[]
  /** 制表备注，更新版本时沿用 */
  note: string
  /** 生成时的条目快照 */
  cueLines: SheetCueLine[]
}

/** 生成排演表时提交的字段集合 */
export interface SheetDraft {
  sessionId: string
  cueIds: string[]
  note: string
}

/** 单字段对照：哪一项从什么变成了什么 */
export interface SheetFieldChange {
  /** 字段名，例如「渐亮」「CH3 亮度」 */
  label: string
  /** 快照中的旧值（已格式化） */
  before: string
  /** 当前编排的新值（已格式化） */
  after: string
}

/** 一条仍然存在、但字段变过的 Cue */
export interface SheetCueChange {
  cueId: string
  /** 当前编号（编号本身被改时为新编号） */
  cueNo: string
  /** 当前提示语 */
  label: string
  changes: SheetFieldChange[]
}

/** 生成排演表之后才插入的 Cue */
export interface SheetAddedCue {
  cueId: string
  cueNo: string
  label: string
}

/** 快照里还有、但已被删掉的 Cue */
export interface SheetRemovedCue {
  cueId: string
  cueNo: string
  label: string
}

/** 排演表与当前编排的对照结果 */
export interface SheetDrift {
  sheetId: string
  /** 后来加的 Cue */
  added: SheetAddedCue[]
  /** 被去掉的 Cue */
  removed: SheetRemovedCue[]
  /** 仍在、但字段变过的 Cue */
  changed: SheetCueChange[]
  /** 对不上的条数：新增 + 删除 + 变更的 Cue 条数 */
  staleCount: number
}
