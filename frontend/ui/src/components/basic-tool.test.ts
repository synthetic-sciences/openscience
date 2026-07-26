import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { resolveBasicToolChildren } from "./basic-tool"

describe("BasicTool children", () => {
  test("constructs a stateful child once when the resolved content is read repeatedly", () => {
    let constructions = 0

    createRoot((dispose) => {
      const content = resolveBasicToolChildren(() => {
        constructions++
        return "stateful child"
      })

      expect(content()).toBe("stateful child")
      expect(content()).toBe("stateful child")
      expect(content()).toBe("stateful child")
      expect(constructions).toBe(1)
      dispose()
    })
  })
})
