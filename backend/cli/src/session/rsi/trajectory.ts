/**
 * RSI Trajectory Capture — Records (trajectory, experience, outcome) triples
 * from ultra agent sessions for later critic evaluation and skill distillation.
 */

import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import { Session } from "@/session"
import { Log } from "@/util/log"
import { RLMState } from "../rlm/state"
import { RSICritic } from "./critic"
import { RSIDistill } from "./distill"
import { RSILifecycle } from "./lifecycle"
import { HarnessEvaluation } from "../harness/evaluation"

export namespace RSITrajectory {
  const log = Log.create({ service: "rsi-trajectory" })
  const TRAJECTORIES_DIR = path.join(Global.Path.data, "trajectories")

  export const ARTIFACT_AGENTS = ["research", "biology", "physics", "ml"] as const

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
    reportedOutcome: "success" | "partial" | "failure"
    outcome: "unverified" | "success" | "partial" | "failure"
    tokenCost: number
    score?: number
    verification?: {
      runID: string
      evaluator: string
      status: HarnessEvaluation.Status
      score?: number
      evaluatedAt: number
    }
  }

  /** Capture a trajectory from a completed ultra agent session.
   *  Called asynchronously after the session loop exits. */
  export async function capture(sessionID: string): Promise<Trajectory | null> {
    try {
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

      // This is the agent's own process report, not scientific verification.
      // Keep it for diagnosis, but never use it to activate learned behavior.
      const reportedOutcome = (() => {
        const assistant = messages.findLast((message) => message.info.role === "assistant")
        if (!assistant) return "partial" as const
        const states = assistant.parts
          .filter((part) => part.type === "text")
          .map((part) => RLMState.parseResearchState(part.text))
          .filter((state) => state !== null)
        const state = states.at(-1)
        if (!state) return "partial" as const
        const allFailed = state.plan.length > 0 && state.plan.every((item) => item.status === "failed")
        if (allFailed) return "failure" as const
        if (state.plan.some((item) => item.status === "failed")) return "partial" as const
        const done = state.plan.length > 0 && state.plan.every((item) => item.status === "done")
        return state.status === "complete" || done ? ("success" as const) : ("partial" as const)
      })()

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
        reportedOutcome,
        outcome: "unverified",
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
      const value = (await Bun.file(filePath).json()) as Trajectory & {
        reportedOutcome?: Trajectory["reportedOutcome"]
      }
      if (value.reportedOutcome) return value
      return {
        ...value,
        reportedOutcome: value.outcome === "failure" ? "failure" : value.outcome === "partial" ? "partial" : "success",
        outcome: "unverified",
        verification: undefined,
      }
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

  /** Capture and process-score a trajectory. Scientific correctness remains
   *  unverified until recordEvaluation receives an external evaluator result. */
  export async function pipeline(sessionID: string): Promise<void> {
    try {
      const trajectory = await capture(sessionID)
      if (!trajectory) return

      const score = RSICritic.evaluate(trajectory)
      await setScore(sessionID, score.total)
      log.info("pipeline: trajectory awaits external evaluation", { sessionId: sessionID, processScore: score.total })
    } catch (e) {
      log.error("pipeline failed", { sessionId: sessionID, error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Persist an external result and, only for a verified pass, draft an inert
   *  skill proposal. Proposals are not discoverable skills until promoted. */
  export async function recordEvaluation(input: HarnessEvaluation.Info) {
    const evaluation = await HarnessEvaluation.record(input)
    const trajectory = await read(evaluation.sessionID)
    if (!trajectory) throw new Error(`No RSI trajectory exists for session ${evaluation.sessionID}`)

    trajectory.verification = {
      runID: evaluation.runID,
      evaluator: evaluation.evaluator.name,
      status: evaluation.status,
      score: evaluation.score,
      evaluatedAt: evaluation.evaluatedAt,
    }
    trajectory.outcome =
      evaluation.status === "passed" ? "success" : evaluation.status === "failed" ? "failure" : "partial"
    const score = RSICritic.evaluate(trajectory)
    trajectory.score = score.total
    await persist(trajectory)

    if (!HarnessEvaluation.verified(evaluation)) return { trajectory, proposal: null }
    const proposal = await RSIDistill.propose(trajectory)
    if (proposal) await RSILifecycle.registerProposal(proposal, evaluation)
    return { trajectory, proposal }
  }

  async function persist(trajectory: Trajectory) {
    await fs.mkdir(TRAJECTORIES_DIR, { recursive: true })
    await Bun.write(path.join(TRAJECTORIES_DIR, `${trajectory.sessionId}.json`), JSON.stringify(trajectory, null, 2))
  }

  function summarize(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + "..."
  }
}
