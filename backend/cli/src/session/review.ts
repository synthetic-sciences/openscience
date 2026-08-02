import { File } from "@/file"
import { ArtifactStore } from "@/artifact/store"
import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { Provenance } from "@/science/provenance/store"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Todo } from "@/session/todo"
import { ReviewSettings } from "@/settings/review"
import { Log } from "@/util/log"
import z from "zod"

// Direct reviewer launches. The reviewer runs as a first-class turn in the
// session — no "ask the research agent to spawn it" indirection. Session-level
// permission rules restore the provenance tools its checklists depend on
// (its own ruleset denies by default), leaving every other posture untouched.
export namespace SessionReview {
  const log = Log.create({ service: "session.review" })

  export const Target = z.object({
    artifactID: z.string().startsWith("art_"),
    versionID: z.string().startsWith("ver_"),
  })
  export type Target = z.infer<typeof Target>

  export const Bound = z.object({
    id: z.string(),
    artifactID: z.string(),
    versionID: z.string(),
    version: z.number().int().positive(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string(),
  })
  export type Bound = z.infer<typeof Bound>

  const REQUIRED: PermissionNext.Ruleset = [
    { permission: "provenance_query", pattern: "*", action: "allow" },
    { permission: "provenance_review", pattern: "*", action: "allow" },
  ]

  async function grant(sessionID: string) {
    const session = await Session.get(sessionID)
    const granted = session.permission ?? []
    const missing = REQUIRED.filter(
      (rule) =>
        !granted.some(
          (x) => x.permission === rule.permission && x.pattern === rule.pattern && x.action === rule.action,
        ),
    )
    if (!missing.length) return
    await Session.update(sessionID, (draft) => {
      draft.permission = [...(draft.permission ?? []), ...missing]
    })
  }

  async function context(sessionID: string) {
    const todos = await Todo.get(sessionID).catch(() => [])
    const artifacts = await File.artifacts({ sessionID }).catch(() => [])
    const lines = ["Run an independent review of the work in this conversation.", ""]
    if (todos.length) {
      lines.push("Plan state:")
      for (const todo of todos) lines.push(`- [${todo.status}] ${todo.content}`)
      lines.push("")
    }
    if (artifacts.length) {
      lines.push("Artifacts on disk:")
      for (const artifact of artifacts.slice(0, 40)) {
        lines.push(`- ${artifact.path} (${artifact.kind}, ${artifact.size} bytes)`)
      }
      lines.push("")
    }
    lines.push(
      "Trace lineage with provenance_query and record each finding with provenance_review linked to the exact node.",
      "Never claim to have rerun an analysis you did not run; state where you looked instead.",
    )
    return lines.join("\n")
  }

  async function bind(sessionID: string, target: Target): Promise<Bound> {
    const scope = { projectID: Instance.project.id, directory: Instance.directory }
    const [detail, snapshot] = await Promise.all([
      ArtifactStore.get(Instance.project.id, target.artifactID),
      ArtifactStore.read(Instance.project.id, target.artifactID, target.versionID),
    ])
    if (!detail || !snapshot) throw new Error("The immutable artifact version was not found in this project")
    if (snapshot.info.sessionID !== sessionID) {
      throw new Error("The review must run in the session that saved this artifact version")
    }
    const id = ArtifactStore.reviewTargetID(snapshot.info.id, snapshot.info.sha256)
    const existing = await Provenance.find(scope, id)
    if (
      existing &&
      (existing.kind !== "artifact" ||
        !("contentHash" in existing) ||
        existing.contentHash !== snapshot.info.sha256 ||
        existing.meta?.artifactID !== target.artifactID ||
        existing.meta?.versionID !== target.versionID)
    ) {
      throw new Error(`Provenance target ${id} conflicts with the immutable artifact version`)
    }
    if (!existing) {
      await Provenance.recordOwned(scope, {
        id,
        kind: "artifact",
        label: `${detail.title} · version ${snapshot.info.version}`,
        artifactType: detail.kind,
        contentHash: snapshot.info.sha256,
        size: snapshot.info.size,
        meta: {
          artifactStore: true,
          artifactID: target.artifactID,
          versionID: target.versionID,
          version: snapshot.info.version,
          filename: snapshot.info.filename,
          mimeType: snapshot.info.mimeType,
          sha256: snapshot.info.sha256,
          sessionID: snapshot.info.sessionID,
          sourcePath: snapshot.info.sourcePath,
          captureQuality: snapshot.info.captureQuality,
        },
      } as Parameters<typeof Provenance.record>[0])
    }
    return {
      id,
      artifactID: target.artifactID,
      versionID: target.versionID,
      version: snapshot.info.version,
      filename: snapshot.info.filename,
      mimeType: snapshot.info.mimeType,
      size: snapshot.info.size,
      sha256: snapshot.info.sha256,
    }
  }

  function artifactContext(target: Bound) {
    return [
      "Run an independent review of exactly one immutable artifact-store version.",
      "",
      `Review target: ${target.id}`,
      `Artifact: ${target.artifactID}`,
      `Version: ${target.version} (${target.versionID})`,
      `Filename: ${target.filename}`,
      `MIME type: ${target.mimeType}`,
      `Size: ${target.size} bytes`,
      `SHA-256: ${target.sha256}`,
      "",
      `Call artifact_snapshot with target "${target.id}" to inspect these exact bytes.`,
      "You cannot read the live workspace, execute commands, or change files. Do not infer from the source path.",
      `Record every supported or refuted check with provenance_review target "${target.id}".`,
      "If the format cannot be inspected or evidence is unavailable, report that limitation and record no verdict.",
      "Never claim to have rerun an analysis you did not run.",
    ].join("\n")
  }

  /** Build the immutable review packet without launching a model turn. */
  export async function packet(sessionID: string, target?: Target) {
    await Session.get(sessionID)
    if (!target) return { agent: "reviewer", text: await context(sessionID) }
    const bound = await bind(sessionID, target)
    return { agent: "artifact-reviewer", text: artifactContext(bound), target: bound }
  }

  /** Kick off a reviewer pass. Resolves once the turn is queued, not finished. */
  export async function start(sessionID: string, target?: Target): Promise<Bound | undefined> {
    if (!target) await grant(sessionID)
    const review = await packet(sessionID, target)
    const settings = await ReviewSettings.get().catch(() => undefined)
    void SessionPrompt.prompt({
      sessionID,
      agent: review.agent,
      model: settings?.model ?? undefined,
      parts: [{ type: "text", text: review.text }],
    }).catch((error) => log.error("review pass failed", { sessionID, error }))
    return "target" in review ? review.target : undefined
  }

  /** Optional auto-review after a significant result (a durable artifact
   *  save). Off unless the user enabled it; never triggers on the reviewer's
   *  own work. */
  export async function auto(sessionID: string, agent: string) {
    if (agent === "reviewer") return
    const settings = await ReviewSettings.get().catch(() => undefined)
    if (!settings?.auto) return
    log.info("auto review triggered", { sessionID })
    await start(sessionID)
  }
}
