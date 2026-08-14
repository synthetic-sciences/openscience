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
import PROMPT_REVIEWER from "./prompt/reviewer.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { State } from "@/project/state"

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
    const cfg = await Config.getExecution()

    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      mcp: "ask",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
      },
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      compute_job: "ask",
      // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    const result: Record<string, Info> = {
      // --- Research modes (top) ---
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
        steps: 16,
        description:
          "Bounded implementation or computational work with the active project permissions. Returns concrete results to Research.",
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
      review: {
        name: "review",
        steps: 12,
        description:
          "Proportionate, read-only review of observable files, results, citations, and provenance when the risk justifies it.",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
            provenance_query: "allow",
            provenance_review: "allow",
          }),
          user,
        ),
        prompt: PROMPT_REVIEWER,
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
        steps: 12,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
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
            bash: "allow",
            read: "allow",
            glob: "allow",
            grep: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
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
        steps: 60,
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
        steps: 60,
        description:
          "Physics critique specialist — validates computational physics results (PDE solutions, PINN outputs, fitted parameters) against rigorous physical and numerical criteria. Blind to generator reasoning (Aletheia pattern). Read-only.",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
            bash: "allow",
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
      reviewer: {
        name: "reviewer",
        steps: 60,
        description:
          "Blind, adversarial reviewer of research outputs. Traces every claim, number, and figure back to the provenance DAG and evidence — flags citation mismatches, untraceable numbers, and figure/stat mismatches. Read-only.",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
            provenance_query: "allow",
            provenance_review: "allow",
          }),
          user,
        ),
        prompt: PROMPT_REVIEWER,
        options: {},
        color: "#f59e0b",
        mode: "subagent",
        native: true,
        hidden: true,
      },
      "artifact-reviewer": {
        name: "artifact-reviewer",
        steps: 60,
        description:
          "Read-only reviewer for one immutable artifact-store version. It can inspect only the bound snapshot and its provenance, then append review findings.",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            artifact_snapshot: "allow",
            provenance_query: "allow",
            provenance_review: "allow",
          }),
        ),
        prompt: PROMPT_REVIEWER,
        options: {},
        color: "#f59e0b",
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

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
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
    const cfg = await Config.getExecution()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
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
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    const result = await generateObject(params)
    return result.object
  }
}
