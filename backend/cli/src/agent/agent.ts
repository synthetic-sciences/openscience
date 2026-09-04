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
import PROMPT_CRITIQUE from "./prompt/critique.txt"
import PROMPT_LITERATURE_REVIEW from "./prompt/literature-review.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_PHYSICS_CRITIQUE from "./prompt/physics-critique.txt"
import PROMPT_RESEARCH_AGENT_TEST from "./prompt/researchagent-test.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { State } from "@/project/state"
import { ProjectTrust } from "@/project/trust"
import { ProjectAccess } from "@/project/access"
import { randomUUID } from "node:crypto"
import { Flag } from "@/flag/flag"
import { OpenScience } from "@/openscience"
import { requiresWalletBalance, resolveCredentialSource } from "@/session/access-route"

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
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
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
              webfetch: "ask",
              websearch: "ask",
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

    const result: Record<string, Info> = {
      // --- Research modes (top) ---
      research: {
        name: "research",
        description: "Primary research agent for focused questions, analysis, synthesis, and durable outputs.",
        options: {},
        color: "#d48765",
        prompt: SystemPrompt.response(PROMPT_RESEARCH_AGENT_TEST),
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_enter: "allow",
            research_contract: "deny",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      ...(Flag.OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST
        ? {
            "researchagent-test": {
              name: "researchagent-test",
              description: "Feature-gated thin Research profile for source-level trajectory evaluation.",
              options: {},
              color: "#7c8cff",
              permission: PermissionNext.merge(
                defaults,
                PermissionNext.fromConfig({
                  question: "allow",
                  research_contract: "deny",
                }),
                user,
              ),
              mode: "primary" as const,
              native: true,
              prompt: SystemPrompt.response(PROMPT_RESEARCH_AGENT_TEST),
            },
          }
        : {}),
      // --- Domain agents ---
      biology: {
        name: "biology",
        description: "Biology specialist for bioinformatics, biological databases, and evidence-backed data analysis.",
        options: {},
        color: "#10b981",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
          }),
          user,
        ),
        mode: "subagent",
        native: true,
        hidden: true,
      },
      // --- Physics ---
      physics: {
        name: "physics",
        description:
          "Physics specialist for simulation, numerical methods, dimensional analysis, and validated scientific computing.",
        options: {},
        color: "#8b5cf6",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
          }),
          user,
        ),
        mode: "subagent",
        native: true,
        hidden: true,
      },
      // --- Machine learning ---
      ml: {
        name: "ml",
        description:
          "Machine-learning specialist for data, training, evaluation, inference, and reproducible experiments.",
        options: {},
        color: "#6366f1",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
          }),
          user,
        ),
        mode: "subagent",
        native: true,
        hidden: true,
      },
      // --- Utilities ---
      write: {
        name: "write",
        description:
          "Scientific & technical writing. Produces LaTeX papers, grants, literature reviews with verified citations and figures.",
        options: {},
        color: "#a78bfa",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
          }),
          user,
        ),
        mode: "subagent",
        native: true,
        hidden: true,
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
      // --- Internal delegation profiles ---
      // The product exposes capabilities and effort, not a catalog of domain
      // personas. Research loads domain knowledge lazily through skills and
      // delegates only by the kind of work that needs doing.
      execute: {
        name: "execute",
        description:
          "Implementation or computational work with the active project permissions. Returns concrete results to Research.",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
        hidden: true,
      },
      // --- Compatibility aliases (retrievable, never advertised) ---
      task: {
        name: "task",
        description:
          "General-purpose child agent for one independent unit of work that can merge cleanly into the primary result.",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
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
            bash: safeAction,
            // WebFetch owns a narrowly scoped brokered transfer. Without this
            // explicit rule the profile's wildcard deny blocks the broker's
            // per-host authorization before the webfetch allow can apply.
            network: externalAction,
            webfetch: externalAction,
            websearch: externalAction,
            codesearch: externalAction,
            read: "allow",
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
        hidden: true,
      },
      "literature-review": {
        name: "literature-review",
        description:
          "Full PRISMA literature review — systematic search, screening, eligibility, synthesis, verification.",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            bash: safeAction,
            network: externalAction,
            read: "allow",
            glob: "allow",
            grep: "allow",
            webfetch: externalAction,
            websearch: externalAction,
            codesearch: externalAction,
            skill: "allow",
          }),
          user,
        ),
        prompt: PROMPT_LITERATURE_REVIEW,
        options: {},
        color: "#818cf8",
        mode: "subagent",
        native: true,
        hidden: true,
      },
      critique: {
        name: "critique",
        description:
          "Scientific critique specialist. Finds blocking errors — data leakage, wrong statistics, unsupported claims — in research artifacts before expensive or irreversible actions. Read-only.",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
            skill: "allow",
          }),
          user,
        ),
        prompt: PROMPT_CRITIQUE,
        options: {},
        color: "#ef4444",
        mode: "subagent",
        native: true,
        hidden: true,
      },
      "physics-critique": {
        name: "physics-critique",
        description:
          "Physics critique specialist — validates computational physics results (PDE solutions, PINN outputs, fitted parameters) against rigorous physical and numerical criteria. Blind to generator reasoning (Aletheia pattern). Read-only.",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
            bash: safeAction,
          }),
          user,
        ),
        prompt: PROMPT_PHYSICS_CRITIQUE,
        options: {},
        color: "#c084fc",
        mode: "subagent",
        native: true,
        hidden: true,
      },
      // --- Hidden system agents ---
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
    }

    const removed = new Set(["review", "reviewer", "artifact-reviewer"])
    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (removed.has(key)) continue
      if (key === "researchagent-test" && !Flag.OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST) continue
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
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
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
        throw new Error("Your Ace balance is empty. Add credits or switch model access to BYOK / Subscription.")
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
      ...system.map(
        (item): ModelMessage => ({
          role: "system",
          content: item,
        }),
      ),
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
          instructions: SystemPrompt.instructions(),
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
