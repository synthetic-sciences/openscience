import { expect, mock, spyOn, test } from "bun:test"
import * as childProcess from "child_process"
import type { ChildProcess } from "child_process"
import fs from "fs"
import { Shell } from "../../src/shell/shell"

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: platform })
  try {
    return run()
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor)
  }
}

async function withPlatformAsync<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: platform })
  try {
    return await run()
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor)
  }
}

function fakeProcess(pid: number) {
  return {
    pid,
    kill: mock(() => true),
  } as unknown as ChildProcess
}

test("pipefail makes Bash and Zsh pipelines report upstream failures", () => {
  expect(Shell.pipefail("/bin/bash", "false | true")).toBe("set -o pipefail\nfalse | true")
  expect(Shell.pipefail("/bin/zsh", "false | true")).toBe("set -o pipefail\nfalse | true")
  expect(Shell.pipefail("cmd.exe", "false | true")).toBe("false | true")
})

test("killTreeSync uses blocking taskkill on Windows", () => {
  const proc = fakeProcess(4321)
  const taskkill = spyOn(childProcess, "spawnSync").mockImplementation(
    () =>
      ({
        pid: 1,
        output: [],
        stdout: null,
        stderr: null,
        status: 0,
        signal: null,
      }) as any,
  )

  try {
    withPlatform("win32", () => Shell.killTreeSync(proc))
    expect(taskkill).toHaveBeenCalledTimes(1)
    expect(taskkill).toHaveBeenCalledWith("taskkill", ["/pid", "4321", "/f", "/t"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000,
    })
    expect(proc.kill).not.toHaveBeenCalled()
  } finally {
    taskkill.mockRestore()
  }
})

test("killTreeSync never group-kills a Linux child that is not the group leader", () => {
  const proc = fakeProcess(4321)
  const readStat = spyOn(fs, "readFileSync").mockImplementation(
    (() => "4321 (python worker) S 1 999 999 0") as unknown as typeof fs.readFileSync,
  )
  const groupKill = spyOn(process, "kill").mockImplementation(() => true)

  try {
    withPlatform("linux", () => Shell.killTreeSync(proc))
    expect(readStat).toHaveBeenCalledWith("/proc/4321/stat", "utf8")
    expect(groupKill).not.toHaveBeenCalled()
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL")
  } finally {
    readStat.mockRestore()
    groupKill.mockRestore()
  }
})

test("killTree SIGKILLs a detached group even after its leader exits", async () => {
  const proc = fakeProcess(4321)
  const groupKill = spyOn(process, "kill").mockImplementation(() => true)

  try {
    await withPlatformAsync("darwin", () =>
      Shell.killTree(proc, {
        detached: true,
        exited: () => true,
      }),
    )
    expect(groupKill).toHaveBeenNthCalledWith(1, -4321, "SIGTERM")
    expect(groupKill).toHaveBeenNthCalledWith(2, -4321, "SIGKILL")
    expect(proc.kill).not.toHaveBeenCalled()
  } finally {
    groupKill.mockRestore()
  }
})
