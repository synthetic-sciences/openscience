import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@synsci/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { ResearchSearchTool } from "./research-search"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"
import { PlanExitTool, PlanEnterTool } from "./plan"
import { ApplyPatchTool } from "./apply_patch"
import { BiologyTools } from "./biology"
import { ArtifactTool } from "./artifact"
import { ScienceTools } from "./science"
import { LiteratureTool } from "./literature"
import { NotebookTool, PythonTool } from "./notebook"
import { RKernelTool, RTool } from "./rkernel"
import { ModalTool } from "./modal"
import { ComputeJobTool } from "./compute-job"
import { ExperimentsTool } from "./experiments"
import { StudyTool } from "./study"
import { State } from "@/project/state"
import { ProjectTrust } from "@/project/trust"
import { AuthoritySignal } from "@/project/authority-signal"
import { GenerateImageTool } from "./generate-image"
import { ProviderComputeTool } from "./provider-compute"
import { Identifier } from "../id/id"
import { RecallTool } from "./recall"
import { ToolVisibility } from "./visibility"
import { researchSearchConfigured } from "./research-search"

const pluginResult = z
  .object({
    output: z.string(),
    title: z.string().optional(),
    metadata: z.record(z.string(), z.json()).optional(),
    attachments: z
      .array(
        z
          .object({
            type: z.literal("file"),
            mime: z.string().min(1),
            url: z.url().refine((value) => ["data:", "https:", "http:", "file:"].includes(new URL(value).protocol), {
              message: "Attachment URLs must use data, https, http, or file",
            }),
            filename: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })
  const compatibility = new Map<string, Tool.Info>([
    [NotebookTool.id, NotebookTool],
    [RKernelTool.id, RKernelTool],
    [ModalTool.id, ModalTool],
    ["websearch", ResearchSearchTool],
  ])

  const compute = async () => {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("{tool,tools}/*.{js,ts}")

    // Importing a tool module executes its top-level code in the host process.
    // Config.executableDirectories excludes project-owned directories until
    // their canonical project root has been explicitly trusted.
    for (const dir of await Config.executableDirectories()) {
      for await (const match of glob.scan({
        cwd: dir,
        absolute: true,
        followSymlinks: true,
        dot: true,
      })) {
        const namespace = path.basename(match, path.extname(match))
        // A symlinked file is still project-owned when its directory entry is
        // project-owned. Serialize the final trust check and module import with
        // revocation so top-level module code cannot finish after a revoke has
        // already been acknowledged.
        const projectOwned = Instance.containsPath(dir)
        const mod = projectOwned
          ? await AuthoritySignal.exclusive(async () => {
              await ProjectTrust.require(Instance.project, "project_plugin")
              return import(match)
            })
          : await import(match)
        for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
          custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def, projectOwned))
        }
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      const projectOwned = Plugin.projectOwned(plugin)
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def, projectOwned))
      }
    }

    return { custom }
  }

  export const state = Instance.state(compute)

  /** Evict imported project tools and plugin tools after a trust transition. */
  export function invalidate() {
    State.clear(Instance.directory, compute)
  }

  function fromPlugin(id: string, def: ToolDefinition, projectOwned = false): Tool.Info {
    return Tool.define(id, async (initCtx) => ({
      parameters: z.object(def.args),
      description: def.description,
      execute: async (args, ctx) => {
        // Cache eviction removes the tool from future registries. This check is
        // the fail-closed guard for a caller that retained an initialized tool
        // object across revocation.
        if (projectOwned) await ProjectTrust.require(Instance.project, "project_plugin")
        const pluginCtx = {
          ...ctx,
          directory: Instance.directory,
          worktree: Instance.worktree,
        } as unknown as PluginToolContext
        const raw = await def.execute(z.record(z.string(), z.unknown()).parse(args), pluginCtx)
        const parsed = pluginResult.safeParse(typeof raw === "string" ? { output: raw } : raw)
        if (!parsed.success) {
          throw new Error(`Plugin tool "${id}" returned an invalid result: ${parsed.error.message}`)
        }
        const result = parsed.data
        const out = await Truncate.output(result.output, { sessionID: ctx.sessionID }, initCtx?.agent)
        return {
          title: result.title ?? "",
          output: out.content,
          metadata: {
            ...result.metadata,
            truncated: out.truncated,
            outputPath: out.truncated ? out.outputPath : undefined,
          },
          attachments: result.attachments?.map((attachment) => ({
            ...attachment,
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
          })),
        }
      },
    }))
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const secured = Tool.define(tool.id, tool.init)
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, secured)
      return
    }
    custom.push(secured)
  }

  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)

    return [
      InvalidTool,
      ...(["app", "cli", "desktop"].includes(Flag.OPENSCIENCE_CLIENT) ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      WebFetchTool,
      TodoWriteTool,
      ResearchSearchTool,
      CodeSearchTool,
      SkillTool,
      ApplyPatchTool,
      RecallTool,
      ...(Flag.OPENSCIENCE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(Flag.OPENSCIENCE_EXPERIMENTAL_PLAN_MODE && Flag.OPENSCIENCE_CLIENT === "cli"
        ? [PlanExitTool, PlanEnterTool]
        : []),
      ...BiologyTools,
      ...ScienceTools,
      LiteratureTool,
      PythonTool,
      RTool,
      GenerateImageTool,
      ArtifactTool,
      ComputeJobTool,
      ProviderComputeTool,
      ExperimentsTool,
      StudyTool,
      ...custom.filter((tool) => !compatibility.has(tool.id) && tool.id !== PythonTool.id && tool.id !== RTool.id),
    ]
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  /** Installed extensions participate in Research without a built-in name list. */
  export async function customIDs(): Promise<ReadonlySet<string>> {
    return new Set((await state()).custom.map((tool) => tool.id))
  }

  /**
   * Resolve an executable tool by name without adding compatibility aliases to
   * the model-facing registry. This keeps old persisted calls and explicit
   * dispatchers working while `ids()` and `tools()` advertise only canonical
   * names.
   */
  export async function resolve(
    id: string,
    model?: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
  ) {
    const alias = compatibility.get(id)
    if (alias) {
      using _ = log.time(alias.id)
      return {
        id: alias.id,
        ...(await alias.init({ agent, model })),
      }
    }
    if (!model) return
    return (await tools(model, agent)).find((tool) => tool.id === id)
  }

  /** GPT-family models edit through `apply_patch`; everyone else through
   * `edit` and `write`. OpenCode's rule, by wire model id. */
  export function usesPatch(modelID: string) {
    return modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
  }

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
    enabled: (id: string) => boolean = () => true,
    request?: string,
    /** Tools a loaded skill or an explicit prompt setting unlocked for this
     * request. A biology database skill loaded by the lead Research agent
     * makes its query tools callable without switching agents. */
    unlocked: ReadonlySet<string> = new Set(),
  ) {
    const [tools, extensions, searchable] = await Promise.all([all(), customIDs(), researchSearchConfigured()])
    const usePatch = usesPatch(model.modelID)
    const result = await Promise.all(
      tools
        .filter((t) => {
          // Dynamic tools may load agent or skill catalogs to build their
          // descriptions. Disabled tools should contribute neither that startup
          // work nor a model-facing contract.
          if (!enabled(t.id)) return false
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch
          // Without a search provider the tool can only report that it is
          // unavailable; a description the model cannot follow is noise.
          if (t.id === "research_search") return searchable
          // Community code search retains its existing provider/flag rule.
          if (t.id === "codesearch") return Flag.OPENSCIENCE_ENABLE_EXA
          if (!agent) return true
          return ToolVisibility.offered(t.id, { agent, unlocked, extensions })
        })
        .map(async (t) => {
          const started = Date.now()
          const init = await t.init({ agent, model, request })
          log.debug("init", { tool: t.id, duration: Date.now() - started })
          return { id: t.id, ...init }
        }),
    )
    return result
  }
}
