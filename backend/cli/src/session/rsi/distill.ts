/**
 * RSI Skill Distillation — Extracts learned skills from high-scoring trajectories.
 *
 * When a trajectory scores >= 75/100 from the critic, this module:
 * 1. Extracts the decomposition pattern, tool sequence, and failure recovery
 * 2. Generates a SKILL.md in the standard format
 * 3. Writes to ~/.openscience/learned-skills/{name}/SKILL.md
 * 4. Uploads to dashboard via the learned skill sync API
 */

import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { RSITrajectory } from "./trajectory"
import { OpenScience } from "@/openscience"

export namespace RSIDistill {
  const log = Log.create({ service: "rsi-distill" })
  const LEARNED_SKILLS_DIR = path.join(Global.Path.data, "learned-skills")
  const SCORE_THRESHOLD = 75

  /** Distill a learned skill from a scored trajectory.
   *  Only generates a skill if score >= threshold. Returns the skill name or null. */
  export async function distill(trajectory: RSITrajectory.Trajectory): Promise<string | null> {
    if (!trajectory.score || trajectory.score < SCORE_THRESHOLD) {
      log.info("trajectory below threshold, skipping distill", {
        sessionId: trajectory.sessionId,
        score: trajectory.score,
      })
      return null
    }

    const hash = trajectory.sessionId.slice(-8)
    const name = `learned-${trajectory.agent}-${hash}`
    const description = generateDescription(trajectory)
    const content = generateSkillContent(name, description, trajectory)

    // Write to local disk
    const dir = path.join(LEARNED_SKILLS_DIR, name)
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "SKILL.md"), content)
    log.info("learned skill distilled", { name, score: trajectory.score })

    // Upload to dashboard (async, non-blocking)
    OpenScience.uploadLearnedSkill(name, description, content, {
      agent: trajectory.agent,
      trajectory_id: trajectory.sessionId,
      score: trajectory.score,
    }).catch((e) => {
      log.warn("failed to upload learned skill", { name, error: e instanceof Error ? e.message : String(e) })
    })

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
source: rsi
trajectory_id: ${trajectory.sessionId}
score: ${trajectory.score}
metadata:
    skill-author: RSI Auto-Distillation
---

# ${name}

## Overview

This skill was automatically distilled from a high-scoring research trajectory
(score: ${trajectory.score}/100) by the RSI (Recursive Self-Improvement) system.
It captures a validated research workflow pattern.

## Origin

- **Agent**: ${trajectory.agent}
- **Hypothesis**: ${trajectory.hypothesis}
- **Outcome**: ${trajectory.outcome}
- **Score**: ${trajectory.score}/100
- **Steps**: ${trajectory.steps.length}
- **Distilled**: ${new Date(trajectory.timestamp).toISOString()}

## Workflow Pattern

This research pattern was validated through execution and critic evaluation.
Follow these steps when encountering similar research questions:

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
