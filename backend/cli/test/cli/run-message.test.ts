import { describe, expect, test } from "bun:test"
import { runMessage } from "../../src/cli/cmd/run"

describe("openscience run message assembly", () => {
  test("joins parsed positional arguments without reintroducing shell quotes", () => {
    expect(runMessage(["Explain this concept clearly."])).toBe("Explain this concept clearly.")
    expect(runMessage(["Explain this", "concept clearly."])).toBe("Explain this concept clearly.")
  })

  test("preserves quote and shell-like characters as user text", () => {
    expect(runMessage(['Explain "selection bias"', "$HOME", "`literal`"])).toBe(
      'Explain "selection bias" $HOME `literal`',
    )
  })
})
