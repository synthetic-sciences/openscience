/**
 * RLM Artifacts — Object-level referencing for sparse context.
 *
 * Large data (DataFrames, analysis results, raw outputs) is stored on disk
 * and passed by reference. The LLM context holds only metadata + summary,
 * with actual data accessed via lazy loading in notebook/bash execution.
 */

import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import { Log } from "@/util/log"
import type { RLMState } from "./state"

export namespace RLMArtifacts {
  const log = Log.create({ service: "rlm-artifacts" })
  const ARTIFACTS_DIR = path.join(Global.Path.data, "artifacts")
  const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

  /** Register an artifact — writes content to disk, returns a reference. */
  export async function register(
    sessionId: string,
    type: string,
    content: string,
    summary?: string,
  ): Promise<RLMState.ArtifactRef> {
    const id = `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const dir = path.join(ARTIFACTS_DIR, sessionId)
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${id}.dat`)
    await Bun.write(filePath, content)
    log.info("artifact registered", { sessionId, id, type, size: content.length })
    return {
      id,
      type,
      summary: summary ?? `${type} artifact (${content.length} bytes)`,
      path: filePath,
    }
  }

  /** Resolve an artifact — reads full content from disk (lazy loading). */
  export async function resolve(sessionId: string, id: string): Promise<string | null> {
    const filePath = path.join(ARTIFACTS_DIR, sessionId, `${id}.dat`)
    try {
      return await Bun.file(filePath).text()
    } catch {
      log.warn("artifact not found", { sessionId, id })
      return null
    }
  }

  /** List all artifacts for a session. */
  export async function list(sessionId: string): Promise<RLMState.ArtifactRef[]> {
    const dir = path.join(ARTIFACTS_DIR, sessionId)
    try {
      const files = await fs.readdir(dir)
      return files
        .filter((f) => f.endsWith(".dat"))
        .map((f) => ({
          id: f.replace(".dat", ""),
          type: "unknown",
          summary: `Artifact ${f}`,
          path: path.join(dir, f),
        }))
    } catch {
      return []
    }
  }

  /** Cleanup artifacts older than TTL. Called on startup. */
  export async function cleanup(): Promise<void> {
    try {
      const exists = await fs.stat(ARTIFACTS_DIR).catch(() => null)
      if (!exists) return

      const sessions = await fs.readdir(ARTIFACTS_DIR)
      const now = Date.now()
      let cleaned = 0

      for (const session of sessions) {
        const dir = path.join(ARTIFACTS_DIR, session)
        const stat = await fs.stat(dir).catch(() => null)
        if (!stat?.isDirectory()) continue

        if (now - stat.mtimeMs > TTL_MS) {
          await fs.rm(dir, { recursive: true })
          cleaned++
        }
      }

      if (cleaned > 0) {
        log.info("cleaned old artifacts", { count: cleaned })
      }
    } catch (e) {
      log.warn("artifact cleanup error", { error: e instanceof Error ? e.message : String(e) })
    }
  }
}
