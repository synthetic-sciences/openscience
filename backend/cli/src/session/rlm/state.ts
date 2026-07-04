/**
 * RLM State — Type definitions and trace parser for the dual-loop architecture.
 *
 * The planner (ultra agents) emits <rlm_state> JSON blocks tracking research progress.
 * The executor (task subtasks) returns <rlm_result> XML with compressed results.
 * This module defines the shared types and parses executor output.
 */

export namespace RLMState {
  export interface ResearchState {
    hypothesis: string
    plan: Objective[]
    artifacts: ArtifactRef[]
    findings: Finding[]
    status: "planning" | "executing" | "synthesizing" | "complete"
  }

  export interface Objective {
    id: string
    description: string
    status: "pending" | "active" | "done" | "failed"
    dependencies: string[]
    result?: string
  }

  export interface ArtifactRef {
    id: string
    type: string
    summary: string
    path: string
  }

  export interface Finding {
    id: string
    claim: string
    evidence: string[]
    confidence: "high" | "medium" | "low"
  }

  export interface CompressedResult {
    status: "success" | "partial" | "failure"
    findings: string[]
    failures: string[]
    assumptions: string[]
    parameters: Record<string, unknown>
    artifactRefs: string[]
    suggestions: string[]
  }

  /** Parse <rlm_result> XML from executor output into a CompressedResult.
   *  Falls back to wrapping the entire text as a single finding if no tags found. */
  export function parseExecutorOutput(text: string): CompressedResult {
    const match = text.match(/<rlm_result>([\s\S]*?)<\/rlm_result>/)
    if (!match) {
      return {
        status: "success",
        findings: [text.slice(0, 2000)],
        failures: [],
        assumptions: [],
        parameters: {},
        artifactRefs: [],
        suggestions: [],
      }
    }

    const block = match[1]

    const extract = (tag: string): string => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
      return m?.[1]?.trim() ?? ""
    }

    const parseArray = (raw: string): string[] => {
      if (!raw) return []
      try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)]
      } catch {
        return raw ? [raw] : []
      }
    }

    const parseObj = (raw: string): Record<string, unknown> => {
      if (!raw) return {}
      try {
        const parsed = JSON.parse(raw)
        return typeof parsed === "object" && parsed !== null ? parsed : {}
      } catch {
        return {}
      }
    }

    const status = extract("status")
    const validStatus = ["success", "partial", "failure"].includes(status)
      ? (status as CompressedResult["status"])
      : "success"

    return {
      status: validStatus,
      findings: parseArray(extract("findings")),
      failures: parseArray(extract("failures")),
      assumptions: parseArray(extract("assumptions")),
      parameters: parseObj(extract("parameters")),
      artifactRefs: parseArray(extract("artifact_refs")),
      suggestions: parseArray(extract("suggestions")),
    }
  }

  /** Parse <rlm_state> JSON from planner output. Returns null if not found. */
  export function parseResearchState(text: string): ResearchState | null {
    const match = text.match(/<rlm_state>([\s\S]*?)<\/rlm_state>/)
    if (!match) return null
    try {
      return JSON.parse(match[1].trim()) as ResearchState
    } catch {
      return null
    }
  }
}
