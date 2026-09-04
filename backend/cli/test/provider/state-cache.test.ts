import { afterEach, beforeEach, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Provider } from "../../src/provider/provider"
import { Log } from "../../src/util/log"

// The provider loader logs "init" once per build. `Log.create` returns the
// one shared logger for the service, so wrapping its `info` observes the real
// loader without touching how it is written or where the log goes.
const logger = Log.create({ service: "provider" })
const original = logger.info
const state = { inits: 0 }

beforeEach(() => {
  state.inits = 0
  logger.info = (message?: unknown, extra?: Record<string, unknown>) => {
    if (message === "init") state.inits++
    original.call(logger, message, extra)
  }
  Provider.invalidate()
})
afterEach(() => {
  logger.info = original
  Provider.invalidate()
})

const list = (directory: string) => Instance.provide({ directory, fn: () => Provider.list() })

test("provider state survives a project switch when the provider inputs are unchanged", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const built = await list(first.path)
  expect(state.inits).toBe(1)

  // Opening another project with the same provider config, trust and auth
  // reuses the built state: the same object, and no second "init" pass.
  const reused = await list(second.path)
  expect(reused).toBe(built)
  expect(state.inits).toBe(1)

  // Switching back is free as well.
  expect(await list(first.path)).toBe(built)
  expect(state.inits).toBe(1)
})

test("a project whose provider config differs rebuilds the state", async () => {
  await using plain = await tmpdir()
  await using declared = await tmpdir({
    config: {
      provider: {
        probe: {
          name: "Project provider probe",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          options: { baseURL: "http://127.0.0.1:1/v1" },
          models: { m: { name: "Probe", limit: { context: 1000, output: 100 } } },
        },
      },
    },
  })
  const built = await list(plain.path)
  expect(built.probe).toBeUndefined()
  const rebuilt = await list(declared.path)
  expect(rebuilt).not.toBe(built)
  expect(rebuilt.probe?.models.m?.name).toBe("Probe")
  expect(state.inits).toBe(2)
  // Back in the plain project the declared provider must not leak across.
  const again = await list(plain.path)
  expect(again).not.toBe(rebuilt)
  expect(again.probe).toBeUndefined()
  expect(state.inits).toBe(3)
})

test("a trust change rebuilds the state for the same project", async () => {
  await using project = await tmpdir()
  const built = await list(project.path)
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      const status = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, { trusted: !status.canExecuteProjectCode, root: status.root })
    },
  })
  expect(await list(project.path)).not.toBe(built)
  expect(state.inits).toBe(2)
})

test("an explicit invalidation rebuilds the state on the next read", async () => {
  await using project = await tmpdir()
  const built = await list(project.path)
  Provider.invalidate()
  expect(await list(project.path)).not.toBe(built)
  expect(state.inits).toBe(2)
})
