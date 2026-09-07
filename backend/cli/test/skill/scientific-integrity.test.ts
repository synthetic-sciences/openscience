import { expect, test } from "bun:test"
import path from "node:path"

const python = Bun.which("python3") ?? Bun.which("python")
test.skipIf(!python)("scientific helper methods and validation reports describe what actually ran", () => {
  const result = Bun.spawnSync([python!, "-B", "-S", path.join(import.meta.dir, "fixture/scientific_integrity.py")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

const rdkitPython = process.env.OPENSCIENCE_TEST_RDKIT_PYTHON

test.skipIf(!rdkitPython)("real RDKit ligand inspection accounts for every input record", async () => {
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-rdkit-test-"))
  const output = path.join(root, "evidence")
  const result = Bun.spawnSync(
    [rdkitPython!, "-B", path.join(import.meta.dir, "fixture/rdkit_rescore.py"), "--output", output],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(
    result.exitCode,
    `${result.stdout.toString()}\n${result.stderr.toString()}\nEvidence retained: ${output}`,
  ).toBe(0)
  const report = JSON.parse(await fs.readFile(path.join(output, "report.json"), "utf8"))
  expect(report.status).toBe("passed")
  expect(report.case_count).toBe(9)
  await fs.rm(root, { recursive: true, force: true })
})
