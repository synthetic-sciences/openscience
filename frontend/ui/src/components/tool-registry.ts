import type { Component } from "solid-js"

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  output?: string
  status?: string
  partID?: string
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
