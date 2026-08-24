import { describe, expect, test } from "bun:test"
import { requiresOpenScienceAccount } from "../../src/cli/account-gate"

describe("CLI account gate", () => {
  test("keeps only authentication and recovery commands accountless", () => {
    for (const command of [
      "login",
      "logout",
      "status",
      "whoami",
      "init",
      "onboard",
      "doctor",
      "local",
      "web",
      "serve",
      "generate",
    ]) {
      expect(requiresOpenScienceAccount(command, [command])).toBe(false)
    }
    for (const command of ["run", "agent", "model", "keys", "wallet", "project", "skill", "mcp"]) {
      expect(requiresOpenScienceAccount(command, [command])).toBe(true)
    }
  })

  test("allows help, version, and the default workspace recovery shell", () => {
    expect(requiresOpenScienceAccount("run", ["run", "--help"])).toBe(false)
    expect(requiresOpenScienceAccount(undefined, [])).toBe(false)
    expect(requiresOpenScienceAccount("run", ["run", "--version"])).toBe(false)
  })
})
