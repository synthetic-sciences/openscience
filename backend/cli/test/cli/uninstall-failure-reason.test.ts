import { expect, spyOn, test } from "bun:test"
import * as prompts from "@clack/prompts"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { executeUninstall } from "../../src/cli/cmd/uninstall"
import { CliShim } from "../../src/installation/cli-shim"

test("uninstall reports falsey directory, shell cleanup, and command-line link rejections", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-uninstall-failure-"))
  const shell = path.join(directory, ".zshrc")
  const content = '# openscience\nexport PATH="$HOME/.openscience/bin:$PATH"\n'
  await Bun.write(shell, content)
  const stops: Array<{ message?: string; code?: number }> = []
  const spinner = spyOn(prompts, "spinner").mockReturnValue({
    start() {},
    stop(message, code) {
      stops.push({ message, code })
    },
    message() {},
    isCancelled: false,
  })
  const remove = spyOn(fs, "rm")
  const write = spyOn(Bun, "write")
  const link = spyOn(CliShim, "remove")
  const error = spyOn(prompts.log, "error").mockImplementation(() => {})
  const warn = spyOn(prompts.log, "warn").mockImplementation(() => {})
  const success = spyOn(prompts.log, "success").mockImplementation(() => {})
  try {
    for (const reason of [undefined, null, false, 0, ""]) {
      stops.length = 0
      error.mockClear()
      remove.mockRejectedValue(reason)
      write.mockRejectedValue(reason)
      link.mockRejectedValue(reason)

      await executeUninstall("unknown", {
        directories: [{ path: directory, label: "Cache", keep: false }],
        shellConfig: shell,
        binary: null,
        link: path.join(directory, "openscience"),
      })

      expect(stops).toEqual([
        { message: "Failed to remove Cache", code: 1 },
        { message: "Failed to clean shell config", code: 1 },
        { message: "Failed to remove the command-line link", code: 1 },
      ])
      expect(warn).toHaveBeenCalledWith("Some operations failed:")
      expect(error).toHaveBeenCalledWith(`  Cache: ${String(reason)}`)
      expect(error).toHaveBeenCalledWith(`  Shell config: ${String(reason)}`)
      expect(error).toHaveBeenCalledWith(`  Command-line link: ${String(reason)}`)
      expect(await fs.stat(directory)).toBeDefined()
      expect(await Bun.file(shell).text()).toBe(content)
    }
  } finally {
    for (const spy of [spinner, remove, write, link, error, warn, success]) spy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
