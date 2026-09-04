import type { Config } from "../config/config"

// Leaf module: the user-facing compaction settings and their defaults, with no runtime
// imports. Both the session loop (compaction.ts) and the settings route read from here,
// so the value the UI shows is the value the loop acts on, and the settings route can
// import it without pulling the session graph into a module cycle.
export namespace CompactionSettings {
  // Fraction of the usable context budget at which auto-compaction fires. 0.75
  // matches Claude Code / opencode: ~25% headroom so the NEXT turn (plus its
  // output) can't blow the hard limit before compaction runs. Overridable via
  // config.compaction.threshold.
  export const DEFAULT_THRESHOLD = 0.75

  export function resolve(config: Pick<Config.Info, "compaction">) {
    return {
      auto: config.compaction?.auto !== false,
      threshold: config.compaction?.threshold ?? DEFAULT_THRESHOLD,
    }
  }
}
