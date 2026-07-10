import { expect, test } from "bun:test"
import os from "os"
import { OpenScience } from "../src/openscience"

const CAP = String(Math.max(1, Math.min(4, os.cpus().length)))
const VARS = [
  "OMP_NUM_THREADS",
  "OPENBLAS_NUM_THREADS",
  "MKL_NUM_THREADS",
  "VECLIB_MAXIMUM_THREADS",
  "NUMEXPR_NUM_THREADS",
  "NUMBA_NUM_THREADS",
  "LOKY_MAX_CPU_COUNT",
]

test("pythonThreadCapEnv caps every thread/worker var when unset (#102)", () => {
  const capped = OpenScience.pythonThreadCapEnv({})
  for (const v of VARS) expect(capped[v]).toBe(CAP)
  // Cap is small and sane — this is what stops joblib/BLAS fanning out per-core.
  expect(Number(CAP)).toBeGreaterThanOrEqual(1)
  expect(Number(CAP)).toBeLessThanOrEqual(4)
})

test("pythonThreadCapEnv never overrides a value the user/agent already set", () => {
  const capped = OpenScience.pythonThreadCapEnv({ OMP_NUM_THREADS: "16", MKL_NUM_THREADS: "8" })
  // Explicit user values are left for the caller's env to win — not returned here.
  expect(capped.OMP_NUM_THREADS).toBeUndefined()
  expect(capped.MKL_NUM_THREADS).toBeUndefined()
  // The ones the user didn't set are still capped.
  expect(capped.OPENBLAS_NUM_THREADS).toBe(CAP)
  expect(capped.NUMBA_NUM_THREADS).toBe(CAP)
})

test("a python kernel spawned with the cap env actually sees the caps (live)", async () => {
  // Mirrors the notebook spawn: subprocess env + the thread caps. Proves the
  // wiring, not just the pure function — a real python process reads them back.
  const proc = Bun.spawn(
    ["python3", "-c", "import os,json;print(json.dumps({k:os.environ.get(k) for k in os.environ}))"],
    {
      env: { PATH: process.env.PATH ?? "", ...OpenScience.pythonThreadCapEnv({}) },
      stdout: "pipe",
    },
  )
  const seen = JSON.parse(await new Response(proc.stdout).text())
  await proc.exited
  for (const v of VARS) expect(seen[v]).toBe(CAP)
})

test("an explicit OMP override survives into the live kernel (user wins)", async () => {
  const env = {
    PATH: process.env.PATH ?? "",
    OMP_NUM_THREADS: "7",
    ...OpenScience.pythonThreadCapEnv({ OMP_NUM_THREADS: "7" }),
  }
  const proc = Bun.spawn(["python3", "-c", "import os;print(os.environ.get('OMP_NUM_THREADS'))"], {
    env,
    stdout: "pipe",
  })
  const out = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  expect(out).toBe("7")
})
