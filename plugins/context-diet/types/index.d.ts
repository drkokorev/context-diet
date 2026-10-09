export type DietCutKind = 'log' | 'json' | 'diff' | 'grep' | 'paths' | 'table'

export type DietCut = {
  /** when it was cut, ms since epoch; also the cut's id in the panel */
  at: number
  tool: string
  /** the command, pattern or tool the output came from, shortened */
  label: string
  kind: DietCutKind
  /** characters the tool returned */
  raw: number
  /** characters the model read instead */
  kept: number
  /** where the full output was saved, absolute */
  path: string
  /** the start of what the model read */
  preview: string
  /** what the cut kept, in words */
  keptWhat: string
  /** set when the output came from a subagent */
  agentId?: string
  /** Claude Code had already saved this output to a file; the digest replaced its preview */
  isUpgrade?: true
}

export type DietToolTotals = { cuts: number; raw: number; kept: number }

export type DietStats = {
  startedAt: number
  cuts: number
  rawChars: number
  keptChars: number
  /** large outputs seen but left whole (cut would not save enough, or excluded) */
  passed: number
  /** previews of outputs Claude Code saved to a file, replaced by a digest */
  upgrades: number
  byTool: Record<string, DietToolTotals>
  log: DietCut[]
  lifetimeSaved: number
  lifetimeCuts: number
}

export type DietPrefs = {
  isOn: boolean
  /** outputs longer than this many characters get cut */
  threshold: number
  isStatusOn: boolean
  isToastOn: boolean
}

export type DietView = { openCut: number; isPlaced: boolean; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'context-diet': { stats: DietStats; prefs: DietPrefs; view: DietView }
  }
}
