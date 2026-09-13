import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SPECIALIST from "./prompt/specialist.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { State } from "@/project/state"
import { ProjectTrust } from "@/project/trust"
import { ProjectAccess } from "@/project/access"
import { randomUUID } from "node:crypto"
import { OpenScience } from "@/openscience"
import { BILLING_URL } from "@/endpoints"
import { requiresWalletBalance, resolveCredentialSource } from "@/session/access-route"
import { ToolVisibility } from "@/tool/visibility"
import { BIOLOGY_TOOL_IDS } from "@/tool/biology/ids"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
      /** Skill categories rendered into the agent's <domain-skills> index. */
      skills: z.array(z.string()).optional(),
      /** Tools offered without a skill unlock, beyond the shared default set. */
      unlocks: z.array(z.string()).optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const compute = async () => {
    const [cfg, projectAccess, trust] = await Promise.all([
      Config.getExecution(),
      ProjectAccess.status(Instance.project),
      ProjectTrust.status(Instance.project),
    ])
    const sandbox = projectAccess.sandbox
    const accessMode = !trust.canExecuteProjectCode ? "ask" : projectAccess.mode
    const boundaryAction = sandbox.enabled ? "ask" : "allow"

    let defaults = PermissionNext.fromConfig({
      "*": "allow",
      mcp: boundaryAction,
      doom_loop: boundaryAction,
      external_directory: {
        "*": boundaryAction,
      },
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      compute_job: boundaryAction,
      // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
      read: sandbox.enabled
        ? {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          }
        : "allow",
    })
    // The three user-facing action modes share the same persisted trust and
    // sandbox state that execution enforces. Built-in read-only denies remain
    // stricter, while their convenience allows below are mode-aware so Ask
    // cannot be bypassed; explicit advanced user policy still wins.
    const access = PermissionNext.fromConfig(
      accessMode === "ask"
        ? {
            atlas: "ask",
            bash: "ask",
            codesearch: "ask",
            compute_job: "ask",
            doom_loop: "ask",
            edit: "ask",
            environment_mutation: "ask",
            external_directory: "ask",
            generate_image: "ask",
            mcp: "ask",
            modal: "ask",
            network: "ask",
            provider_compute: "ask",
            remote_compute: "ask",
            webfetch: "ask",
            websearch: "ask",
          }
        : accessMode === "approve"
          ? {
              atlas: "ask",
              bash: "allow",
              codesearch: "ask",
              compute_job: "ask",
              doom_loop: "ask",
              edit: "allow",
              environment_mutation: "ask",
              external_directory: "ask",
              generate_image: "ask",
              mcp: "ask",
              modal: "ask",
              network: "ask",
              provider_compute: "ask",
              remote_compute: "ask",
              webfetch: "allow",
              websearch: "allow",
            }
          : {
              atlas: "allow",
              bash: "allow",
              codesearch: "allow",
              compute_job: "allow",
              doom_loop: "allow",
              edit: "allow",
              environment_mutation: "allow",
              external_directory: "allow",
              generate_image: "allow",
              mcp: "allow",
              modal: "allow",
              network: "allow",
              provider_compute: "allow",
              remote_compute: "allow",
              webfetch: "allow",
              websearch: "allow",
            },
    )
    defaults = PermissionNext.merge(defaults, access)
    const user = PermissionNext.fromConfig(cfg.permission ?? {})
    const safeAction = accessMode === "ask" ? "ask" : "allow"
    const externalAction = accessMode === "full" ? "allow" : "ask"

    const specialist = (input: {
      name: string
      label: string
      focus: string
      description: string
      color: string
      skills: string[]
      tools?: readonly string[]
    }): Info => {
      const own = PermissionNext.fromConfig({
        question: "deny",
        todowrite: "deny",
        task: "deny",
        ...Object.fromEntries((input.tools ?? []).map((tool) => [tool, "allow" as const])),
      })
      return {
        name: input.name,
        description: input.description,
        options: {},
        color: input.color,
        prompt: PROMPT_SPECIALIST.replaceAll("{label}", input.label).replaceAll("{focus}", input.focus),
        permission: PermissionNext.merge(defaults, own, user),
        mode: "subagent",
        native: true,
        hidden: true,
        skills: input.skills,
        unlocks: ToolVisibility.unlocks(own),
      }
    }

    const result: Record<string, Info> = {
      research: {
        name: "research",
        description: "Primary research agent for focused questions, analysis, synthesis, and durable outputs.",
        options: {},
        color: "#d48765",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_enter: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      plan: {
        name: "plan",
        description: "Plan mode. Disallows all edit tools.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_exit: "allow",
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",
              [path.join(".openscience", "plans", "*.md")]: "allow",
              [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          user,
        ),
        mode: "primary",
        native: true,
        hidden: true,
      },
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            read: "allow",
            bash: safeAction,
            // WebFetch owns a narrowly scoped brokered transfer. Without this
            // explicit rule the profile's wildcard deny blocks the broker's
            // per-host authorization before the webfetch allow can apply.
            network: externalAction,
            webfetch: safeAction,
            websearch: safeAction,
            literature: safeAction,
            codesearch: externalAction,
          }),
          user,
        ),
        description:
          'Fast scout for literature, data and code. Use it to find files by pattern, search file contents, locate a paper, definition or number, or answer a bounded question about the project without changing anything. Specify the thoroughness: "quick", "medium", or "very thorough".',
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
        hidden: true,
      },
      ml: specialist({
        name: "ml",
        label: "machine-learning specialist",
        focus: "training, fine-tuning, evaluation, inference, interpretability, and GPU compute setup",
        description:
          "Machine-learning specialist for data, training, evaluation, inference, and reproducible experiments.",
        color: "#6366f1",
        skills: ["ml-training", "llm-tools", "ml-inference", "cloud-compute"],
      }),
      biology: specialist({
        name: "biology",
        label: "biology specialist",
        focus: "sequences, omics, structures, pathways, and biological databases",
        description: "Biology specialist for bioinformatics, biological databases, and evidence-backed data analysis.",
        color: "#10b981",
        skills: ["biology", "databases"],
        tools: [...BIOLOGY_TOOL_IDS, "science_list_dbs", "science_search", "science_fetch"],
      }),
      physics: specialist({
        name: "physics",
        label: "physics specialist",
        focus: "simulation, numerical methods, dynamical systems, and physical data analysis",
        description:
          "Physics specialist for simulation, numerical methods, dimensional analysis, and validated scientific computing.",
        color: "#8b5cf6",
        skills: ["physics", "quantum"],
      }),
      chemistry: specialist({
        name: "chemistry",
        label: "chemistry specialist",
        focus: "molecules, cheminformatics, docking, property prediction, and chemical databases",
        description:
          "Chemistry specialist for cheminformatics, molecular modeling, property prediction, and chemical databases.",
        color: "#f59e0b",
        skills: ["chemistry", "databases"],
        tools: ["science_list_dbs", "science_search", "science_fetch"],
      }),
      data: specialist({
        name: "data",
        label: "data specialist",
        focus: "computational workflows: pipelines, data processing, coding, visualization, and cloud compute",
        description:
          "Data specialist for pipelines, data processing, coding, visualization, and cloud compute; the general execution worker.",
        color: "#0ea5e9",
        skills: ["data-engineering", "coding", "visualization", "cloud-compute"],
        tools: ["r"],
      }),
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
    }

    // Retired built-ins. A config that still tunes one must not resurrect it
    // as an anonymous custom agent with the default ruleset.
    const removed = new Set([
      "review",
      "reviewer",
      "artifact-reviewer",
      "researchagent-test",
      "write",
      "execute",
      "task",
      "literature-review",
      "critique",
      "physics-critique",
    ])
    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (removed.has(key)) continue
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, user),
          options: {},
          native: false,
        }
      if (value.model) item.model = Provider.parseModel(value.model)
      item.variant = value.variant ?? item.variant
      item.skills = value.skills ?? item.skills
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      const own = PermissionNext.fromConfig(value.permission ?? {})
      item.permission = PermissionNext.merge(item.permission, own)
      // A rule that names a tool opts it in for this agent without a skill.
      item.unlocks = [...new Set([...(item.unlocks ?? []), ...ToolVisibility.unlocks(own)])]
      // `docs` is reserved for delegated documentation work. Older synced
      // configs created it with mode `all`, which incorrectly exposed it as a
      // primary session mode. Preserve the custom prompt/model while restoring
      // the product contract that Docs is subagent-only.
      if (key === "docs") item.mode = "subagent"
    }

    return result
  }

  const state = Instance.state(compute)

  /** Rebuild project-defined specialists and permissions after trust changes. */
  export function invalidate() {
    State.clear(Instance.directory, compute)
  }

  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  export async function list() {
    const cfg = await Config.getExecution()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "research"), "desc"]),
    )
  }

  export async function defaultAgent() {
    const cfg = await Config.getExecution()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      // Plan is no longer advertised, but an older trusted config may still
      // name it explicitly. Keep that deliberate compatibility path working;
      // arbitrary hidden agents remain invalid defaults.
      if (agent.hidden === true && agent.name !== "plan") {
        throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      }
      return agent.name
    }

    const primaryVisible = Object.values(agents).find(
      (agent) => agent.mode !== "subagent" && agent.hidden !== true && agent.name !== "plan",
    )
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.name
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    // This command is not part of a durable research conversation, but the
    // model call still belongs to one coherent trace. Use an explicit
    // short-lived lineage instead of attaching it to an unrelated session.
    const sessionID = `agent-config:${randomUUID()}`
    const messageID = `agent-config-request:${randomUUID()}`

    const selected = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(selected.providerID, selected.modelID)
    const credentialSource = await resolveCredentialSource(model.providerID, model.id)
    const funding = credentialSource === "managed" ? ((await OpenScience.getRequestSnapshot()) ?? undefined) : undefined
    if (requiresWalletBalance(credentialSource)) {
      if (!funding) throw new Error("Ace could not snapshot the connected funding account. Sign in again.")
      const balance = await OpenScience.getBalance(funding)
      if (balance === null)
        throw new Error("Ace could not verify the current balance. Retry when the connection returns.")
      if (balance <= 0) {
        throw new Error(
          `Your Wallet has no available balance (purchased balance less holds for turns in flight). Add funds at ${BILLING_URL} or switch model access to Keys & subscriptions.`,
        )
      }
    }

    const defaultModel = selected
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()
    const schema = z.object({
      identifier: z.string(),
      whenToUse: z.string(),
      systemPrompt: z.string(),
    })
    const messages: ModelMessage[] = [
      ...system.map((item): ModelMessage => ({
        role: "system",
        content: item,
      })),
      {
        role: "user",
        content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
      },
    ]
    const params = {
      // Provider-dependent SDK telemetry is disabled. Prompts and responses
      // stay between this device and the provider selected by the user.
      experimental_telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      },
      temperature: 0.3,
      messages,
      model: language,
      schema,
    } satisfies Parameters<typeof generateObject>[0]
    const oauthStream =
      defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth"
    const providerOptions = oauthStream
      ? ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.header(model),
          store: false,
        })
      : undefined

    const requestContext = { sessionID, messageID, attempt: 1, ...(funding ? { funding } : {}) }

    if (oauthStream) {
      const result = Provider.withRequestContext(requestContext, () =>
        streamObject({
          ...params,
          providerOptions,
          onError: () => {},
        }),
      )
      for await (const part of Provider.withRequestContextIterable(requestContext, result.fullStream)) {
        if (part.type === "error") throw part.error
      }
      const object = await result.object
      return object
    }

    const result = await Provider.withRequestContext(requestContext, () => generateObject(params))
    return result.object
  }
}
