import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { Global } from "../../src/global"
import { WorkspaceCredentials } from "../../src/openscience/workspace-credentials"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Provider } from "../../src/provider/provider"
import { JsonStore } from "../../src/util/jsonstore"
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

// The directory no longer keys the state, so a credential that changes
// between two project switches must reach the revision through the auth
// file's stat, the workspace overlay's stat or the env hash. Each of those
// inputs is exercised on its own below.

test("a provider key stored through Auth rebuilds the state and the provider appears", async () => {
  await using project = await tmpdir()
  const built = await list(project.path)
  expect(built.openrouter).toBeUndefined()
  try {
    await Auth.set("openrouter", { type: "api", key: "sk-or-v1-state-cache-probe" })
    const rebuilt = await list(project.path)
    expect(rebuilt).not.toBe(built)
    expect(rebuilt.openrouter?.key).toBe("sk-or-v1-state-cache-probe")
    expect(state.inits).toBe(2)
  } finally {
    await Auth.remove("openrouter")
  }
})

test("a credential file replaced with no in-process invalidation still rebuilds", async () => {
  // A writer that skips the credential lifecycle (or a second server sharing
  // the data directory) replaces auth.json: only its stat reaches the revision.
  await using project = await tmpdir()
  const built = await list(project.path)
  expect(built.groq).toBeUndefined()
  const file = path.join(Global.Path.data, "auth.json")
  try {
    await JsonStore.update(file, (data) => ({ ...data, groq: { type: "api", key: "gsk_state_cache_probe" } }))
    const rebuilt = await list(project.path)
    expect(rebuilt).not.toBe(built)
    expect(rebuilt.groq?.key).toBe("gsk_state_cache_probe")
    expect(state.inits).toBe(2)
  } finally {
    await JsonStore.update(file, ({ groq: _, ...rest }) => rest)
  }
})

test("a provider key that appears in the environment rebuilds the state once across projects", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const built = await list(first.path)
  expect(built.xai).toBeUndefined()
  try {
    const rebuilt = await Instance.provide({
      directory: first.path,
      fn: () => {
        Env.set("XAI_API_KEY", "xai-state-cache-probe")
        return Provider.list()
      },
    })
    expect(rebuilt).not.toBe(built)
    expect(rebuilt.xai?.source).toBe("env")
    expect(state.inits).toBe(2)
    // The same inputs from another project reuse the rebuilt state.
    expect(await list(second.path)).toBe(rebuilt)
    expect(state.inits).toBe(2)
  } finally {
    delete process.env.XAI_API_KEY
  }
})

test("a replaced workspace credential overlay rebuilds the state once across projects", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const built = await list(first.path)
  try {
    await WorkspaceCredentials.write(
      { api_key: "thk_state_cache_probe" },
      { organization_id: "org_state_cache_probe", auth: {}, services: {} },
    )
    const rebuilt = await list(first.path)
    expect(rebuilt).not.toBe(built)
    expect(state.inits).toBe(2)
    expect(await list(second.path)).toBe(rebuilt)
    expect(state.inits).toBe(2)
  } finally {
    await WorkspaceCredentials.clear()
  }
})
