import { Log } from "@/util/log"

/**
 * Connect-path milestones, in milliseconds since process start. One INFO line
 * is written when the workspace reports that it became interactive, so a
 * regression on any leg (listening, first project instance, interactive) is
 * visible in the sidecar log without a profiler.
 */
export namespace Startup {
  const log = Log.create({ service: "startup" })

  const marks = {
    listening: undefined as number | undefined,
    instance: undefined as number | undefined,
    interactive: undefined as number | undefined,
  }

  const now = () => Math.round(performance.now())

  export function listening() {
    if (marks.listening !== undefined) return
    marks.listening = now()
  }

  export function instance() {
    if (marks.instance !== undefined) return
    marks.instance = now()
  }

  export function interactive(extra: Record<string, unknown> = {}) {
    if (marks.interactive !== undefined) return
    marks.interactive = now()
    log.info("timing", {
      listening: marks.listening,
      instance: marks.instance,
      interactive: marks.interactive,
      ...extra,
    })
  }

  export function snapshot() {
    return { ...marks }
  }

  export function reset() {
    marks.listening = undefined
    marks.instance = undefined
    marks.interactive = undefined
  }
}
