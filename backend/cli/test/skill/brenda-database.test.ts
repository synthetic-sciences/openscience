import { expect, test } from "bun:test"
import path from "path"

const python = Bun.which("python3") ?? Bun.which("python")
const script = path.resolve(import.meta.dir, "../../skills/databases/brenda-database/scripts/brenda_queries.py")

test("BRENDA query helpers compile before they are offered to agents (#485)", () => {
  if (!python) return

  const proc = Bun.spawnSync([python, "-m", "py_compile", script], { stderr: "pipe" })

  expect(proc.exitCode, proc.stderr.toString()).toBe(0)
})
