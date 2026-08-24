import z from "zod"
import { AtlasBroker } from "@/science/atlas/broker"
import { OpenScience } from "@/openscience"
import { Tool } from "./tool"
import { assertExternalDirectory } from "./external-directory"

const Operation = z.enum([
  "brief",
  "node",
  "tree",
  "search",
  "usage",
  "library_list",
  "library_summary",
  "library_show",
  "library_tree",
  "library_read",
  "library_grep",
  "library_subscribe",
  "library_add",
  "library_add_local",
  "library_sync_local",
])
const mutations = new Set(["library_subscribe", "library_add", "library_add_local", "library_sync_local"])

export const AtlasTool = Tool.define("atlas", {
  description: [
    "Read and index Synthetic Sciences library sources through the OpenScience host broker.",
    "Use this instead of sending authenticated backend requests directly from a sandboxed process.",
    "The host keeps Synthetic Sciences credentials private and returns only the requested JSON.",
    "Local add/sync accepts only an existing session-authorized folder, filters secrets and symlinks, enforces upload caps, and always keeps the source private.",
    "For search, put public/remote ids in source_ids and private local-folder ids in local_source_ids.",
  ].join("\n"),
  parameters: z.object({
    operation: Operation,
    project: z.string().trim().min(1).optional().describe("Project node id or slug for brief."),
    node: z.string().trim().min(1).optional().describe("Node id or slug for node or tree."),
    query: z.string().trim().min(1).max(20_000).optional().describe("Query for search."),
    full: z.boolean().optional().describe("Load the expanded project brief."),
    mode: z.enum(["universal", "targeted", "web", "deep"]).optional().describe("Library search mode."),
    top_k: z.number().int().min(1).max(50).optional().describe("Maximum search result count."),
    source_ids: z.array(z.string().trim().min(1)).max(100).optional().describe("Indexed source ids."),
    local_source_ids: z
      .array(z.string().trim().min(1))
      .max(100)
      .optional()
      .describe("Private local-folder source ids for search."),
    source_id: z.string().trim().min(1).optional().describe("Source id for show, tree, read, grep, or sync."),
    source_type: z
      .enum(["repository", "documentation", "research_paper", "huggingface_dataset"])
      .optional()
      .describe("Remote source type for list, subscribe, or add."),
    source_status: z.string().trim().min(1).optional().describe("Optional source status filter for library_list."),
    url: z.string().trim().url().optional().describe("Remote source URL for subscribe or add."),
    repository: z.string().trim().min(1).optional().describe("Repository owner/name for library_add."),
    display_name: z.string().trim().min(1).max(200).optional().describe("Source display name."),
    folder: z.string().trim().min(1).optional().describe("Authorized host folder for private local add or sync."),
    source_path: z.string().trim().optional().describe("Path inside an indexed source for tree or read."),
    pattern: z.string().min(1).max(10_000).optional().describe("Pattern for library_grep."),
    path_prefix: z.string().trim().optional().describe("Optional source path prefix for library_grep."),
    depth: z.number().int().min(0).max(100).optional().describe("Library source tree depth."),
    limit: z.number().int().min(1).max(100).optional().describe("Library list page size."),
    offset: z.number().int().min(0).optional().describe("Library list page offset."),
    max_file_bytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1_048_576)
      .optional()
      .describe("Per-file local indexing cap."),
    max_files: z.number().int().min(1).max(5_000).optional().describe("Local indexing file cap."),
    max_total_bytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1_048_576)
      .optional()
      .describe("Aggregate local indexing cap."),
    projection: z.string().trim().min(1).optional().describe("Node or tree projection."),
    max_nodes: z.number().int().min(1).max(10_000).optional().describe("Maximum tree node count."),
    max_depth: z.number().int().min(0).max(100).optional().describe("Maximum tree depth."),
  }),
  async execute(params, ctx) {
    const mutation = mutations.has(params.operation)
    await ctx.ask({
      permission: "atlas",
      patterns: [params.operation],
      always: [`${params.operation}*`],
      metadata: { broker: "host", mutation },
    })
    using folder =
      params.operation === "library_add_local" || params.operation === "library_sync_local"
        ? await assertExternalDirectory(ctx, params.folder, { kind: "directory", access: "read" })
        : undefined
    const result = await AtlasBroker.run(
      {
        operation: params.operation,
        sessionID: ctx.sessionID,
        project: params.project,
        node: params.node,
        query: params.query,
        full: params.full,
        mode: params.mode,
        topK: params.top_k,
        sourceIDs: params.source_ids,
        localSourceIDs: params.local_source_ids,
        sourceID: params.source_id,
        sourceType: params.source_type,
        sourceStatus: params.source_status,
        url: params.url,
        repository: params.repository,
        displayName: params.display_name,
        folder: folder?.path ?? params.folder,
        authorization: folder?.authorization,
        authorizationOwnership: folder?.authorization ? "borrowed" : undefined,
        sourcePath: params.source_path,
        pattern: params.pattern,
        pathPrefix: params.path_prefix,
        depth: params.depth,
        limit: params.limit,
        offset: params.offset,
        maxFileBytes: params.max_file_bytes,
        maxFiles: params.max_files,
        maxTotalBytes: params.max_total_bytes,
        projection: params.projection,
        maxNodes: params.max_nodes,
        maxDepth: params.max_depth,
      },
      ctx.abort,
    )
    const output = OpenScience.redactSecrets(JSON.stringify(result, null, 2))
    ctx.metadata({
      title: `Synthetic Sciences ${params.operation}`,
      metadata: { operation: params.operation, broker: "host", credentials: "host_only", mutation },
    })
    return {
      title: `Synthetic Sciences ${params.operation}`,
      output,
      metadata: { operation: params.operation, broker: "host", credentials: "host_only", mutation },
    }
  },
})
