/**
 * RSI Trajectory Capture — Records (trajectory, experience, outcome) triples
 * from ultra agent sessions for later critic evaluation and skill distillation.
 */

import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"
import { RLMState } from "../rlm/state"
import { RSICritic } from "./critic"
import { RSIDistill } from "./distill"
import { RSILifecycle } from "./lifecycle"

export namespace RSITrajectory {
  const log = Log.create({ service: "rsi-trajectory" })
  const TRAJECTORIES_DIR = path.join(Global.Path.data, "trajectories")

  export const ARTIFACT_AGENTS = ["research", "biology", "ml"] as const

  export interface TrajectoryStep {
    tool: string
    inputSummary: string
    outputSummary: string
    durationMs?: number
  }

  export interface Trajectory {
    sessionId: string
    timestamp: number
    agent: string
    hypothesis: string
    steps: TrajectoryStep[]
    outcome: "success" | "partial" | "failure"
    tokenCost: number
    score?: number
  }

  /** Capture a trajectory from a completed ultra agent session.
   *  Called asynchronously after the session loop exits. */
  export async function capture(sessionID: string): Promise<Trajectory | null> {
    try {
      const session = await Session.get(sessionID)
      const messages = await Session.messages({ sessionID })

      if (!messages.length) return null

      // Extract agent name from the first assistant message
      const firstAssistant = messages.find((m) => m.info.role === "assistant")
      const agent = firstAssistant?.info.agent ?? "unknown"

      // Extract hypothesis from RLM state or first user message
      let hypothesis = ""
      for (const msg of messages) {
        if (msg.info.role === "assistant") {
          for (const part of msg.parts) {
            if (part.type === "text") {
              const state = RLMState.parseResearchState(part.text)
              if (state?.hypothesis) {
                hypothesis = state.hypothesis
                break
              }
            }
          }
        }
        if (hypothesis) break
      }

      if (!hypothesis) {
        const firstUser = messages.find((m) => m.info.role === "user")
        if (firstUser) {
          const textPart = firstUser.parts.find((p: any) => p.type === "text" && !p.synthetic)
          if (textPart && textPart.type === "text") {
            hypothesis = textPart.text.slice(0, 500)
          }
        }
      }

      // Extract tool call sequence
      const steps: TrajectoryStep[] = []
      for (const msg of messages) {
        if (msg.info.role !== "assistant") continue
        for (const part of msg.parts) {
          if (part.type !== "tool") continue
          const outputText =
            part.state.status === "completed"
              ? (part.state.output ?? "")
              : part.state.status === "error"
                ? (part.state.error ?? "")
                : ""
          steps.push({
            tool: part.tool,
            inputSummary: summarize(JSON.stringify(part.state.input ?? ""), 200),
            outputSummary: summarize(outputText, 200),
          })
        }
      }

      // Determine outcome from last RLM state or heuristic
      let outcome: Trajectory["outcome"] = "success"
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") continue
        for (const part of msg.parts) {
          if (part.type === "text") {
            const state = RLMState.parseResearchState(part.text)
            if (state) {
              const hasFailures = state.plan.some((o) => o.status === "failed")
              const allDone = state.plan.every((o) => o.status === "done" || o.status === "failed")
              const allFailed = state.plan.every((o) => o.status === "failed")
              if (allFailed) outcome = "failure"
              else if (hasFailures) outcome = "partial"
              else if (state.status === "complete" || allDone) outcome = "success"
              break
            }
          }
        }
        break
      }

      // Estimate token cost from message count (rough heuristic)
      const tokenCost = messages.reduce((acc, m) => {
        return acc + m.parts.reduce((a: number, p: any) => a + (p.type === "text" ? p.text.length / 4 : 50), 0)
      }, 0)

      const trajectory: Trajectory = {
        sessionId: sessionID,
        timestamp: Date.now(),
        agent,
        hypothesis,
        steps,
        outcome,
        tokenCost: Math.round(tokenCost),
      }

      // Write to disk
      await fs.mkdir(TRAJECTORIES_DIR, { recursive: true })
      const filePath = path.join(TRAJECTORIES_DIR, `${sessionID}.json`)
      await Bun.write(filePath, JSON.stringify(trajectory, null, 2))
      log.info("trajectory captured", { sessionId: sessionID, agent, steps: steps.length })

      return trajectory
    } catch (e) {
      log.error("trajectory capture failed", {
        sessionId: sessionID,
        error: e instanceof Error ? e.message : String(e),
      })
      return null
    }
  }

  /** Read a trajectory from disk. */
  export async function read(sessionId: string): Promise<Trajectory | null> {
    try {
      const filePath = path.join(TRAJECTORIES_DIR, `${sessionId}.json`)
      return await Bun.file(filePath).json()
    } catch {
      return null
    }
  }

  /** List all trajectory session IDs. */
  export async function list(): Promise<string[]> {
    try {
      const files = await fs.readdir(TRAJECTORIES_DIR)
      return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""))
    } catch {
      return []
    }
  }

  /** Update trajectory score (set by critic). */
  export async function setScore(sessionId: string, score: number): Promise<void> {
    const trajectory = await read(sessionId)
    if (!trajectory) return
    trajectory.score = score
    const filePath = path.join(TRAJECTORIES_DIR, `${sessionId}.json`)
    await Bun.write(filePath, JSON.stringify(trajectory, null, 2))
  }

  /** Full RSI pipeline: capture → evaluate → score → distill → register.
   *  All errors caught internally — safe to fire-and-forget. */
  export async function pipeline(sessionID: string): Promise<void> {
    try {
      const trajectory = await capture(sessionID)
      if (!trajectory) return

      const score = RSICritic.evaluate(trajectory)
      await setScore(sessionID, score.total)

      if (score.total >= 75) {
        const name = await RSIDistill.distill({ ...trajectory, score: score.total })
        if (name) {
          await RSILifecycle.registerSkill(name)
          log.info("pipeline: skill distilled and registered", { sessionId: sessionID, name, score: score.total })
        }
      } else {
        log.info("pipeline: score below threshold, skipping distill", { sessionId: sessionID, score: score.total })
      }
    } catch (e) {
      log.error("pipeline failed", { sessionId: sessionID, error: e instanceof Error ? e.message : String(e) })
    }
  }

  function summarize(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + "..."
  }
}
