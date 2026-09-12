import type { Experiments } from "."

/**
 * Kill criteria are the study owner's free-text policy for ending a run early:
 * "1 hour OR val_loss plateaus for 500 steps OR val_loss > 5 for 100 steps".
 * Rules are independent and any one firing kills the run. The parser accepts
 * the natural phrasings; anything it cannot read is reported back rather than
 * silently ignored, so a typo never becomes "no policy".
 */
export namespace KillCriteria {
  export type Rule =
    | { kind: "time"; seconds: number; text: string }
    | { kind: "steps"; steps: number; text: string }
    | { kind: "plateau"; key: string; window: number; text: string }
    | { kind: "threshold"; key: string; op: ">" | "<" | ">=" | "<="; value: number; window: number; text: string }

  export type Parsed = { rules: Rule[]; unparsed: string[] }

  const unit: Record<string, number> = {
    s: 1,
    sec: 1,
    secs: 1,
    second: 1,
    seconds: 1,
    m: 60,
    min: 60,
    mins: 60,
    minute: 60,
    minutes: 60,
    h: 3600,
    hr: 3600,
    hrs: 3600,
    hour: 3600,
    hours: 3600,
    d: 86400,
    day: 86400,
    days: 86400,
  }

  export function parse(text: string): Parsed {
    const rules: Rule[] = []
    const unparsed: string[] = []
    const clauses = text
      // Sentences are clauses too: a period followed by a space ends one
      // (decimals such as "5.0 for 10 steps" keep their digits together).
      .split(/\s+or\s+|[,;\n]+|\.\s+(?=[a-z])/i)
      .map((clause) => clause.trim())
      .filter(Boolean)
    for (const clause of clauses) {
      // "Kill any run after 2 minutes." reads as "2 minutes": drop the verb,
      // its object, the connective and trailing punctuation before matching.
      const lower = clause
        .toLowerCase()
        .replace(/[.!]+$/, "")
        .replace(
          /^(?:kill|stop|end|terminate|abort)\s+(?:(?:any|each|every|all|a|an|the)\s+)?(?:(?:runs?|jobs?|trials?)\s+)?(?:(?:after|at|once|when|if|that)\s+)?/,
          "",
        )
        .replace(
          /^(?:runs?\s+)?(?:that\s+)?(?:exceeds?|longer\s+than|(?:runs?|lasts?|takes?)\s+(?:for\s+)?(?:more|longer)\s+than)\s+/,
          "",
        )
        .replace(/\s+of\s+(?:wall[- ]?clock|training|runtime)$/, "")
        .trim()
      const time = /^(?:after\s+)?(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)$/.exec(
        lower,
      )
      if (time) {
        rules.push({ kind: "time", seconds: Number(time[1]) * unit[time[2]!]!, text: clause })
        continue
      }
      const steps = /^(?:after\s+)?(\d+)\s*steps?$/.exec(lower)
      if (steps) {
        rules.push({ kind: "steps", steps: Number(steps[1]), text: clause })
        continue
      }
      const plateau =
        /^([a-z0-9_./-]+)\s+(?:plateaus?|stalls?|stops?\s+improving|has\s+not\s+improved|no\s+improvement)\s+(?:for\s+|in\s+|over\s+)?(\d+)\s*steps?$/.exec(
          lower,
        )
      if (plateau) {
        rules.push({ kind: "plateau", key: plateau[1]!, window: Number(plateau[2]), text: clause })
        continue
      }
      // "no improvement for 500 steps" names no metric: the study's metric.
      const bare =
        /^(?:no\s+improvement|plateaus?|stalls?|stops?\s+improving)\s+(?:for\s+|in\s+|over\s+)?(\d+)\s*steps?$/.exec(
          lower,
        )
      if (bare) {
        rules.push({ kind: "plateau", key: "", window: Number(bare[1]), text: clause })
        continue
      }
      const threshold =
        /^([a-z0-9_./-]+)\s+(>=|<=|>|<|above|over|exceeds|below|under|is\s+above|is\s+below)\s+(-?\d+(?:\.\d+)?(?:e-?\d+)?)(?:\s+for\s+(\d+)\s*steps?)?$/.exec(
          lower,
        )
      if (threshold) {
        const word = threshold[2]!
        const op: ">" | "<" | ">=" | "<=" =
          word === ">=" || word === "<=" || word === ">" || word === "<"
            ? word
            : /above|over|exceeds/.test(word)
              ? ">"
              : "<"
        rules.push({
          kind: "threshold",
          key: threshold[1]!,
          op,
          value: Number(threshold[3]),
          window: threshold[4] ? Number(threshold[4]) : 1,
          text: clause,
        })
        continue
      }
      unparsed.push(clause)
    }
    return { rules, unparsed }
  }

  /** Loss-like names go down when they improve; score-like names go up. The
   * study's own metric follows the study's declared direction. */
  export function direction(key: string, study?: { metric: string; direction: Experiments.Direction }) {
    if (study && key === study.metric) return study.direction
    return /acc|accuracy|f1|auc|precision|recall|score|reward|bleu|rouge|iou|map|ndcg|psnr|ssim|r2/i.test(key)
      ? "maximize"
      : "minimize"
  }

  export type Snapshot = {
    startedAt: number
    now: number
    lastStep: number | null
    recent: (key: string, limit: number) => Array<{ step: number; value: number }>
  }

  /** The first rule that fires, as the reason to record on the run. */
  export function check(
    rules: Rule[],
    snapshot: Snapshot,
    study?: { metric: string; direction: Experiments.Direction },
  ): string | undefined {
    for (const rule of rules) {
      if (rule.kind === "time") {
        if (snapshot.now - snapshot.startedAt >= rule.seconds * 1000) return `time budget reached (${rule.text})`
        continue
      }
      if (rule.kind === "steps") {
        if (snapshot.lastStep !== null && snapshot.lastStep >= rule.steps) return `step budget reached (${rule.text})`
        continue
      }
      if (rule.kind === "plateau") {
        const key = rule.key || study?.metric
        if (!key) continue
        const window = snapshot.recent(key, rule.window * 4)
        if (window.length < 2) continue
        const last = window[window.length - 1]!
        const better =
          direction(key, study) === "maximize" ? (a: number, b: number) => a > b : (a: number, b: number) => a < b
        const best = window.reduce((acc, point) => (better(point.value, acc.value) ? point : acc), window[0]!)
        if (last.step - best.step >= rule.window) return `${key} plateaued for ${rule.window} steps (${rule.text})`
        continue
      }
      const window = snapshot.recent(rule.key, rule.window)
      if (window.length < rule.window) continue
      const compare = (value: number) =>
        rule.op === ">"
          ? value > rule.value
          : rule.op === "<"
            ? value < rule.value
            : rule.op === ">="
              ? value >= rule.value
              : value <= rule.value
      if (window.every((point) => compare(point.value))) {
        return `${rule.key} ${rule.op} ${rule.value} for ${rule.window} step${rule.window === 1 ? "" : "s"} (${rule.text})`
      }
    }
    return
  }
}
