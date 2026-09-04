import { Log } from "@/util/log"

/**
 * Connect-path milestones, in milliseconds since process start. One INFO line
 * is written when the workspace reports that it became interactive, so a
 * regression on any leg is visible in the sidecar log without a profiler.
 *
 * `instance` is the first Instance.provide of any directory; on the desktop
 * that is the server-cwd instance the global routes mint. `project` is the
 * first instance for any other directory, the leg that used to dominate the
 * connect path, and stays unset while only the cwd instance exists.
 */
export namespace Startup {
  const log = Log.create({ service: "startup" })

  const marks = {
    listening: undefined as number | undefined,
    instance: undefined as number | undefined,
    project: undefined as number | undefined,
    interactive: undefined as number | undefined,
  }

  const now = () => Math.round(performance.now())

  export function listening() {
    if (marks.listening !== undefined) return
    marks.listening = now()
  }

  export function instance(kind: "cwd" | "project") {
    if (marks.instance === undefined) marks.instance = now()
    if (kind === "cwd" || marks.project !== undefined) return
    marks.project = now()
  }

  export function interactive(extra: Record<string, unknown> = {}) {
    if (marks.interactive !== undefined) return
    marks.interactive = now()
    // The marks win: `extra` arrives from the workspace through the log route,
    // and any client on the port can post one, so it cannot rewrite a leg.
    log.info("timing", {
      ...extra,
      listening: marks.listening,
      instance: marks.instance,
      project: marks.project,
      interactive: marks.interactive,
    })
  }

  export function snapshot() {
    return { ...marks }
  }

  export function reset() {
    marks.listening = undefined
    marks.instance = undefined
    marks.project = undefined
    marks.interactive = undefined
  }
}
