import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import type { MessageV2 } from "@/session/message-v2"

/**
 * Which tools a session offers the model. Visibility follows permissions, as
 * in OpenCode: a tool is offered when the agent's ruleset does not deny it and
 * it belongs to the agent's default set, was unlocked by a skill loaded in the
 * current task epoch (`allowed-tools`), or is named by an explicit allow rule
 * in the ruleset. There is no keyword selection.
 */
export namespace ToolVisibility {
  /** The set every agent starts from. `edit`/`write` and `apply_patch` are
   * alternatives the registry picks by model family; `question` and
   * `research_search` still depend on the client and a configured provider. */
  export const DEFAULT: ReadonlySet<string> = new Set([
    "invalid",
    "bash",
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "apply_patch",
    "webfetch",
    "research_search",
    "literature",
    "recall",
    "todowrite",
    "task",
    "skill",
    "question",
    "python",
    "compute_job",
    "artifact",
  ])

  /** Permission plus the message's per-tool overrides decide whether a tool
   * may be called at all; a denied tool is never offered. */
  export function enabled(
    tool: string,
    input: {
      permission: PermissionNext.Ruleset
      tools?: Record<string, boolean>
    },
  ) {
    if (input.tools?.["*"] === false) return false
    if (input.tools?.[tool] === false) return false
    return !PermissionNext.disabled([tool], input.permission).has(tool)
  }

  /** Tools an agent's own ruleset opts in: a rule that names the tool (not
   * the wildcard) with a non-deny action. Evaluated on the agent's own rules,
   * never on the shared defaults, so access-mode policy about a tool does not
   * count as opting it in. */
  export function unlocks(rules: PermissionNext.Ruleset) {
    return [
      ...new Set(
        rules
          .filter((rule) => rule.permission !== "*" && rule.action !== "deny" && !DEFAULT.has(rule.permission))
          .map((rule) => rule.permission),
      ),
    ]
  }

  /** Capabilities and tools unlocked by skills loaded anywhere in the given
   * messages. Scanning a request's whole epoch keeps a skill's bundle offered
   * through the synthetic continuations of the same task. */
  export function activation(messages: readonly MessageV2.WithParts[]) {
    const capabilities = new Set<string>()
    const tools = new Set<string>()
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      for (const part of message.parts) {
        if (part.type !== "tool" || part.tool !== "skill" || part.state.status !== "completed") continue
        const metadata = part.state.metadata as { capability?: unknown; allowedTools?: unknown } | undefined
        if (typeof metadata?.capability === "string") capabilities.add(metadata.capability)
        if (!Array.isArray(metadata?.allowedTools)) continue
        for (const tool of metadata.allowedTools) if (typeof tool === "string") tools.add(tool)
      }
    }
    return { capabilities, tools }
  }

  /** Whether a tool the ruleset permits is actually on offer this turn. */
  export function offered(
    tool: string,
    input: {
      agent: Pick<Agent.Info, "unlocks">
      unlocked?: ReadonlySet<string>
      /** Project and plugin tools: installed deliberately, so offered by default. */
      extensions?: ReadonlySet<string>
    },
  ) {
    if (DEFAULT.has(tool)) return true
    if (input.unlocked?.has(tool)) return true
    if (input.extensions?.has(tool)) return true
    return input.agent.unlocks?.includes(tool) ?? false
  }
}
