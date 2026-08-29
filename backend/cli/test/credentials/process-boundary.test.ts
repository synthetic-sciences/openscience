import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { CredentialLifecycle } from "../../src/credentials/lifecycle"
import { FileLease } from "../../src/util/file-lease"

test("credential-bearing subprocess snapshots only appear behind the admitted spawn boundary", async () => {
  const root = path.resolve(import.meta.dir, "../..", "src")
  const raw: string[] = []
  for await (const relative of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
    if (relative === "openscience/index.ts") continue
    const source = await Bun.file(path.join(root, relative)).text()
    if (source.includes("OpenScience.subprocessEnv(")) raw.push(relative)
  }
  expect(raw).toEqual([])

  for (const relative of ["tool/bash.ts", "session/prompt.ts", "compute/jobs.ts", "mcp/index.ts"]) {
    const source = await Bun.file(path.join(root, relative)).text()
    expect(source, relative).toContain("OpenScience.withSubprocessEnv(")
  }

  for (const relative of ["format/index.ts", "file/publication.ts"]) {
    const source = await Bun.file(path.join(root, relative)).text()
    expect(source, relative).toContain("OpenScience.kernelEnv(")
    expect(source, relative).not.toContain("OpenScience.withSubprocessEnv(")
  }
})

test("credential mutation boundaries outwait the complete bounded telemetry request sequence", async () => {
  const timeouts: Array<number | undefined> = []
  const acquire = spyOn(FileLease, "acquire").mockImplementation(async (_filepath, timeout) => {
    timeouts.push(timeout)
    return {
      async during<T>(action: () => Promise<T>) {
        return action()
      },
      async [Symbol.asyncDispose]() {},
    }
  })

  try {
    await CredentialLifecycle.serialized(async () => "settled")
  } finally {
    acquire.mockRestore()
  }

  expect(timeouts).toEqual([30_000])
})
