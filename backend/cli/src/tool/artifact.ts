import z from "zod"
import path from "node:path"
import { Tool } from "./tool"
import { ArtifactStore } from "@/artifact/store"
import { File } from "@/file"
import { ArtifactFile } from "@/file/artifacts"
import { Instance } from "@/project/instance"
import { Provenance } from "@/science/provenance/store"
import type { Node, Run } from "@/science/provenance/store"
import { RLMArtifacts } from "@/session/rlm/artifacts"

function result(title: string, output: string, metadata: Record<string, unknown> = {}) {
  return { title, output, metadata }
}

const runnable = (node: Node | undefined): node is Run =>
  node?.kind === "run" && "tool" in node && typeof node.tool === "string"

export const ArtifactTool = Tool.define("artifact", {
  description: [
    "Store and retrieve large data artifacts by reference.",
    "Use this to keep large outputs (DataFrames, analysis results, raw data) out of context.",
    "Actions:",
    "  - save_file: Promote a finished workspace file into the durable, immutable, versioned artifact store",
    "  - register: Store content on disk, returns a reference ID + summary",
    "  - update: Replace the current content while retaining an immutable version",
    "  - resolve: Retrieve full content by artifact ID",
    "  - list: Show all artifacts in this session",
    "  - list_versions: Show immutable versions of an artifact",
    "  - read_version: Retrieve one immutable version by version ID",
  ].join(" "),
  parameters: z.object({
    action: z
      .enum(["save_file", "register", "update", "resolve", "list", "list_versions", "read_version"])
      .describe("The action"),
    path: z.string().trim().min(1).max(10_000).optional().describe("For save_file: workspace file path"),
    type: z.string().optional().describe('For register/update: artifact type (e.g. "dataframe", "analysis")'),
    content: z.string().optional().describe("For register/update: the large content to store"),
    summary: z.string().optional().describe("For register/update: brief summary for context window"),
    artifact_id: z.string().optional().describe("For update/resolve/version actions: the artifact ID"),
    version_id: z.string().optional().describe("For read_version: the immutable version ID"),
    durable: z
      .boolean()
      .optional()
      .describe(
        "For register/update: keep the stored version durable so cleanup never expires it. Use when the user asks to save or keep a result.",
      ),
    provenance_id: z
      .string()
      .optional()
      .describe("For register/update: a producing run provenance ID from this project and session"),
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
    const run =
      entry?.provenance?.identity.run_id.status === "available" ? entry.provenance.identity.run_id.value : entry?.id
    const source = {
      projectID: Instance.project.id,
      agent: ctx.agent,
      messageID: ctx.messageID,
      ...(ctx.callID ? { callID: ctx.callID } : {}),
      ...(typeof run === "string" ? { runID: run } : ctx.callID ? { runID: ctx.callID } : {}),
      ...(params.provenance_id ? { provenanceID: params.provenance_id } : {}),
    }
    if (params.action === "save_file") {
      if (!params.path) return result("Error", "save_file requires `path`")
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
      })
      return result(
        `Saved artifact: ${saved.title}`,
        [
          "Workspace file saved as a durable, immutable artifact version.",
          `  ID: ${saved.id}`,
          `  Version: ${saved.current.version}`,
          `  Kind: ${saved.kind}`,
          `  Path: ${saved.current.sourcePath}`,
          `  Size: ${saved.current.size} bytes`,
          `  SHA-256: ${saved.current.sha256}`,
          "",
          "The artifact is available project-wide in Files and can be opened, reviewed, renamed, versioned, or downloaded.",
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
    if (params.action === "register") {
      if (!params.type || !params.content) {
        return result("Error", "register requires `type` and `content` parameters")
      }
      const ref = await RLMArtifacts.register(ctx.sessionID, params.type, params.content, params.summary, source, {
        durable: params.durable,
      })
      if (params.durable) {
        // Dynamic import: the review launcher reaches back into the session
        // prompt loop, which owns the tool registry this file lives in.
        const { SessionReview } = await import("@/session/review")
        void SessionReview.auto(ctx.sessionID, ctx.agent).catch(() => {})
      }
      return result(
        `Registered artifact: ${ref.id}`,
        [
          `Artifact stored successfully.`,
          `  ID: ${ref.id}`,
          `  Version: ${ref.versionID}`,
          `  Type: ${ref.type}`,
          `  Summary: ${ref.summary}`,
          `  Size: ${params.content.length} bytes`,
          "",
          "Use artifact_id in resolve to retrieve full content later.",
        ].join("\n"),
        { id: ref.id, versionID: ref.versionID, version: ref.version, type: ref.type },
      )
    }

    if (params.action === "update") {
      if (!params.artifact_id || !params.content) {
        return result("Error", "update requires `artifact_id` and `content` parameters")
      }
      const ref = await RLMArtifacts.update(ctx.sessionID, params.artifact_id, params.content, {
        type: params.type,
        summary: params.summary,
        source,
        durable: params.durable,
      })
      if (!ref) {
        return result("Not found", `Artifact "${params.artifact_id}" not found in this session.`)
      }
      if (params.durable) {
        const { SessionReview } = await import("@/session/review")
        void SessionReview.auto(ctx.sessionID, ctx.agent).catch(() => {})
      }
      return result(
        `Updated artifact: ${ref.id}`,
        [
          "Artifact updated successfully.",
          `  ID: ${ref.id}`,
          `  Version: ${ref.versionID}`,
          `  Type: ${ref.type}`,
          `  Summary: ${ref.summary}`,
          `  Size: ${params.content.length} bytes`,
          "",
          "Prior versions remain available through list_versions and read_version.",
        ].join("\n"),
        { id: ref.id, versionID: ref.versionID, version: ref.version, type: ref.type },
      )
    }

    if (params.action === "resolve") {
      if (!params.artifact_id) {
        return result("Error", "resolve requires `artifact_id` parameter")
      }
      const content = await RLMArtifacts.resolve(ctx.sessionID, params.artifact_id)
      if (!content) {
        return result("Not found", `Artifact "${params.artifact_id}" not found in this session.`)
      }
      return result(`Resolved artifact: ${params.artifact_id}`, content, { id: params.artifact_id })
    }

    if (params.action === "list_versions") {
      if (!params.artifact_id) {
        return result("Error", "list_versions requires `artifact_id` parameter")
      }
      const versions = await RLMArtifacts.listVersions(ctx.sessionID, params.artifact_id)
      if (!versions.length) {
        return result("No versions", `No versions found for artifact "${params.artifact_id}".`)
      }
      const lines = versions.map((version) => {
        const source = version.source?.agent ? ` by ${version.source.agent}` : ""
        const expiry = version.retention.expiresAt
          ? `, expires ${new Date(version.retention.expiresAt).toISOString()}`
          : ""
        return `- ${version.id}: v${version.version} at ${new Date(version.createdAt).toISOString()}${source} (${version.size} bytes, ${version.retention.status}${expiry})`
      })
      return result(`${versions.length} version(s)`, lines.join("\n"), {
        count: versions.length,
        versions: versions.map((version) => version.id),
        retention: versions.map((version) => ({
          versionID: version.id,
          ...version.retention,
        })),
      })
    }

    if (params.action === "read_version") {
      if (!params.artifact_id || !params.version_id) {
        return result("Error", "read_version requires `artifact_id` and `version_id` parameters")
      }
      const version = await RLMArtifacts.readVersion(ctx.sessionID, params.artifact_id, params.version_id)
      if (!version) {
        return result("Not found", `Version "${params.version_id}" was not found for artifact "${params.artifact_id}".`)
      }
      return result(`Resolved artifact version: ${params.version_id}`, version.content, {
        id: params.artifact_id,
        versionID: version.info.id,
        version: version.info.version,
        createdAt: version.info.createdAt,
        source: version.info.source,
        sha256: version.info.sha256,
        retention: version.info.retention,
        provenanceID: version.info.source?.provenanceID,
        provenance: version.info.provenance,
      })
    }

    const artifacts = await RLMArtifacts.list(ctx.sessionID)
    if (artifacts.length === 0) {
      return result("No artifacts", "No artifacts registered in this session.")
    }
    const lines = artifacts.map((artifact) => {
      const version = artifact.version ? `, v${artifact.version}` : ""
      return `- ${artifact.id}: ${artifact.summary} (${artifact.type}${version})`
    })
    return result(`${artifacts.length} artifact(s)`, lines.join("\n"), { count: artifacts.length })
  },
})
