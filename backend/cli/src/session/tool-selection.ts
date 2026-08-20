import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"

export namespace ToolSelection {
  export function enabled(
    tool: string,
    input: {
      permission: Agent.Info["permission"]
      tools?: Record<string, boolean>
    },
  ) {
    if (input.tools?.["*"] === false) return false
    if (input.tools?.[tool] === false) return false
    return !PermissionNext.disabled([tool], input.permission).has(tool)
  }
}
