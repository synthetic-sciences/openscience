import { expect, test } from "bun:test"
import os from "os"
import { OpenScience } from "../src/openscience"

const cap = String(Math.min(Math.max(1, os.cpus().length), 4))

test("caps joblib worker-process count (LOKY) when unset", () => {
  const out = OpenScience.withComputeParallelismCaps({ PATH: "/usr/bin" })
  expect(out.LOKY_MAX_CPU_COUNT).toBe(cap)
  expect(out.PATH).toBe("/usr/bin") // unrelated vars untouched
})

test("does NOT cap shared-memory BLAS/OpenMP/numba thread pools", () => {
  // Those are threads (no per-thread data copy) — capping them only throttles
  // legit compute without saving memory. Only worker PROCESSES are bounded.
  const out = OpenScience.withComputeParallelismCaps({})
  expect(out.OMP_NUM_THREADS).toBeUndefined()
  expect(out.MKL_NUM_THREADS).toBeUndefined()
  expect(out.NUMBA_NUM_THREADS).toBeUndefined()
})

test("never overrides a user-set LOKY_MAX_CPU_COUNT", () => {
  const out = OpenScience.withComputeParallelismCaps({ LOKY_MAX_CPU_COUNT: "16" })
  expect(out.LOKY_MAX_CPU_COUNT).toBe("16")
})

test("cap is between 1 and 4", () => {
  const n = Number(OpenScience.withComputeParallelismCaps({}).LOKY_MAX_CPU_COUNT)
  expect(n).toBeGreaterThanOrEqual(1)
  expect(n).toBeLessThanOrEqual(4)
})
