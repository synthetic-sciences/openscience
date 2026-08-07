/**
 * RSI Skill Proposals — Drafts inert skills from externally verified trajectories.
 *
 * When a trajectory scores >= 75/100 from the critic, this module:
 * 1. Extracts the decomposition pattern, tool sequence, and failure recovery
 * 2. Generates a SKILL.md in the standard format
 * 3. Writes to ~/.openscience/learned-skill-proposals/{name}/SKILL.md
 *
 * Proposals are deliberately outside learned-skills and are not uploaded or
 * discoverable. Promotion requires independent held-out evidence in the
 * lifecycle layer.
 */

import { Log } from "@/util/log"
import { RSITrajectory } from "./trajectory"
import { HarnessSkill } from "../harness/skill"

export namespace RSIDistill {
  const log = Log.create({ service: "rsi-distill" })
  const SCORE_THRESHOLD = 75

  /** Draft a proposal only when an external evaluator passed the trajectory. */
  export async function propose(trajectory: RSITrajectory.Trajectory): Promise<string | null> {
    if (!trajectory.score || trajectory.score < SCORE_THRESHOLD || trajectory.outcome !== "success") {
      log.info("trajectory ineligible for skill proposal", {
        sessionId: trajectory.sessionId,
        score: trajectory.score,
        outcome: trajectory.outcome,
      })
      return null
    }
    if (!trajectory.verification || trajectory.verification.status !== "passed") return null

    const hash = trajectory.sessionId.slice(-8)
    const name = `learned-${trajectory.agent}-${hash}`
    const description = generateDescription(trajectory)
    const content = generateSkillContent(name, description, trajectory)

    await HarnessSkill.propose({
      name,
      description,
      content,
      origin: "rsi",
      sessionID: trajectory.sessionId,
      runID: trajectory.verification.runID,
      createdAt: trajectory.timestamp,
    })
    log.info("learned skill proposal drafted", { name, score: trajectory.score })

    return name
  }

  function generateDescription(trajectory: RSITrajectory.Trajectory): string {
    const toolNames = [...new Set(trajectory.steps.map((s) => s.tool))]
    const domain = trajectory.agent.replace("-ultra", "")
    return `Learned ${domain} workflow: ${trajectory.hypothesis.slice(0, 100)}. Uses: ${toolNames.slice(0, 5).join(", ")}.`
  }

  function generateSkillContent(name: string, description: string, trajectory: RSITrajectory.Trajectory): string {
    const toolSequence = trajectory.steps.map((s, i) => `${i + 1}. **${s.tool}**: ${s.inputSummary}`).join("\n")

    const uniqueTools = [...new Set(trajectory.steps.map((s) => s.tool))]

    return `---
name: ${name}
description: ${description}
source: rsi-proposal
status: pending
trajectory_id: ${trajectory.sessionId}
score: ${trajectory.score}
metadata:
    skill-author: RSI Auto-Distillation
---

# ${name}

## Overview

This is an inert skill proposal drafted from an externally evaluated research
trajectory. It is not active until held-out evaluation and review promote it.

## Origin

- **Agent**: ${trajectory.agent}
- **Hypothesis**: ${trajectory.hypothesis}
- **Outcome**: ${trajectory.outcome}
- **Evaluator**: ${trajectory.verification?.evaluator}
- **Evaluation status**: ${trajectory.verification?.status}
- **Score**: ${trajectory.score}/100
- **Steps**: ${trajectory.steps.length}
- **Distilled**: ${new Date(trajectory.timestamp).toISOString()}

## Workflow Pattern

This pattern passed one external evaluation. Treat it as a candidate procedure
to test on independent tasks, not as established scientific guidance.

${toolSequence}

## Tools Used

${uniqueTools.map((t) => `- \`${t}\``).join("\n")}

## When to Use This Skill

Use this skill when the research question is similar to:
> ${trajectory.hypothesis}

## Recommendations

- Follow the tool sequence above as a starting template
- Adapt parameters based on your specific data and research question
- The pattern was validated for ${trajectory.agent} workflows
`
  }
}
