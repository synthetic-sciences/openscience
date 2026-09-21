import { expect, test } from "bun:test"
import { healthyRuntime, pinnedVersion } from "../../../../frontend/desktop/src/service-health.mjs"

const packaged = { packaged: true, sidecar: false, supervised: false, version: "2.0.127" }
const source = { healthy: true, version: "0.0.0-main-202609210915", runId: "run_fixture" }

test("a packaged shell accepts only the runtime version it shipped with", () => {
  const version = pinnedVersion(packaged)
  expect(version).toBe("2.0.127")
  expect(healthyRuntime({ ...source, version: "2.0.127" }, version)).toBe(true)
  expect(healthyRuntime({ ...source, version: "2.0.126" }, version)).toBe(false)
  expect(healthyRuntime(source, version)).toBe(false)
})

test("a shell run from source accepts the build stamp of a from-source sidecar", () => {
  const version = pinnedVersion({ ...packaged, packaged: false })
  expect(version).toBeUndefined()
  expect(healthyRuntime(source, version)).toBe(true)
})

test("an explicitly chosen sidecar is not held to the shell's version", () => {
  expect(healthyRuntime(source, pinnedVersion({ ...packaged, sidecar: true }))).toBe(true)
  expect(healthyRuntime(source, pinnedVersion({ ...packaged, packaged: false, sidecar: true }))).toBe(true)
})

test("a supervised update launch proves the exact version even with a chosen sidecar", () => {
  const version = pinnedVersion({ ...packaged, sidecar: true, supervised: true })
  expect(version).toBe("2.0.127")
  expect(healthyRuntime(source, version)).toBe(false)
  expect(healthyRuntime({ ...source, version: "2.0.127" }, version)).toBe(true)
})

test("an unpinned shell still refuses a runtime that is not live", () => {
  expect(healthyRuntime(undefined, undefined)).toBe(false)
  expect(healthyRuntime({ ...source, healthy: false }, undefined)).toBe(false)
  expect(healthyRuntime({ ...source, healthy: "true" }, undefined)).toBe(false)
  expect(healthyRuntime({ ...source, runId: "" }, undefined)).toBe(false)
  expect(healthyRuntime({ healthy: true, version: source.version }, undefined)).toBe(false)
})
