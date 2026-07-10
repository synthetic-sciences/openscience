import { expect, test } from "bun:test"
import os from "os"
import { OpenScience } from "../src/openscience"

const expectedCap = String(Math.max(1, Math.min(os.cpus().length, 4)))

test("caps BLAS/OpenMP/joblib parallelism vars when unset", () => {
  const out = OpenScience.withComputeParallelismCaps({ PATH: "/usr/bin" })
  expect(out.OMP_NUM_THREADS).toBe(expectedCap)
  expect(out.OPENBLAS_NUM_THREADS).toBe(expectedCap)
  expect(out.MKL_NUM_THREADS).toBe(expectedCap)
  expect(out.VECLIB_MAXIMUM_THREADS).toBe(expectedCap) // macOS Accelerate
  expect(out.NUMBA_NUM_THREADS).toBe(expectedCap)
  expect(out.LOKY_MAX_CPU_COUNT).toBe(expectedCap) // bounds joblib worker-process copies
  expect(out.PATH).toBe("/usr/bin") // unrelated vars untouched
})

test("never overrides a value the user already set", () => {
  const out = OpenScience.withComputeParallelismCaps({ OMP_NUM_THREADS: "16", MKL_NUM_THREADS: "8" })
  expect(out.OMP_NUM_THREADS).toBe("16")
  expect(out.MKL_NUM_THREADS).toBe("8")
  // still fills the ones the user did not set
  expect(out.OPENBLAS_NUM_THREADS).toBe(expectedCap)
})

test("cap is at least 1 and at most 4", () => {
  const cap = Number(OpenScience.withComputeParallelismCaps({}).OMP_NUM_THREADS)
  expect(cap).toBeGreaterThanOrEqual(1)
  expect(cap).toBeLessThanOrEqual(4)
})
