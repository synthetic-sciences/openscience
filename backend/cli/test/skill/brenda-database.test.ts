import { expect, test } from "bun:test"
import path from "path"

const python = Bun.which("python3") ?? Bun.which("python")
const fixture = path.join(import.meta.dir, "fixture/database_helpers.py")

// Extends the compile regression contributed by banz in PR #490.
test.skipIf(!python)("BRENDA helpers compile, import and use the documented SOAP contract (#485)", () => {
  const proc = Bun.spawnSync([python!, "-B", "-S", fixture, "Brenda"], { stdout: "pipe", stderr: "pipe" })
  expect(proc.exitCode, proc.stdout.toString() + proc.stderr.toString()).toBe(0)
})
