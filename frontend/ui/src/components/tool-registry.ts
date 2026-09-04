import type { Component } from "solid-js"
import type { FilePart } from "@synsci/sdk/v2"
import type { ToolSummary } from "./tool-display"

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  output?: string
  status?: string
  /** Lifecycle timestamps from the part, so any renderer can show elapsed time or duration. */
  time?: { start: number; end?: number }
  /** One-line receipt for the collapsed row (lines, matches, exit code). */
  summary?: ToolSummary[]
  /** The failure text when the call errored; the row shows its first line inline. */
  error?: string
  partID?: string
  attachments?: FilePart[]
  title?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  locked?: boolean
}

export type ToolComponent = Component<ToolProps>

// OpenScience science-artifact tool renderer id. The workspace registers its
// renderer under this name, while ordinary tools can opt into it by returning
// a valid `metadata.artifact` envelope.
export const ARTIFACT_TOOL = "__artifact__"

const state: Record<string, { name: string; render?: ToolComponent }> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string, metadata?: Record<string, unknown>) {
  const named = state[name]?.render
  if (named) return named

  const artifact = metadata?.artifact
  if (!artifact || typeof artifact !== "object" || typeof (artifact as { kind?: unknown }).kind !== "string") {
    return undefined
  }

  return state[ARTIFACT_TOOL]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}
