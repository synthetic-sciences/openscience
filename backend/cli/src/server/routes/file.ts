import path from "node:path"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { File } from "../../file"
import { Provenance, type Artifact, type Run } from "../../science/provenance/store"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"
import { ScienceFile } from "../../file/science"
import { ArtifactFile } from "../../file/artifacts"
import { PublicationFile } from "../../file/publication"
import { ArtifactAnnotation } from "../../file/annotations"
import { PublicationReview } from "../../file/review"
import { Identifier } from "../../id/id"
import { ArtifactStore } from "../../artifact/store"
import { FileTrash } from "../../file/trash"

const LineageRun = z.object({
  id: z.string(),
  tool: z.string(),
  label: z.string(),
  status: z.enum(["ok", "error"]).optional(),
  recordedAt: z.string(),
  sessionID: z.string().optional(),
  messageID: z.string().optional(),
  callID: z.string().optional(),
  code: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  kernel: z
    .object({
      language: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
})
const Lineage = z.object({
  runs: LineageRun.array(),
  messages: z.object({ sessionID: z.string(), messageID: z.string() }).array(),
})

const unwrap = <T>(value?: { status: "available"; value: T } | { status: "unavailable"; reason: string }) =>
  value?.status === "available" ? value.value : undefined

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await Ripgrep.search({
          cwd: Instance.directory,
          pattern,
          limit: 10,
        })
        return c.json(result)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await File.search({
          query,
          limit: limit ?? 10,
          dirs: dirs !== "false",
          type,
        })
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        /*
      const query = c.req.valid("query").query
      const result = await LSP.workspaceSymbol(query)
      return c.json(result)
      */
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          sessionID: Identifier.schema("session").optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const content = await File.list(query.path, { sessionID: query.sessionID })
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          sessionID: Identifier.schema("session").optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const content = await File.read(query.path, { sessionID: query.sessionID })
        return c.json(content)
      },
    )
    .put(
      "/file/content",
      describeRoute({
        summary: "Write file",
        description: "Write the content of a specified file.",
        operationId: "file.write",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          content: z.string(),
          sessionID: Identifier.schema("session"),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const content = await File.write(body.path, body.content, { sessionID: body.sessionID })
        return c.json(content)
      },
    )
    .get(
      "/file/trash",
      describeRoute({
        summary: "List recoverable source files",
        description:
          "List source and workspace files deleted by approved edit operations during the 30-day recovery window.",
        operationId: "file.trash.list",
        responses: {
          200: {
            description: "Recoverable files",
            content: { "application/json": { schema: resolver(FileTrash.Record.array()) } },
          },
        },
      }),
      async (c) => c.json(await FileTrash.list(Instance.project.id)),
    )
    .post(
      "/file/trash/:id/restore",
      describeRoute({
        summary: "Restore a deleted source file",
        description:
          "Restore a source or workspace file during its 30-day recovery window without overwriting an existing path.",
        operationId: "file.trash.restore",
        responses: {
          200: {
            description: "Restored file",
            content: { "application/json": { schema: resolver(FileTrash.Record) } },
          },
          404: { description: "Recoverable file not found" },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("ftr_") })),
      validator("json", z.object({ sessionID: Identifier.schema("session") })),
      async (c) => {
        const result = await FileTrash.restore({
          projectID: Instance.project.id,
          sessionID: c.req.valid("json").sessionID,
          id: c.req.valid("param").id,
        })
        if (!result) return c.json({ error: "Recoverable file not found" }, 404)
        return c.json(result)
      },
    )
    .get(
      "/file/inspect",
      describeRoute({
        summary: "Inspect a scientific binary file",
        description: "Inspect BAM, CRAM, H5AD, or LOOM metadata with locally available scientific tools.",
        operationId: "file.inspect",
        responses: {
          200: {
            description: "Scientific file inspection",
            content: {
              "application/json": {
                schema: resolver(ScienceFile.Inspection),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          sessionID: Identifier.schema("session").optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const result = await File.inspect(query.path, { sessionID: query.sessionID })
        return c.json(result)
      },
    )
    .get(
      "/file/raw",
      describeRoute({
        summary: "Download a file",
        description: "Stream a project file without loading it into the JSON API as base64.",
        operationId: "file.raw",
        responses: {
          200: {
            description: "Raw file contents",
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          sessionID: Identifier.schema("session").optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const content = await File.raw(query.path, { sessionID: query.sessionID })
        return new Response(content, {
          headers: {
            "Content-Type": content.type || "application/octet-stream",
            "Content-Length": String(content.size),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(query.path.split("/").pop() || "download")}`,
          },
        })
      },
    )
    .get(
      "/file/artifacts",
      describeRoute({
        summary: "List local research artifacts",
        description: "Discover notebooks, datasets, figures, reports, models, and scientific files in the project.",
        operationId: "file.artifacts",
        responses: {
          200: {
            description: "Research artifacts",
            content: {
              "application/json": {
                schema: resolver(ArtifactFile.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          sessionID: Identifier.schema("session").optional(),
        }),
      ),
      async (c) => c.json(await File.artifacts({ sessionID: c.req.valid("query").sessionID })),
    )
    .post(
      "/file/artifact",
      describeRoute({
        summary: "Save a file as a versioned artifact",
        description: "Stream a file's exact bytes into the local, immutable, content-addressed artifact store.",
        operationId: "file.artifact.save",
        responses: {
          200: {
            description: "Registered artifact version",
            content: { "application/json": { schema: resolver(ArtifactStore.Artifact) } },
          },
          403: { description: "Path is not readable within the project" },
          404: { description: "File not found" },
          413: { description: "File exceeds the 1 GiB artifact version limit" },
          507: { description: "Insufficient free space to preserve the safety reserve" },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string().trim().min(1).max(10_000),
          sessionID: Identifier.schema("session"),
          messageID: Identifier.schema("message").optional(),
          summary: z.string().trim().min(1).max(1_000).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        // Same containment as every other file route: File.raw resolves the
        // path through the session filesystem grants / project boundary.
        const file = await File.raw(body.path, { sessionID: body.sessionID }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        if ("error" in file) {
          if (file.error instanceof HTTPException) throw file.error
          return c.json({ error: file.error instanceof Error ? file.error.message : String(file.error) }, 403)
        }
        if (file.value.size > ArtifactStore.MAX_VERSION_BYTES) {
          return c.json(
            {
              error: `File is ${file.value.size} bytes; the artifact version limit is ${ArtifactStore.MAX_VERSION_BYTES} bytes`,
            },
            413,
          )
        }
        const name = path.basename(body.path)
        const classified = ArtifactFile.classify(name)
        const saved = await ArtifactStore.save({
          projectID: Instance.project.id,
          sessionID: body.sessionID,
          sourcePath: body.path,
          filename: name,
          kind: classified?.kind ?? "file",
          content: file.value,
          title: body.summary ?? name,
          mimeType: file.value.type,
          messageID: body.messageID,
          captureQuality: "declared",
        }).catch((error) => {
          if (error instanceof ArtifactStore.LimitError) {
            return c.json({ error: error.message }, 413)
          }
          if (error instanceof ArtifactStore.CapacityError) {
            return c.json({ error: error.message }, 507)
          }
          throw error
        })
        if (saved instanceof Response) return saved
        return c.json(saved)
      },
    )
    .get(
      "/file/artifact-store",
      describeRoute({
        summary: "List saved Results",
        description: "List active or recoverable trashed artifacts from this project's local artifact database.",
        operationId: "file.artifactStore.list",
        responses: {
          200: {
            description: "Saved Results",
            content: { "application/json": { schema: resolver(ArtifactStore.Artifact.array()) } },
          },
        },
      }),
      validator("query", z.object({ state: z.enum(["active", "trash"]).default("active") })),
      async (c) => c.json(await ArtifactStore.list(Instance.project.id, c.req.valid("query").state)),
    )
    .get(
      "/file/artifact-store/:id",
      describeRoute({
        summary: "Read one saved Result record",
        description: "Read immutable version metadata and the current execution record for a saved Result.",
        operationId: "file.artifactStore.get",
        responses: {
          200: {
            description: "Saved Result detail",
            content: { "application/json": { schema: resolver(ArtifactStore.Detail) } },
          },
          404: { description: "Artifact not found" },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("art_") })),
      async (c) => {
        const result = await ArtifactStore.get(Instance.project.id, c.req.valid("param").id)
        if (!result) return c.json({ error: "Artifact not found" }, 404)
        return c.json(result)
      },
    )
    .patch(
      "/file/artifact-store/:id",
      describeRoute({
        summary: "Rename a saved Result",
        description: "Rename the artifact record without changing any immutable version bytes.",
        operationId: "file.artifactStore.rename",
        responses: {
          200: {
            description: "Renamed artifact",
            content: { "application/json": { schema: resolver(ArtifactStore.Artifact) } },
          },
          404: { description: "Artifact not found" },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("art_") })),
      validator("json", z.object({ title: z.string().trim().min(1).max(240) })),
      async (c) => {
        const result = await ArtifactStore.rename(
          Instance.project.id,
          c.req.valid("param").id,
          c.req.valid("json").title,
        )
        if (!result) return c.json({ error: "Artifact not found" }, 404)
        return c.json(result)
      },
    )
    .delete(
      "/file/artifact-store/:id",
      describeRoute({
        summary: "Move a saved Result to trash",
        description: "Hide an artifact from active Files while retaining every version for 30 days.",
        operationId: "file.artifactStore.trash",
        responses: {
          200: {
            description: "Trashed artifact",
            content: { "application/json": { schema: resolver(ArtifactStore.Artifact) } },
          },
          404: { description: "Artifact not found" },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("art_") })),
      async (c) => {
        const result = await ArtifactStore.trash(Instance.project.id, c.req.valid("param").id)
        if (!result) return c.json({ error: "Artifact not found" }, 404)
        return c.json(result)
      },
    )
    .post(
      "/file/artifact-store/:id/restore",
      describeRoute({
        summary: "Restore a trashed artifact",
        description: "Restore an artifact and all immutable versions during its 30-day retention window.",
        operationId: "file.artifactStore.restore",
        responses: {
          200: {
            description: "Restored artifact",
            content: { "application/json": { schema: resolver(ArtifactStore.Artifact) } },
          },
          404: { description: "Artifact not found" },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("art_") })),
      async (c) => {
        const result = await ArtifactStore.restore(Instance.project.id, c.req.valid("param").id)
        if (!result) return c.json({ error: "Artifact not found" }, 404)
        return c.json(result)
      },
    )
    .get(
      "/file/artifact-store/:id/raw",
      describeRoute({
        summary: "Download an immutable artifact version",
        description: "Stream the current or selected immutable blob from the local artifact store.",
        operationId: "file.artifactStore.raw",
        responses: {
          200: { description: "Immutable artifact bytes" },
          404: { description: "Artifact version not found" },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("art_") })),
      validator(
        "query",
        z.object({
          versionID: z.string().startsWith("ver_").optional(),
          download: z.enum(["true", "false"]).optional(),
        }),
      ),
      async (c) => {
        const param = c.req.valid("param")
        const query = c.req.valid("query")
        const result = await ArtifactStore.read(Instance.project.id, param.id, query.versionID)
        if (!result) return c.json({ error: "Artifact version not found" }, 404)
        return new Response(result.content, {
          headers: {
            "Content-Type": result.info.mimeType,
            "Content-Length": String(result.info.size),
            "Content-Disposition": `${query.download === "true" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(result.info.filename)}`,
            ETag: `"sha256:${result.info.sha256}"`,
          },
        })
      },
    )
    .get(
      "/file/provenance",
      describeRoute({
        summary: "Get local file provenance",
        description: "Read Git branch, dirty state, and latest commit metadata for a project file.",
        operationId: "file.provenance",
        responses: {
          200: {
            description: "Local provenance",
            content: {
              "application/json": {
                schema: resolver(ArtifactFile.Provenance),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          sessionID: Identifier.schema("session").optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(await File.provenance(query.path, { sessionID: query.sessionID }))
      },
    )
    .get(
      "/file/lineage",
      describeRoute({
        summary: "Trace artifact lineage",
        description: "Find the provenance runs and producing messages recorded for a project file.",
        operationId: "file.lineage",
        responses: {
          200: {
            description: "Artifact lineage",
            content: {
              "application/json": {
                schema: resolver(Lineage),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          sessionID: Identifier.schema("session").optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const graph = await Provenance.project({ projectID: Instance.project.id, directory: Instance.directory })
        const absolute = path.resolve(Instance.directory, query.path)
        const relative = path.relative(Instance.directory, absolute)
        const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
        const matches = (value?: string) =>
          value !== undefined &&
          (value === absolute || (inside && (value === relative || value.endsWith(`/${relative}`))))
        const artifacts = graph.nodes.filter(
          (node): node is Artifact =>
            node.kind === "artifact" &&
            "path" in node &&
            matches(node.path) &&
            (!query.sessionID || node.meta?.sessionID === query.sessionID),
        )
        const produced = new Set(
          graph.edges
            .filter((edge) => edge.relation === "produced" && artifacts.some((artifact) => artifact.id === edge.to))
            .map((edge) => edge.from),
        )
        const runs = graph.nodes.filter(
          (node): node is Run =>
            node.kind === "run" &&
            "tool" in node &&
            (produced.has(node.id) ||
              (node.provenance?.outputs.items ?? []).some(
                (item) => matches(unwrap(item.artifact_id)) || matches(unwrap(item.path)) || matches(item.label),
              )) &&
            (!query.sessionID || node.sessionID === query.sessionID),
        )
        const sorted = runs.toSorted((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(0, 20)
        const messages = new Map<string, { sessionID: string; messageID: string }>()
        const remember = (sessionID?: unknown, messageID?: unknown) => {
          if (typeof sessionID !== "string" || typeof messageID !== "string") return
          messages.set(`${sessionID}\0${messageID}`, { sessionID, messageID })
        }
        for (const run of runs) remember(run.sessionID ?? run.meta?.sessionID, run.meta?.messageID)
        for (const artifact of artifacts) remember(artifact.meta?.sessionID, artifact.meta?.messageID)
        return c.json({
          runs: sorted.map((run) => {
            const envelope = run.provenance
            const kernel = unwrap(envelope?.environment.kernel)
            const name = typeof run.meta?.kernelName === "string" ? run.meta.kernelName : undefined
            const messageID = typeof run.meta?.messageID === "string" ? run.meta.messageID : undefined
            const callID = typeof run.meta?.callID === "string" ? run.meta.callID : undefined
            const command = typeof run.inputs?.command === "string" ? run.inputs.command : undefined
            const code = unwrap(envelope?.input.code)
            const cwd = unwrap(envelope?.input.cwd)
            const startedAt = unwrap(envelope?.timestamps.started_at)
            const completedAt = unwrap(envelope?.timestamps.completed_at)
            return {
              id: run.id,
              tool: run.tool,
              label: run.label,
              ...(run.status !== undefined ? { status: run.status } : {}),
              recordedAt: run.recordedAt,
              ...(run.sessionID !== undefined ? { sessionID: run.sessionID } : {}),
              ...(messageID !== undefined ? { messageID } : {}),
              ...(callID !== undefined ? { callID } : {}),
              ...(code !== undefined ? { code } : {}),
              ...(command !== undefined ? { command } : {}),
              ...(cwd !== undefined ? { cwd } : {}),
              ...(kernel !== undefined || name !== undefined
                ? {
                    kernel: {
                      ...(kernel !== undefined ? { language: kernel.language } : {}),
                      ...(name !== undefined ? { name } : {}),
                    },
                  }
                : {}),
              ...(startedAt !== undefined ? { startedAt } : {}),
              ...(completedAt !== undefined ? { completedAt } : {}),
            }
          }),
          messages: [...messages.values()],
        })
      },
    )
    .get(
      "/file/reproducibility",
      describeRoute({
        summary: "Audit project reproducibility",
        description:
          "Check Git state, locked dependencies, environment specifications, notebook structure, and research artifacts.",
        operationId: "file.reproducibility",
        responses: {
          200: {
            description: "Project reproducibility audit",
            content: { "application/json": { schema: resolver(ArtifactFile.Audit) } },
          },
        },
      }),
      async (c) => c.json(await File.reproducibility()),
    )
    .get(
      "/file/annotations",
      describeRoute({
        summary: "List artifact annotations",
        description: "List durable review threads anchored to a project artifact.",
        operationId: "file.annotations.list",
        responses: {
          200: {
            description: "Artifact annotations",
            content: { "application/json": { schema: resolver(ArtifactAnnotation.Info.array()) } },
          },
        },
      }),
      validator("query", z.object({ path: z.string() })),
      async (c) => c.json(await ArtifactAnnotation.list(c.req.valid("query").path)),
    )
    .post(
      "/file/annotations",
      describeRoute({
        summary: "Create an artifact annotation",
        description:
          "Create a durable review thread anchored to an artifact, text range, notebook cell, molecule, or locus.",
        operationId: "file.annotations.create",
        responses: {
          200: {
            description: "Created annotation",
            content: { "application/json": { schema: resolver(ArtifactAnnotation.Info) } },
          },
        },
      }),
      validator("json", ArtifactAnnotation.Create),
      async (c) => c.json(await ArtifactAnnotation.create(c.req.valid("json"))),
    )
    .get(
      "/file/annotations/:id/history",
      describeRoute({
        summary: "Read artifact annotation history",
        description: "Read every immutable revision of an artifact review thread, including a recoverable tombstone.",
        operationId: "file.annotations.history",
        responses: {
          200: {
            description: "Versioned artifact annotation",
            content: { "application/json": { schema: resolver(ArtifactAnnotation.Info) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("ann_") })),
      async (c) => c.json(await ArtifactAnnotation.history(c.req.valid("param").id)),
    )
    .patch(
      "/file/annotations/:id",
      describeRoute({
        summary: "Update an artifact annotation",
        description: "Reply to, resolve, or reopen an artifact review thread.",
        operationId: "file.annotations.update",
        responses: {
          200: {
            description: "Updated annotation",
            content: { "application/json": { schema: resolver(ArtifactAnnotation.Info) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("ann_") })),
      validator("json", ArtifactAnnotation.Update),
      async (c) => c.json(await ArtifactAnnotation.update(c.req.valid("param").id, c.req.valid("json"))),
    )
    .delete(
      "/file/annotations/:id",
      describeRoute({
        summary: "Tombstone an artifact annotation",
        description: "Hide an artifact review thread while retaining its recoverable revision history.",
        operationId: "file.annotations.delete",
        responses: {
          200: {
            description: "Tombstoned annotation",
            content: {
              "application/json": {
                schema: resolver(z.object({ deleted: z.literal(true), version: z.number().int().positive() })),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("ann_") })),
      async (c) => c.json(await ArtifactAnnotation.remove(c.req.valid("param").id)),
    )
    .get(
      "/file/manifest",
      describeRoute({
        summary: "Create an artifact integrity manifest",
        description: "Hash every discovered research artifact and return a portable, deterministic manifest.",
        operationId: "file.manifest",
        responses: {
          200: {
            description: "Artifact checksum manifest",
            content: { "application/json": { schema: resolver(ArtifactFile.Manifest) } },
          },
        },
      }),
      async (c) => {
        c.header("Content-Disposition", 'attachment; filename="openscience-artifact-manifest.json"')
        return c.json(await File.manifest())
      },
    )
    .get(
      "/file/publication/capabilities",
      describeRoute({
        summary: "Inspect local publication export support",
        description: "Detect Pandoc and a PDF engine before offering report export formats.",
        operationId: "file.publicationCapabilities",
        responses: {
          200: {
            description: "Available local publication formats",
            content: { "application/json": { schema: resolver(PublicationFile.Capabilities) } },
          },
        },
      }),
      async (c) => c.json(await File.publicationCapabilities()),
    )
    .post(
      "/file/publication",
      describeRoute({
        summary: "Export a Markdown research report",
        description: "Create a timestamped HTML, PDF, DOCX, LaTeX, or PowerPoint publication artifact locally.",
        operationId: "file.publication",
        responses: {
          200: {
            description: "Created publication artifact",
            content: { "application/json": { schema: resolver(PublicationFile.Result) } },
          },
        },
      }),
      validator("json", PublicationFile.Input),
      async (c) => c.json(await File.publication(c.req.valid("json"))),
    )
    .get(
      "/file/reviews",
      describeRoute({
        summary: "Read the current publication preflight",
        description:
          "Return the latest deterministic review report and whether it is stale for the current source bytes.",
        operationId: "file.reviews.current",
        responses: {
          200: {
            description: "Current publication preflight",
            content: { "application/json": { schema: resolver(PublicationReview.State) } },
          },
          404: { description: "No publication preflight exists for this manuscript" },
        },
      }),
      validator("query", z.object({ path: z.string().trim().min(1).max(10_000) })),
      async (c) => {
        const report = await File.reviewCurrent(c.req.valid("query").path)
        if (!report) return c.json({ error: "No publication preflight exists for this manuscript" }, 404)
        return c.json(report)
      },
    )
    .get(
      "/file/reviews/history",
      describeRoute({
        summary: "List publication preflight history",
        description: "List prior deterministic review reports for every reviewed version of a manuscript.",
        operationId: "file.reviews.history",
        responses: {
          200: {
            description: "Publication preflight history",
            content: { "application/json": { schema: resolver(PublicationReview.Report.array()) } },
          },
        },
      }),
      validator("query", z.object({ path: z.string().trim().min(1).max(10_000) })),
      async (c) => c.json(await File.reviewHistory(c.req.valid("query").path)),
    )
    .post(
      "/file/reviews",
      describeRoute({
        summary: "Run deterministic publication checks",
        description:
          "Check citations, numeric traces, figures, and provenance for the exact Markdown manuscript bytes.",
        operationId: "file.reviews.run",
        responses: {
          200: {
            description: "Generated publication preflight",
            content: { "application/json": { schema: resolver(PublicationReview.Report) } },
          },
        },
      }),
      validator("json", PublicationReview.RunInput),
      async (c) => c.json(await File.review(c.req.valid("json"))),
    )
    .patch(
      "/file/reviews/:id/findings/:finding",
      describeRoute({
        summary: "Resolve or override a publication finding",
        description: "Record an attributed reason and close one deterministic review finding.",
        operationId: "file.reviews.resolve",
        responses: {
          200: {
            description: "Updated publication preflight",
            content: { "application/json": { schema: resolver(PublicationReview.Report) } },
          },
          409: { description: "Finding cannot be updated" },
        },
      }),
      validator(
        "param",
        z.object({
          id: z.string().startsWith("review_"),
          finding: z.string().startsWith("finding_"),
        }),
      ),
      validator("json", PublicationReview.ResolveInput),
      async (c) => {
        const params = c.req.valid("param")
        const result = await File.reviewResolve(params.id, params.finding, c.req.valid("json")).then(
          (value) => ({ value }),
          (error) => ({ error: error instanceof Error ? error.message : String(error) }),
        )
        if ("error" in result) return c.json({ error: result.error }, 409)
        return c.json(result.value)
      },
    )
    .post(
      "/file/reviews/:id/finalize",
      describeRoute({
        summary: "Finalize a publication preflight",
        description:
          "Bind publication-ready state to the exact reviewed source hash after all blocking findings close.",
        operationId: "file.reviews.finalize",
        responses: {
          200: {
            description: "Finalized publication preflight",
            content: { "application/json": { schema: resolver(PublicationReview.Report) } },
          },
          409: { description: "Review is blocked, stale, or already invalid" },
        },
      }),
      validator("param", z.object({ id: z.string().startsWith("review_") })),
      validator("json", PublicationReview.FinalizeInput),
      async (c) => {
        const result = await File.reviewFinalize(c.req.valid("param").id, c.req.valid("json")).then(
          (value) => ({ value }),
          (error) => ({ error: error instanceof Error ? error.message : String(error) }),
        )
        if ("error" in result) return c.json({ error: result.error }, 409)
        return c.json(result.value)
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await File.status()
        return c.json(content)
      },
    ),
)
