import { expect, test } from "bun:test"
import path from "node:path"

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

  const lifecycle = await Bun.file(path.join(root, "credentials/lifecycle.ts")).text()
  expect(lifecycle.match(/return await action\(\)/g)?.length).toBe(2)
  expect(lifecycle).not.toMatch(/await using lease[\s\S]{0,160}return action\(\)/)
})
