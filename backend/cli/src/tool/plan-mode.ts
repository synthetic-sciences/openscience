// Tool definitions do not expose machine-readable side-effect or cost metadata.
// Keep Plan mode fail-closed: unknown, custom, and MCP tools stay blocked until
// their complete execution path is explicitly audited as read-only and free.
const SAFE = new Set(["invalid", "read", "list", "glob", "grep", "question", "recall", "todowrite"])
const REASON = "Plan mode is read-only and cannot execute, write, start jobs, upload, spend, or mutate state."
const ACTION = "Switch to Act/build mode, then retry the tool and approve any required permission."

export namespace PlanMode {
  export const CODE = "PLAN_MODE_SIDE_EFFECT_DENIED"

  export function enforce(tool: string, agent?: string) {
    if (agent !== "plan") return
    if (SAFE.has(tool)) return
    throw new DeniedError(tool)
  }

  export function run<T>(tool: string, agent: string | undefined, fn: () => T) {
    enforce(tool, agent)
    return fn()
  }

  export class DeniedError extends Error {
    readonly code = CODE
    readonly mode = "plan"
    readonly reason = REASON
    readonly action = ACTION

    constructor(readonly tool: string) {
      super(
        JSON.stringify({
          code: CODE,
          mode: "plan",
          tool,
          reason: REASON,
          action: ACTION,
        }),
      )
      this.name = "PlanModeDeniedError"
    }
  }
}
