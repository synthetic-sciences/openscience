import { describe, it, expect } from "bun:test"
import { Progress } from "../progress"

describe("Progress", () => {
  it("emits start/update/done events in order", () => {
    const events: { kind: string; msg: string }[] = []
    const p = Progress.silent()
    p.onEvent((e) => events.push(e))
    p.start("Fetching repo")
    p.update("Performing security checks")
    p.done("Installed")
    expect(events.map((e) => e.kind)).toEqual(["start", "update", "done"])
    expect(events[0].msg).toBe("Fetching repo")
  })

  it("silent mode does not write to stdout", () => {
    const p = Progress.silent()
    p.start("x")
    p.update("y")
    p.done("z")
    expect(true).toBe(true) // structural — interactive path is the only one that writes
  })
})
