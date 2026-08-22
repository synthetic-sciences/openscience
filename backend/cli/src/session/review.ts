import { File } from "@/file"
import { ArtifactStore } from "@/artifact/store"
import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { Provenance } from "@/science/provenance/store"
import { Review as ProvenanceReview } from "@/science/provenance/review"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionResearch } from "@/session/research"
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
    const [todos, artifacts, findings, contract] = await Promise.all([
      Todo.get(sessionID).catch(() => []),
      File.artifacts({ sessionID }).catch(() => []),
      ProvenanceReview.list({ projectID: Instance.project.id, directory: Instance.directory }).catch(() => []),
      SessionResearch.read(sessionID).catch(() => undefined),
    ])
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
    const current = findings.filter(
      (entry) =>
        entry.verdict === "refutes" &&
        entry.status !== "confirmed" &&
        ((entry.finding.meta as Record<string, unknown> | undefined)?.sessionID === sessionID ||
          (entry.targetNode?.meta as Record<string, unknown> | undefined)?.sessionID === sessionID),
    )
    if (current.length) {
      lines.push("Open or addressed findings requiring independent disposition:")
      for (const entry of current) {
        lines.push(`- [${entry.status ?? "open"}] ${entry.finding.id} against ${entry.target}: ${entry.finding.label}`)
      }
      lines.push(
        "For an addressed finding, inspect the correction evidence. If it resolves the defect, record a supports verdict against the original target and pass the exact original id in provenance_review's finding field; otherwise record the remaining defect.",
        "",
      )
    }
    if (contract?.preregistration) {
      lines.push(
        `Preregistration contract: immutable plan ${contract.preregistration.artifact.versionID}, SHA-256 ${contract.preregistration.artifact.sha256}, frozen ${new Date(contract.preregistration.frozenAt).toISOString()}.`,
        "Verify every preregistration claim against that exact version and ensure required Results descend from runs recorded after the freeze.",
        "",
      )
    }
    if (contract && !contract.preregistration) {
      lines.push(
        "Preregistration contract: none. Treat any claim that this work was preregistered or frozen before analysis as unsupported.",
        "",
      )
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

  function artifactContext(target: Bound, preregistration?: SessionResearch.Preregistration) {
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
      `Preregistration contract: ${preregistration ? `immutable plan ${preregistration.artifact.versionID}, SHA-256 ${preregistration.artifact.sha256}, frozen ${new Date(preregistration.frozenAt).toISOString()}` : "none; reject unsupported claims that this work was preregistered"}.`,
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
    const [bound, contract] = await Promise.all([bind(sessionID, target), SessionResearch.read(sessionID)])
    return {
      agent: "artifact-reviewer",
      text: artifactContext(bound, contract?.preregistration),
      target: bound,
    }
  }

  /** Prepare a first-class reviewer turn, including the narrow provenance
   * permissions required by a session-level audit. */
  export async function prepare(sessionID: string, target?: Target) {
    if (!target) await grant(sessionID)
    return packet(sessionID, target)
  }

  /** Kick off a reviewer pass. Resolves once the turn is queued, not finished. */
  export async function start(sessionID: string, target?: Target): Promise<Bound | undefined> {
    const review = await prepare(sessionID, target)
    const settings = await ReviewSettings.get().catch(() => undefined)
    const owner = await Session.messages({ sessionID })
      .then((messages) => {
        const latest = messages.findLast(
          (message) =>
            message.info.role === "user" &&
            message.info.agent !== "reviewer" &&
            message.info.agent !== "artifact-reviewer",
        )
        return latest?.info.role === "user" ? latest.info : undefined
      })
      .catch(() => undefined)
    const override = settings?.model ?? undefined
    void SessionPrompt.prompt({
      sessionID,
      agent: review.agent,
      model: override ?? owner?.model,
      effort: MessageV2.resolveResearchEffort(owner?.effort),
      variant: override ? undefined : owner?.variant,
      tier: override ? undefined : owner?.tier,
      parts: [{ type: "text", text: review.text }],
    }).catch((error) => log.error("review pass failed", { sessionID, error }))
    return "target" in review ? review.target : undefined
  }

  /** Optional auto-review after a significant Result save. Off unless the
   * user enabled it; never recursively triggers on a reviewer's own work. */
  export async function auto(sessionID: string, agent: string) {
    if (agent === "reviewer" || agent === "artifact-reviewer") return
    const settings = await ReviewSettings.get().catch(() => undefined)
    if (!settings?.auto) return
    log.info("auto review triggered", { sessionID })
    await start(sessionID)
  }
}
