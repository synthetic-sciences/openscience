import { describe, expect, test } from "bun:test"
import { createTraceExpansion } from "./session-trace"

const key = "openscience-trace-expansion-v1"
const storage = (value = "{}") => {
  const data = new Map([[key, value]])
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

describe("classic per-turn trace expansion", () => {
  test("a live turn opens once, then the first click collapses the actual displayed state", () => {
    const saved = storage()
    const trace = createTraceExpansion(saved)
    expect(trace.expanded("active")).toBe(false)
    trace.open("active")
    expect(trace.expanded("active")).toBe(true)
    trace.toggle("active")
    expect(trace.expanded("active")).toBe(false)
    trace.open("active")
    expect(trace.expanded("active")).toBe(false)
    expect(createTraceExpansion(saved).expanded("active")).toBe(false)
  })

  test("opening a new turn does not change other turns and survives remount", () => {
    const saved = storage('{"historic":true,"collapsed":false,"invalid":"true"}')
    const trace = createTraceExpansion(saved)
    trace.open("active")
    expect(trace.expanded("historic")).toBe(true)
    expect(trace.expanded("collapsed")).toBe(false)
    expect(trace.expanded("invalid")).toBe(false)
    trace.toggle("historic")
    const restored = createTraceExpansion(saved)
    expect(restored.expanded("active")).toBe(true)
    expect(restored.expanded("historic")).toBe(false)
  })

  test("malformed or unavailable storage degrades without blocking the control", () => {
    for (const value of ["broken", "null", "[]"]) {
      const trace = createTraceExpansion(storage(value))
      trace.toggle("active")
      expect(trace.expanded("active")).toBe(true)
    }
    const trace = createTraceExpansion({
      getItem() {
        throw new Error("unavailable")
      },
      setItem() {
        throw new Error("full")
      },
    })
    trace.open("active")
    expect(trace.expanded("active")).toBe(true)
  })

  test("retains only the latest 200 turn choices, including explicit false", () => {
    const saved = storage()
    const trace = createTraceExpansion(saved)
    for (let n = 0; n < 205; n++) trace.open(`turn-${n}`)
    trace.toggle("turn-204")
    const values = JSON.parse(saved.getItem(key)!)
    expect(Object.keys(values)).toHaveLength(200)
    expect(values["turn-0"]).toBeUndefined()
    expect(values["turn-204"]).toBe(false)
  })
})
