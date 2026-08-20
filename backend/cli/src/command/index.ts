import { BusEvent } from "@/bus/bus-event"
import path from "node:path"
import z from "zod"
import { Config } from "../config/config"
import { ConfigMarkdown } from "../config/markdown"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import { MCP } from "../mcp"
import { State } from "../project/state"
import { BundledSkills } from "../skill/bundled"

export namespace Command {
  async function workflow(name: string) {
    const root = await BundledSkills.root()
    if (!root) throw new Error("Bundled research workflow skill is unavailable")
    const dir = path.join(root, "research", "research-workflows")
    const [skill, reference] = await Promise.all([
      ConfigMarkdown.parse(path.join(dir, "SKILL.md")),
      Bun.file(path.join(dir, "references", `${name}.md`)).text(),
    ])
    return [skill.content.trim(), reference.trim()].join("\n\n")
  }

  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: Identifier.schema("session"),
        arguments: z.string(),
        messageID: Identifier.schema("message"),
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      mcp: z.boolean().optional(),
      source: z.enum(["builtin", "project", "mcp"]).optional(),
      category: z.enum(["session", "research", "evidence", "output", "project"]).optional(),
      usage: z.string().optional(),
      // Surface this command in the composer slash menu. Only no-argument action
      // commands (e.g. /compact) should set it — arg-taking prompt-template
      // commands can't receive their args from that menu.
      menu: z.boolean().optional(),
      // workaround for zod not supporting async functions natively so we use getters
      // https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()),
      subtask: z.boolean().optional(),
      hints: z.array(z.string()),
    })
    .meta({
      ref: "Command",
    })

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

  export function hints(template: string): string[] {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  export const Default = {
    INIT: "init",
    PLAN: "plan",
    GOAL: "goal",
    STATUS: "status",
    CONTEXT: "context",
    STOP: "stop",
    COMPACT: "compact",
    HANDOFF: "handoff",
    CHECKPOINT: "checkpoint",
  } as const

  const compute = async () => {
    // Command templates may contain executable shell interpolation (`!` +
    // backticks). Project-owned command definitions therefore belong to the
    // same trust boundary as every other executable project setting.
    const cfg = await Config.getExecution()

    const result: Record<string, Info> = {
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        source: "builtin",
        category: "project",
        usage: "/init",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      [Default.PLAN]: {
        name: Default.PLAN,
        description: "enter read-only plan mode and produce a decision-ready plan",
        source: "builtin",
        category: "research",
        usage: "/plan [objective]",
        agent: "plan",
        get template() {
          return workflow(Default.PLAN)
        },
        subtask: false,
        hints: ["$ARGUMENTS"],
      },
      [Default.GOAL]: {
        name: Default.GOAL,
        description: "set a persistent objective and begin working toward it",
        source: "builtin",
        category: "research",
        usage: "/goal [objective]",
        get template() {
          return [
            "The user set a persistent goal for this session.",
            "Treat the durable research contract as the source of truth, begin pursuing the objective now, and continue until it is complete or genuinely blocked.",
            "Keep the user informed at meaningful milestones and verify the requested outcome before declaring completion.",
            "",
            "Objective:",
            "$ARGUMENTS",
          ].join("\n")
        },
        hints: ["$ARGUMENTS"],
      },
      [Default.STATUS]: {
        name: Default.STATUS,
        description: "show live session, plan, artifact, and workspace state",
        source: "builtin",
        category: "session",
        usage: "/status",
        menu: true,
        get template() {
          return ""
        },
        hints: [],
      },
      [Default.CONTEXT]: {
        name: Default.CONTEXT,
        description: "show context composition, capacity, and compaction state",
        source: "builtin",
        category: "session",
        usage: "/context",
        menu: true,
        get template() {
          return ""
        },
        hints: [],
      },
      [Default.STOP]: {
        name: Default.STOP,
        description: "stop the active turn, compute, or everything in this session",
        source: "builtin",
        category: "session",
        usage: "/stop [turn|compute|all]",
        menu: true,
        get template() {
          return ""
        },
        hints: [],
      },
      // Action command, not a prompt template — SessionPrompt.command intercepts
      // it and runs SessionCompaction directly. The empty template is never used.
      [Default.COMPACT]: {
        name: Default.COMPACT,
        description: "summarize the conversation so far to free up context",
        source: "builtin",
        category: "session",
        usage: "/compact [focus]",
        menu: true,
        get template() {
          return ""
        },
        hints: [],
      },
      [Default.HANDOFF]: {
        name: Default.HANDOFF,
        description: "write a self-contained handoff.md for another agent, then compact",
        source: "builtin",
        category: "session",
        usage: "/handoff [project-relative path]",
        menu: true,
        get template() {
          return ""
        },
        hints: [],
      },
      [Default.CHECKPOINT]: {
        name: Default.CHECKPOINT,
        description: "capture a local recovery packet from durable session state",
        source: "builtin",
        category: "session",
        usage: "/checkpoint [label]",
        menu: true,
        get template() {
          return ""
        },
        hints: [],
      },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = {
        name,
        source: "project",
        category: "project",
        agent: command.agent,
        model: command.model,
        description: command.description,
        get template() {
          return command.template
        },
        subtask: command.subtask,
        hints: hints(command.template),
      }
    }
    for (const [name, prompt] of Object.entries(await MCP.prompts())) {
      result[name] = {
        name,
        mcp: true,
        source: "mcp",
        description: prompt.description,
        get template() {
          // since a getter can't be async we need to manually return a promise here
          return new Promise<string>(async (resolve, reject) => {
            const template = await MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? // substitute each argument with $1, $2, etc.
                  Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            ).catch(reject)
            resolve(
              template?.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n") || "",
            )
          })
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      }
    }

    return result
  }

  const state = Instance.state(compute)

  /** Drop project-derived command and MCP-prompt definitions after an
   * authority transition. The next read rebuilds against current trust. */
  export function invalidate() {
    State.clear(Instance.directory, compute)
  }

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function list() {
    return state().then((x) => Object.values(x))
  }
}
