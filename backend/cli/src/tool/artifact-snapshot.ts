import z from "zod"
import { ArtifactStore } from "@/artifact/store"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Provenance } from "@/science/provenance/store"
import { Session } from "@/session"
import { Tool } from "./tool"

const DEFAULT_BYTES = 64 * 1024
const MAX_BYTES = 256 * 1024
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

function textual(mime: string, filename: string) {
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("yaml") ||
    /\.(md|markdown|txt|csv|tsv|json|jsonl|yaml|yml|toml|py|r|jl|tex|html|css|js|jsx|ts|tsx)$/i.test(filename)
  )
}

export const ArtifactSnapshotTool = Tool.define("artifact_snapshot", {
  description: [
    "Read one immutable artifact-store version through its provenance target.",
    "The target fixes the artifact id, version id, byte count, MIME type, and SHA-256.",
    "Text can be paged by byte offset. Images and PDFs up to 32 MiB are returned as exact-byte attachments.",
    "This tool never reads the live source path and never changes the artifact or workspace.",
    "A delegated read-only reviewer may inspect immutable versions owned by its direct parent session.",
  ].join("\n"),
  parameters: z.object({
    target: z.string().describe("Exact artifact-version provenance node id supplied in the review brief"),
    offset: z.number().int().nonnegative().optional().describe("Text byte offset (default 0)"),
    limit: z.number().int().positive().max(MAX_BYTES).optional().describe("Text bytes to return (max 262144)"),
  }),
  async execute(params, ctx) {
    const scope = { projectID: Instance.project.id, directory: Instance.directory }
    const node = await Provenance.find(scope, params.target)
    const artifactID = node?.meta?.artifactID
    const versionID = node?.meta?.versionID
    const expected = node?.meta?.sha256
    const owner = node?.meta?.sessionID
    const session =
      owner !== ctx.sessionID &&
      (ctx.agent === "reviewer" || ctx.agent === "artifact-reviewer" || ctx.agent === "review")
        ? await Session.get(ctx.sessionID).catch(() => undefined)
        : undefined
    const delegated = typeof owner === "string" && session?.parentID === owner
    if (
      node?.kind !== "artifact" ||
      node.meta?.artifactStore !== true ||
      typeof artifactID !== "string" ||
      typeof versionID !== "string" ||
      typeof expected !== "string" ||
      (owner !== ctx.sessionID && !delegated)
    ) {
      throw new Error(`Provenance node ${params.target} is not an immutable artifact-store version for this session`)
    }
    const snapshot = await ArtifactStore.read(Instance.project.id, artifactID, versionID)
    if (!snapshot) throw new Error(`Immutable artifact version ${versionID} is unavailable`)
    if (
      snapshot.info.sha256 !== expected ||
      ArtifactStore.reviewTargetID(snapshot.info.id, snapshot.info.sha256) !== params.target
    ) {
      throw new Error(`Immutable artifact version ${versionID} no longer matches its review target`)
    }
    const header = [
      `target: ${params.target}`,
      `artifact: ${artifactID}`,
      `version: ${snapshot.info.version} (${versionID})`,
      `sha256: ${snapshot.info.sha256}`,
      `mime: ${snapshot.info.mimeType}`,
      `size: ${snapshot.info.size} bytes`,
    ]
    const attachable =
      snapshot.info.size <= MAX_ATTACHMENT_BYTES &&
      (snapshot.info.mimeType.startsWith("image/") || snapshot.info.mimeType === "application/pdf")
    if (attachable) {
      const bytes = await snapshot.content.bytes()
      return {
        title: `Immutable snapshot · v${snapshot.info.version}`,
        output: [...header, "", "Exact immutable bytes attached for review."].join("\n"),
        metadata: {
          target: params.target,
          artifactID,
          versionID,
          sha256: snapshot.info.sha256,
          size: snapshot.info.size,
          offset: 0,
          end: snapshot.info.size,
          more: false,
          unsupported: false,
          truncated: false,
        },
        attachments: [
          {
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file" as const,
            mime: snapshot.info.mimeType,
            filename: snapshot.info.filename,
            url: `data:${snapshot.info.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
          },
        ],
      }
    }
    if (!textual(snapshot.info.mimeType, snapshot.info.filename)) {
      return {
        title: `Immutable snapshot · v${snapshot.info.version}`,
        output: [
          ...header,
          "",
          "The exact bytes are stored, but this reviewer cannot inspect this binary format.",
          "Do not record a supporting verdict from metadata alone.",
        ].join("\n"),
        metadata: {
          target: params.target,
          artifactID,
          versionID,
          sha256: snapshot.info.sha256,
          size: snapshot.info.size,
          offset: 0,
          end: 0,
          more: false,
          unsupported: true,
          truncated: false,
        },
      }
    }
    const offset = params.offset ?? 0
    const limit = params.limit ?? DEFAULT_BYTES
    const end = Math.min(snapshot.info.size, offset + limit)
    const body = offset >= snapshot.info.size ? "" : await snapshot.content.slice(offset, end).text()
    return {
      title: `Immutable snapshot · v${snapshot.info.version}`,
      output: [
        ...header,
        `bytes: ${offset}-${end} of ${snapshot.info.size}`,
        "",
        body,
        ...(end < snapshot.info.size
          ? ["", `More bytes remain. Call artifact_snapshot again with offset=${end}.`]
          : []),
      ].join("\n"),
      metadata: {
        target: params.target,
        artifactID,
        versionID,
        sha256: snapshot.info.sha256,
        size: snapshot.info.size,
        offset,
        end,
        more: end < snapshot.info.size,
        unsupported: false,
        truncated: false,
      },
    }
  },
})
