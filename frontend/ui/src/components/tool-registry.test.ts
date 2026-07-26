import { describe, expect, test } from "bun:test"
import type { Component } from "solid-js"
import { ARTIFACT_TOOL, ToolRegistry, type ToolProps } from "./tool-registry"

const artifactRenderer = (() => null) as Component<ToolProps>
const namedRenderer = (() => null) as Component<ToolProps>

ToolRegistry.register({ name: ARTIFACT_TOOL, render: artifactRenderer })
ToolRegistry.register({ name: "e2e-named-artifact-tool", render: namedRenderer })

describe("ToolRegistry artifact fallback", () => {
  test("uses the artifact renderer for an unregistered tool with a valid envelope", () => {
    expect(
      ToolRegistry.render("notebook", {
        artifact: { kind: "image", data: { images: ["data:image/png;base64,e2e"] } },
      }),
    ).toBe(artifactRenderer)
  })

  test("keeps a tool-specific renderer ahead of the artifact fallback", () => {
    expect(ToolRegistry.render("e2e-named-artifact-tool", { artifact: { kind: "image" } })).toBe(namedRenderer)
  })

  test("does not treat malformed metadata as an artifact", () => {
    expect(ToolRegistry.render("notebook", { artifact: {} })).toBeUndefined()
    expect(ToolRegistry.render("notebook", { artifact: null })).toBeUndefined()
  })
})
