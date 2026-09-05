import { expect, test } from "bun:test"
import path from "path"

const python = Bun.which("python3") ?? Bun.which("python")
const fixture = path.join(import.meta.dir, "fixture/database_helpers.py")

for (const group of ["DrugBank", "OpenTargets", "Zotero"]) {
  test.skipIf(!python)(`${group} helpers preserve local data and current response semantics`, () => {
    const proc = Bun.spawnSync([python!, "-B", "-S", fixture, group], { stdout: "pipe", stderr: "pipe" })
    expect(proc.exitCode, proc.stdout.toString() + proc.stderr.toString()).toBe(0)
  })
}
