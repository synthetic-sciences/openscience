/**
 * RSI Critic — Evaluates trajectories by spawning the existing critique subagent
 * with a trajectory evaluation prompt. Scores on 4 dimensions (0-100).
 *
 * Scoring: Correctness(25) + Efficiency(25) + Coverage(25) + Reproducibility(25)
 */

import { Log } from "@/util/log"
import { RSITrajectory } from "./trajectory"

export namespace RSICritic {
  const log = Log.create({ service: "rsi-critic" })

  export interface CriticScore {
    total: number
    correctness: number
    efficiency: number
    coverage: number
    reproducibility: number
    notes: string
  }

  /** Build the evaluation prompt for the critique subagent. */
  export function buildPrompt(trajectory: RSITrajectory.Trajectory): string {
    const toolSequence = trajectory.steps
      .map((s, i) => `${i + 1}. ${s.tool}: ${s.inputSummary} → ${s.outputSummary}`)
      .join("\n")

    return `Evaluate this research trajectory and assign a score (0-100) across 4 dimensions.

## Trajectory
- Agent: ${trajectory.agent}
- Hypothesis: ${trajectory.hypothesis}
- Agent-reported outcome: ${trajectory.reportedOutcome}
- Externally verified outcome: ${trajectory.outcome}
- Steps: ${trajectory.steps.length}
- Token cost: ~${trajectory.tokenCost}

## Tool Sequence
${toolSequence}

## Scoring Rubric (each dimension 0-25, total 0-100)

### Correctness (0-25)
- Were the tools used correctly?
- Were the right databases/methods chosen for the question?
- Were statistical tests appropriate?
- Were conclusions supported by the evidence?

### Efficiency (0-25)
- Was the research path direct or did it wander?
- Were unnecessary tools called?
- Was token usage proportional to task complexity?
- Were parallel operations used where possible?

### Coverage (0-25)
- Was the literature reviewed adequately?
- Were findings validated with independent data?
- Were alternative hypotheses considered?
- Were limitations acknowledged?

### Reproducibility (0-25)
- Could another researcher follow this trajectory?
- Were data sources specified?
- Were parameters and thresholds documented?
- Were intermediate results saved?

## Response Format
Respond with ONLY a JSON object:
{
  "correctness": <0-25>,
  "efficiency": <0-25>,
  "coverage": <0-25>,
  "reproducibility": <0-25>,
  "total": <0-100>,
  "notes": "<1-2 sentence summary>"
}`
  }

  /** Parse critic output into a score. Returns null on parse failure. */
  export function parseScore(output: string): CriticScore | null {
    try {
      // Extract JSON from output (may have surrounding text)
      const jsonMatch = output.match(/\{[\s\S]*?"total"[\s\S]*?\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0])
      const score: CriticScore = {
        correctness: clamp(parsed.correctness ?? 0, 0, 25),
        efficiency: clamp(parsed.efficiency ?? 0, 0, 25),
        coverage: clamp(parsed.coverage ?? 0, 0, 25),
        reproducibility: clamp(parsed.reproducibility ?? 0, 0, 25),
        total: 0,
        notes: String(parsed.notes ?? ""),
      }
      score.total = score.correctness + score.efficiency + score.coverage + score.reproducibility
      return score
    } catch (e) {
      log.warn("failed to parse critic score", { error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  /** Deterministic process score. Correctness is zero until an external
   *  evaluator is attached; tool activity can never stand in for truth. */
  export function evaluate(trajectory: RSITrajectory.Trajectory): CriticScore {
    const stepCount = trajectory.steps.length
    const uniqueTools = new Set(trajectory.steps.map((s) => s.tool)).size
    const hasHypothesis = trajectory.hypothesis.length > 20
    const hasReasonableSteps = stepCount >= 3 && stepCount <= 30
    const correctness = trajectory.outcome === "success" ? 25 : trajectory.outcome === "partial" ? 10 : 0
    const efficiency = stepCount <= 5 ? 25 : stepCount <= 10 ? 22 : stepCount <= 20 ? 18 : stepCount <= 40 ? 12 : 5
    const coverage = uniqueTools >= 5 ? 20 : uniqueTools >= 3 ? 16 : uniqueTools >= 2 ? 12 : uniqueTools === 1 ? 8 : 0
    const reproducibility = (hasHypothesis ? 12 : 4) + (hasReasonableSteps ? 13 : 4)
    const score: CriticScore = {
      correctness,
      efficiency,
      coverage,
      reproducibility,
      total: correctness + efficiency + coverage + reproducibility,
      notes: `Process heuristic: verification=${trajectory.outcome}, reported=${trajectory.reportedOutcome}, steps=${stepCount}, tools=${uniqueTools}`,
    }

    log.info("process evaluation", { sessionId: trajectory.sessionId, total: score.total, outcome: trajectory.outcome })
    return score
  }

  function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(n)))
  }
}
