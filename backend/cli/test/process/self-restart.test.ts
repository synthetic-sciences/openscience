import { describe, expect, test } from "bun:test"
import { SELF_RESTART_ARG, SelfRestart } from "../../src/process/self-restart"

describe("self restart handoff", () => {
  test("preserves the entrypoint, command arguments, and working directory", () => {
    expect(
      SelfRestart.payload(
        ["/opt/bun", "/app/src/index.ts", "web", "/research", "--port", "4100"],
        "/opt/bun",
        "/research",
      ),
    ).toMatchObject({
      command: ["/opt/bun", "/app/src/index.ts", "web", "/research", "--port", "4100"],
      cwd: "/research",
    })
  })

  test("uses the compiled executable directly without duplicating it", () => {
    const payload = SelfRestart.payload(
      ["/usr/local/bin/openscience", "/usr/local/bin/openscience", "web"],
      "/usr/local/bin/openscience",
      "/tmp/project",
    )
    expect(payload.command).toEqual(["/usr/local/bin/openscience", "web"])
    expect(payload.command).not.toContain(SELF_RESTART_ARG)
  })
})
