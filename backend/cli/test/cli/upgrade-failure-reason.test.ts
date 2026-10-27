import { describe, expect, test } from "bun:test"
import { Reason } from "../../src/util/reason"

describe("upgrade failure reason rendering", () => {
  test("every rejection shape an upgrade may surface renders a reason, not silence", () => {
    // Before this fix, `upgrade.ts` only reached prompts.log.error through an
    // `instanceof Error` branch; a non-Error rejection rendered NOTHING: the
    // user saw "Upgrade failed" with no reason at all.
    for (const rejection of ["tar exited with code 1", { exitCode: 2, syscall: "spawn" }, undefined]) {
      expect(Reason.of(rejection).length).toBeGreaterThan(0)
    }
  })

  test("Error rejections keep their message", () => {
    expect(Reason.of(new Error("checksum mismatch"))).toBe("checksum mismatch")
  })
})
