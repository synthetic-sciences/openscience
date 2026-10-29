import { describe, expect, spyOn, test } from "bun:test"
import * as prompts from "@clack/prompts"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"
import { UI } from "../../src/cli/ui"
import { Installation } from "../../src/installation"

describe("upgrade failure reporting", () => {
  test("every rejection reports failure, including falsey reasons", async () => {
    const stops: Array<{ message?: string; code?: number }> = []
    const spinner = spyOn(prompts, "spinner").mockReturnValue({
      start() {},
      stop(message, code) {
        stops.push({ message, code })
      },
      message() {},
      isCancelled: false,
    })
    const method = spyOn(Installation, "method").mockResolvedValue("curl")
    const upgrade = spyOn(Installation, "upgrade")
    const error = spyOn(prompts.log, "error").mockImplementation(() => {})
    const info = spyOn(prompts.log, "info").mockImplementation(() => {})
    const intro = spyOn(prompts, "intro").mockImplementation(() => {})
    const outro = spyOn(prompts, "outro").mockImplementation(() => {})
    const output = spyOn(UI, "println").mockImplementation(() => {})
    try {
      for (const reason of [undefined, null, false, 0, "", "tar exited with code 1", new Error("checksum mismatch")]) {
        stops.length = 0
        error.mockClear()
        upgrade.mockRejectedValue(reason)

        await UpgradeCommand.handler({ target: "9.9.9", method: "curl", _: [], $0: "openscience" })

        expect(stops).toEqual([{ message: "Upgrade failed", code: 1 }])
        expect(error).toHaveBeenCalledWith(reason instanceof Error ? reason.message : String(reason))
      }

      stops.length = 0
      error.mockClear()
      upgrade.mockResolvedValue(undefined)
      await UpgradeCommand.handler({ target: "9.9.9", method: "curl", _: [], $0: "openscience" })
      expect(stops).toEqual([{ message: "Upgrade complete", code: undefined }])
      expect(error).not.toHaveBeenCalled()
    } finally {
      for (const spy of [spinner, method, upgrade, error, info, intro, outro, output]) spy.mockRestore()
    }
  })
})
