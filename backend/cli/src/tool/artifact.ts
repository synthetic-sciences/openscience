import z from "zod"
import path from "node:path"
import { Tool } from "./tool"
import { ArtifactStore } from "@/artifact/store"
import { File } from "@/file"
import { ArtifactFile } from "@/file/artifacts"
import { Instance } from "@/project/instance"
import { Provenance } from "@/science/provenance/store"
import type { Node, Run } from "@/science/provenance/store"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool.artifact" })

function result(title: string, output: string, metadata: Record<string, unknown> = {}) {
  return { title, output, metadata }
}

const runnable = (node: Node | undefined): node is Run =>
  node?.kind === "run" && "tool" in node && typeof node.tool === "string"

function savedExecution(run: Run): Omit<ArtifactStore.Execution, "id" | "artifactVersionID" | "createdAt"> {
  const envelope = run.provenance
  const status = (() => {
    switch (envelope?.outputs.status) {
      case "succeeded":
        return "succeeded" as const
      case "failed":
        return "failed" as const
      case "cancelled":
      case "interrupted":
        return "cancelled" as const
      default:
        return "unknown" as const
    }
  })()
  const files = (envelope?.outputs.items ?? []).flatMap((item) =>
    item.path.status === "available" ? [{ path: item.path.value, sha256: item.sha256, size: item.size }] : [],
  )
  return {
    command: run.tool,
    ...(envelope?.input.code.status === "available" ? { code: envelope.input.code.value } : {}),
    status,
    ...(typeof run.meta?.stdout === "string" ? { stdout: run.meta.stdout } : {}),
    ...(typeof run.meta?.stderr === "string" ? { stderr: run.meta.stderr } : {}),
    ...(typeof run.meta?.effort === "string" ? { effort: run.meta.effort } : {}),
    source: run.id,
    ...(run.inputs ? { inputs: run.inputs } : {}),
    captureQuality: "exact",
    files,
    ...(envelope
      ? {
          environment: {
            host: envelope.environment.host,
            kernel: envelope.environment.kernel,
            runID: envelope.identity.run_id,
          },
        }
      : {}),
  }
}

async function traceSavedArtifact(saved: ArtifactStore.Artifact, run: Run) {
  const scope = { projectID: Instance.project.id, directory: Instance.directory }
  const version = saved.current
  const id = ArtifactStore.reviewTargetID(version.id, version.sha256)
  const existing = await Provenance.find(scope, id)
  if (
    existing &&
    (existing.kind !== "artifact" ||
      !("contentHash" in existing) ||
      existing.contentHash !== version.sha256 ||
      existing.meta?.artifactID !== saved.id ||
      existing.meta?.versionID !== version.id)
  ) {
    throw new Error(`Provenance target ${id} conflicts with the immutable artifact version`)
  }
  if (!existing) {
    await Provenance.recordOwned(scope, {
      id,
      kind: "artifact",
      label: `${saved.title} · version ${version.version}`,
      artifactType: saved.kind,
      path: version.sourcePath,
      contentHash: version.sha256,
      size: version.size,
      meta: {
        artifactStore: true,
        artifactID: saved.id,
        versionID: version.id,
        version: version.version,
        filename: version.filename,
        mimeType: version.mimeType,
        sha256: version.sha256,
        sessionID: version.sessionID,
        sourcePath: version.sourcePath,
        captureQuality: version.captureQuality,
      },
    } as Parameters<typeof Provenance.record>[0])
  }
  await Provenance.linkOwned(scope, { from: run.id, to: id, relation: "produced" })
}

export const ArtifactTool = Tool.define("artifact", {
  description:
    "Save an important workspace file as a durable Result with a stable identity, immutable versions, and optional execution provenance. Keep drafts and large mutable working data in the workspace instead.",
  parameters: z.object({
    action: z.literal("save_file").describe("Save a workspace file as a durable Result"),
    path: z.string().trim().min(1).max(10_000).describe("Workspace file path"),
    summary: z.string().optional().describe("Concise user-facing Result title"),
    provenance_id: z
      .string()
      .optional()
      .describe("Producing Python/R or job provenance ID from this project and session"),
  }),
  async execute(params, ctx) {
    const node = params.provenance_id
      ? await Provenance.find(
          {
            projectID: Instance.project.id,
            directory: Instance.directory,
          },
          params.provenance_id,
        )
      : undefined
    const entry = runnable(node) ? node : undefined
    const owner =
      entry?.provenance?.identity.project_id.status === "available"
        ? entry.provenance.identity.project_id.value
        : typeof entry?.meta?.projectID === "string"
          ? entry.meta.projectID
          : undefined
    if (params.provenance_id && (!entry || entry.sessionID !== ctx.sessionID || owner !== Instance.project.id)) {
      return result("Invalid provenance", "The producing run was not found in this project and session.")
    }
    {
      const file = await File.raw(params.path, { sessionID: ctx.sessionID })
      const name = path.basename(params.path)
      const classified = ArtifactFile.classify(name)
      const title = params.summary?.trim() || name
      const preview = await (async () => {
        if (file.type.startsWith("image/") && file.size <= 1_500_000) {
          const bytes = Buffer.from(await file.arrayBuffer()).toString("base64")
          return { kind: "image" as const, data: `data:${file.type};base64,${bytes}` }
        }
        const text =
          file.type.startsWith("text/") ||
          ["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(file.type)
        if (text && file.size <= 250_000) {
          return { kind: "text" as const, data: (await file.text()).slice(0, 12_000) }
        }
      })()
      const saved = await ArtifactStore.save({
        projectID: Instance.project.id,
        sessionID: ctx.sessionID,
        sourcePath: params.path,
        filename: name,
        kind: classified?.kind ?? "file",
        content: file,
        title,
        mimeType: file.type,
        messageID: ctx.messageID,
        captureQuality: "declared",
        ...(entry ? { execution: savedExecution(entry) } : {}),
      })
      if (entry) await traceSavedArtifact(saved, entry)
      // Dynamic import avoids a registry cycle: review launches route back
      // through the session prompt loop that owns this tool definition.
      const { SessionReview } = await import("@/session/review")
      void SessionReview.auto(ctx.sessionID, ctx.agent).catch((error) =>
        log.warn("automatic review launch failed after Result save", {
          sessionID: ctx.sessionID,
          artifactID: saved.id,
          error,
        }),
      )
      return result(
        `Saved Result: ${saved.title}`,
        [
          "Workspace file saved as a durable Result with an immutable version.",
          `  ID: ${saved.id}`,
          `  Version: ${saved.current.version}`,
          `  Kind: ${saved.kind}`,
          `  Path: ${saved.current.sourcePath}`,
          `  Size: ${saved.current.size} bytes`,
          `  SHA-256: ${saved.current.sha256}`,
          "",
          "The Result is available project-wide in Files and can be opened, reviewed, renamed, versioned, or downloaded.",
        ].join("\n"),
        {
          savedArtifact: {
            id: saved.id,
            versionID: saved.currentVersionID,
            version: saved.current.version,
            title: saved.title,
            kind: saved.kind,
            path: saved.current.sourcePath,
            mimeType: saved.current.mimeType,
            size: saved.current.size,
            sha256: saved.current.sha256,
            ...(preview ? { preview } : {}),
          },
        },
      )
    }
  },
})
