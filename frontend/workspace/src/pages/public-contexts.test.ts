import { describe, expect, test } from "bun:test"
import { createContextState, type ContextStorage } from "@/atlas/store/ui"
import { productPreferences } from "@/context/product-preferences"
import { publicContextAvailable, sanitizePublicContexts } from "./public-contexts"

function memoryStorage(): ContextStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

describe("public workspace contexts", () => {
  test("legacy enabled preferences cannot expose Gateway or Trace", () => {
    productPreferences.sync({ atlas_enabled: true, show_trace: true })

    expect(productPreferences.atlas()).toBe(false)
    expect(productPreferences.trace()).toBe(false)
    expect(publicContextAvailable("canvas")).toBe(false)
    expect(publicContextAvailable("trace")).toBe(false)
    expect(publicContextAvailable("files")).toBe(true)
  })

  test("replaces a hidden-only persisted context with closed Files", () => {
    const storage = memoryStorage()
    const state = createContextState({ storage })
    state.activateScope("project-a", "session-a")
    state.openContext("canvas")
    state.openContext("trace")

    sanitizePublicContexts(state)

    expect(state.workTabs().map((tab) => tab.id)).toEqual(["view:files"])
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(false)

    const restored = createContextState({ storage })
    restored.activateScope("project-a", "session-a")
    expect(restored.workTabs().map((tab) => tab.id)).toEqual(["view:files"])
    expect(restored.context()).toBe("files")
    expect(restored.open()).toBe(false)
  })

  test("keeps a safe file active while removing hidden persisted tabs", () => {
    const state = createContextState({ storage: memoryStorage() })
    state.activateScope("project-a", "session-a")
    state.openFile("/work/project-a", "results/curve.csv")
    state.openContext("canvas")
    state.openContext("trace")

    sanitizePublicContexts(state)

    expect(state.workTabs().map((tab) => tab.id)).toEqual([
      "view:files",
      "file:%2Fwork%2Fproject-a:results%2Fcurve.csv",
    ])
    expect(state.file()?.path).toBe("results/curve.csv")
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)
  })
})
