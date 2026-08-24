import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { PlanWriteTool } from "./planwrite"
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
import { BiologyTools, BIOLOGY_TOOL_IDS } from "./biology"
import { ArtifactTool } from "./artifact"
import { ScienceTools } from "./science"
import { ProvenanceTools } from "./provenance"
import { NotebookTool, PythonTool } from "./notebook"
import { RKernelTool, RTool } from "./rkernel"
import { AtlasTool } from "./atlas"
import { AtlasRecordTool } from "./atlas-record"
import { ModalTool } from "./modal"
import { ComputeJobTool } from "./compute-job"
import { ResearchContractTool } from "./research-contract"
import { State } from "@/project/state"
import { ProjectTrust } from "@/project/trust"
import { AuthoritySignal } from "@/project/authority-signal"
import { GenerateImageTool } from "./generate-image"

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
        const result = await def.execute(args as any, pluginCtx)
        const out = await Truncate.output(result, { sessionID: ctx.sessionID }, initCtx?.agent)
        return {
          title: "",
          output: out.truncated ? out.content : result,
          metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
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
    const config = await Config.get()

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
      ...(config.experimental?.plan_mode === true ? [PlanWriteTool] : [TodoWriteTool]),
      TodoReadTool,
      ResearchSearchTool,
      CodeSearchTool,
      SkillTool,
      ApplyPatchTool,
      ...(Flag.OPENSCIENCE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...(Flag.OPENSCIENCE_EXPERIMENTAL_PLAN_MODE && Flag.OPENSCIENCE_CLIENT === "cli"
        ? [PlanExitTool, PlanEnterTool]
        : []),
      ...BiologyTools,
      ...ScienceTools,
      ...ProvenanceTools,
      AtlasTool,
      AtlasRecordTool,
      PythonTool,
      RTool,
      GenerateImageTool,
      ArtifactTool,
      ResearchContractTool,
      ComputeJobTool,
      ...custom.filter((tool) => !compatibility.has(tool.id) && tool.id !== PythonTool.id && tool.id !== RTool.id),
    ]
  }

  const ARTIFACT_TOOL_ID = "artifact"
  const ARTIFACT_AGENTS = ["research", "biology", "ml"]

  const COMPUTE_AGENTS = ["research", "biology", "physics", "ml"]

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
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

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
    enabled: (id: string) => boolean = () => true,
  ) {
    const tools = await all()
    const result = await Promise.all(
      tools
        .filter((t) => {
          // Dynamic tools may load agent or skill catalogs to build their
          // descriptions. Disabled tools should contribute neither that startup
          // work nor a model-facing contract.
          if (!enabled(t.id)) return false

          // Biology-only tools: only available for the biology agent.
          if (BIOLOGY_TOOL_IDS.has(t.id)) {
            return agent?.name === "biology"
          }

          // Artifact tool: only for artifact-oriented scientific agents.
          if (t.id === ARTIFACT_TOOL_ID) {
            return !!agent?.name && ARTIFACT_AGENTS.includes(agent.name)
          }

          if (t.id === "compute_job") {
            return !!agent?.name && COMPUTE_AGENTS.includes(agent.name)
          }

          if (t.id === "research_contract") {
            return !!agent?.name && COMPUTE_AGENTS.includes(agent.name)
          }

          // Community code search retains its existing provider/flag rule.
          // `research_search` is always advertised; its execution path selects
          // managed Synthetic Sciences search or the preserved community rule.
          if (t.id === "codesearch") {
            return Flag.OPENSCIENCE_ENABLE_EXA
          }

          // use apply tool in same format as codex
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch

          return true
        })
        .map(async (t) => {
          using _ = log.time(t.id)
          return {
            id: t.id,
            ...(await t.init({ agent, model })),
          }
        }),
    )
    return result
  }
}
