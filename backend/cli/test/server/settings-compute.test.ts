import { test, expect, afterAll } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Project } from "../../src/project/project"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { ProjectTrust } from "../../src/project/trust"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { ComputeSettings, ComputeSettingsRoutes } from "../../src/server/routes/settings/compute"
import { Sandbox } from "../../src/sandbox/sandbox"
import { Log } from "../../src/util/log"
import { Global } from "../../src/global"
import { executionSession, tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const fetch = Server.internalFetch()
const jobs = "http://openscience.internal/settings/compute/jobs"

// Every env var the compute store can own — cleaned up so other test files
// never see leftovers from this one.
const VARS = [
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "TENSORPOOL_KEY",
  "TENSORPOOL_API_KEY",
  "LAMBDA_API_KEY",
  "LAMBDA_LABS_API_KEY",
  "PRIME_API_KEY",
  "PRIME_INTELLECT_API_KEY",
  "VAST_API_KEY",
  "RUNPOD_API_KEY",
]

afterAll(() => {
  for (const name of VARS) delete process.env[name]
})

function connect(provider: string, key: string) {
  return ComputeSettingsRoutes().request(`/provider/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  })
}

async function settle(url: string, id: string, headers: Record<string, string> = {}) {
  for (const _ of Array.from({ length: 100 })) {
    const response = await fetch(url, { headers })
    const items = (await response.json()) as { id: string; status: string }[]
    const item = items.find((entry) => entry.id === id)
    if (item && ["succeeded", "failed", "cancelled"].includes(item.status)) return item
    await Bun.sleep(20)
  }
  throw new Error("Timed out waiting for route compute job")
}

async function session(directory: string, trusted = true) {
  return Instance.provide({
    directory,
    init: InstanceBootstrap,
    fn: async () => {
      if (trusted) return executionSession()
      return Session.create({})
    },
  })
}

test("connecting a provider stores its key without exposing it to the process env", async () => {
  const res = await connect("tensorpool", "tp-test-secret-123")
  expect(res.status).toBe(200)

  expect(process.env["TENSORPOOL_KEY"]).toBeUndefined()
  expect(process.env["TENSORPOOL_API_KEY"]).toBeUndefined()

  // The key itself never travels back to the client.
  const body = await res.text()
  expect(body).not.toContain("tp-test-secret-123")
  const info = JSON.parse(body)
  expect(info.providers.find((p: { id: string }) => p.id === "tensorpool").connected).toBe(true)
  expect(info.providers.find((p: { id: string }) => p.id === "tensorpool").enabled).toBe(false)
})

test("modal credentials resolve only for the trusted control plane while enabled", async () => {
  const res = await connect("modal", "ak-test-id : as-test-secret")
  expect(res.status).toBe(200)
  expect(process.env["MODAL_TOKEN_ID"]).toBeUndefined()
  expect(process.env["MODAL_TOKEN_SECRET"]).toBeUndefined()
  await expect(ComputeSettings.providerEnv("modal")).rejects.toThrow("disabled")

  const enabled = await ComputeSettingsRoutes().request("/provider/modal/enabled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  })
  expect(enabled.status).toBe(200)
  expect(await ComputeSettings.providerEnv("modal")).toEqual({
    MODAL_TOKEN_ID: "ak-test-id",
    MODAL_TOKEN_SECRET: "as-test-secret",
  })
  expect(process.env["MODAL_TOKEN_ID"]).toBeUndefined()
  expect(process.env["MODAL_TOKEN_SECRET"]).toBeUndefined()

  await ComputeSettingsRoutes().request("/provider/modal/enabled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  })
  await expect(ComputeSettings.providerEnv("modal")).rejects.toThrow("disabled")
})

test("Modal can use an active ~/.modal.toml profile without copying its tokens", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, ".modal.toml")
  await Bun.write(
    file,
    [
      "[inactive]",
      'token_id = "ak-unused"',
      'token_secret = "as-unused"',
      "",
      "[openscience]",
      "active = true",
      'token_id = "ak-from-toml"',
      'token_secret = "as-from-toml"',
    ].join("\n"),
  )

  expect(await ComputeSettings.modalFile(file)).toEqual({ found: true, ready: true })
  const info = await ComputeSettings.configureModal(file)
  const modal = info.providers.find((item) => item.id === "modal")
  expect(modal).toMatchObject({ connected: true, enabled: true, source: "modal_toml" })
  expect(JSON.stringify(info)).not.toContain("ak-from-toml")
  expect(JSON.stringify(info)).not.toContain("as-from-toml")
  expect(JSON.stringify(info)).not.toContain(tmp.path)
  expect(await ComputeSettings.providerEnv("modal")).toEqual({
    MODAL_TOKEN_ID: "ak-from-toml",
    MODAL_TOKEN_SECRET: "as-from-toml",
  })

  await ComputeSettings.setProviderEnabled("modal", false)
  await expect(ComputeSettings.providerEnv("modal")).rejects.toThrow("disabled")
  await ComputeSettings.disconnectProvider("modal")
})

test("configuring Modal migrates legacy compute defaults", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, ".modal.toml")
  const settings = path.join(Global.Path.data, "settings-compute.json")
  const previous = (await Bun.file(settings).exists()) ? await Bun.file(settings).text() : undefined
  await using restore = {
    async [Symbol.asyncDispose]() {
      if (previous !== undefined) {
        await Bun.write(settings, previous)
        return
      }
      await fs.rm(settings, { force: true })
    },
  }
  await Bun.write(file, '[default]\nactive = true\ntoken_id = "ak-id"\ntoken_secret = "as-secret"\n')
  await Bun.write(
    settings,
    JSON.stringify({
      providers: {},
      ssh_hosts: [],
      modal: {
        app: "legacy-app",
        network: "unset",
        timeout_hours: 12,
        upload_mode: "policy",
      },
    }),
  )

  const info = await ComputeSettings.configureModal(file)
  expect(info.modal).toEqual({
    app: "legacy-app",
    image: "python:3.12-slim",
    network: "none",
    timeout_minutes: 720,
    concurrency: 10,
  })
  expect(info.providers.find((item) => item.id === "modal")).toMatchObject({
    connected: true,
    enabled: true,
    source: "modal_toml",
  })
})

test("Modal config discovery defers inactive profile resolution until an enabled operation", async () => {
  await using tmp = await tmpdir()
  const missing = path.join(tmp.path, ".modal.toml")
  expect(await ComputeSettings.modalFile(missing)).toEqual({ found: false, ready: false })

  await Bun.write(missing, '[default]\ntoken_id = "ak-id"\ntoken_secret = "as-secret"\n')
  expect(await ComputeSettings.modalFile(missing)).toEqual({ found: true, ready: true })
  const configured = await ComputeSettings.configureModal(missing)
  expect(configured.providers.find((item) => item.id === "modal")).toMatchObject({
    connected: true,
    enabled: true,
    source: "modal_toml",
  })
  await expect(ComputeSettings.providerEnv("modal")).rejects.toThrow("invalid credentials")
  await ComputeSettings.disconnectProvider("modal")
})

test("connecting a provider does not overwrite an explicit shell export", async () => {
  process.env["VAST_API_KEY"] = "from-shell"
  const res = await connect("vast", "vast-stored-key")
  expect(res.status).toBe(200)
  expect(process.env["VAST_API_KEY"]).toBe("from-shell")
})

test("disconnecting a provider removes its stored control-plane credential", async () => {
  for (const provider of ["tensorpool", "modal", "vast"]) {
    const res = await ComputeSettingsRoutes().request(`/provider/${provider}`, { method: "DELETE" })
    expect(res.status).toBe(200)
  }
  expect(process.env["TENSORPOOL_KEY"]).toBeUndefined()
  expect(process.env["TENSORPOOL_API_KEY"]).toBeUndefined()
  expect(process.env["MODAL_TOKEN_ID"]).toBeUndefined()
  expect(process.env["MODAL_TOKEN_SECRET"]).toBeUndefined()
  // The shell export was never owned by the store, so removal leaves it alone.
  expect(process.env["VAST_API_KEY"]).toBe("from-shell")
})

test("re-saving a key updates the value resolved by the control plane", async () => {
  await connect("runpod", "rpa_first")
  await ComputeSettings.setProviderEnabled("runpod", true)
  expect(await ComputeSettings.providerEnv("runpod")).toEqual({ RUNPOD_API_KEY: "rpa_first" })
  expect(process.env["RUNPOD_API_KEY"]).toBe("rpa_first")
  await connect("runpod", "rpa_second")
  expect(await ComputeSettings.providerEnv("runpod")).toEqual({ RUNPOD_API_KEY: "rpa_second" })
  expect(process.env["RUNPOD_API_KEY"]).toBe("rpa_second")
  await ComputeSettingsRoutes().request("/provider/runpod", { method: "DELETE" })
  expect(process.env["RUNPOD_API_KEY"]).toBeUndefined()
  await expect(ComputeSettings.providerEnv("runpod")).rejects.toThrow("disabled")
})

test("does not reclaim a provider variable replaced by the shell", async () => {
  await connect("prime", "prime_stored_first")
  await ComputeSettings.setProviderEnabled("prime", true)
  expect(process.env["PRIME_API_KEY"]).toBe("prime_stored_first")
  process.env["PRIME_API_KEY"] = "prime_from_shell"

  await connect("prime", "prime_stored_second")
  expect(process.env["PRIME_API_KEY"]).toBe("prime_from_shell")
  await ComputeSettings.disconnectProvider("prime")
  expect(process.env["PRIME_API_KEY"]).toBe("prime_from_shell")
  delete process.env["PRIME_API_KEY"]
})

test("preserves a provider variable replaced while a project instance is active", async () => {
  await using tmp = await tmpdir()
  delete process.env["VAST_API_KEY"]
  await ComputeSettings.disconnectProvider("vast")
  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      await connect("vast", "vast_owned_first")
      await ComputeSettings.setProviderEnabled("vast", true)
      expect(process.env["VAST_API_KEY"]).toBe("vast_owned_first")
      process.env["VAST_API_KEY"] = "vast_from_shell"

      await connect("vast", "vast_owned_second")
      expect(process.env["VAST_API_KEY"]).toBe("vast_from_shell")
      await ComputeSettings.disconnectProvider("vast")
      expect(process.env["VAST_API_KEY"]).toBe("vast_from_shell")
      await Instance.dispose()
    },
  })
  delete process.env["VAST_API_KEY"]
})

test("compute job routes execute a real local command and expose its log", async () => {
  await using tmp = await tmpdir()
  const current = await session(tmp.path)
  const query = `?directory=${encodeURIComponent(tmp.path)}`
  const started = await ComputeSettingsRoutes().request(`/jobs${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionID: current.id,
      name: "route smoke test",
      command: "printf 'compute-route-ok\\n'",
      target: { kind: "local" },
    }),
  })
  expect(started.status).toBe(200)
  const first = (await started.json()) as { id: string }
  const final = await (async () => {
    for (const _ of Array.from({ length: 100 })) {
      const response = await ComputeSettingsRoutes().request(`/jobs${query}`)
      const jobs = (await response.json()) as { id: string; status: string }[]
      const job = jobs.find((item) => item.id === first.id)
      if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return job
      await Bun.sleep(20)
    }
    throw new Error("Timed out waiting for route compute job")
  })()
  expect(final.status).toBe("succeeded")

  const output = await ComputeSettingsRoutes().request(`/jobs/${first.id}/log${query}`)
  expect(output.status).toBe(200)
  expect(await output.json()).toEqual({ log: "compute-route-ok\n" })

  const events = await ComputeSettingsRoutes().request(`/jobs/${first.id}/events${query}`)
  expect(events.status).toBe(200)
  expect(await events.json()).toEqual({ events: "" })

  const cleared = await ComputeSettingsRoutes().request(`/jobs/completed${query}`, { method: "DELETE" })
  expect(cleared.status).toBe(200)
})

test("compute job routes fail closed while remote lifecycle support is incomplete", async () => {
  await using tmp = await tmpdir()
  const current = await session(tmp.path)
  const response = await ComputeSettingsRoutes().request(`/jobs?directory=${encodeURIComponent(tmp.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionID: current.id,
      name: "missing host",
      command: "true",
      target: { kind: "ssh", host_id: "does-not-exist" },
    }),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: "remote_compute_unavailable" })
})

test("compute job routes require a valid project directory", async () => {
  const missing = await ComputeSettingsRoutes().request("/jobs")
  expect(missing.status).toBe(400)

  const invalid = await ComputeSettingsRoutes().request(
    `/jobs?directory=${encodeURIComponent("/path/that/does/not/exist")}`,
  )
  expect(invalid.status).toBe(400)
})

test("compute job routes isolate list, log, cancel, and clear by project", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const current = await session(first.path)
  const one = `?directory=${encodeURIComponent(first.path)}`
  const two = `?directory=${encodeURIComponent(second.path)}`
  const started = await ComputeSettingsRoutes().request(`/jobs${one}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionID: current.id,
      name: "project isolation",
      command: "sleep 30",
      target: { kind: "local" },
    }),
  })
  expect(started.status).toBe(200)
  const job = (await started.json()) as { id: string }

  expect(await (await ComputeSettingsRoutes().request(`/jobs${two}`)).json()).toEqual([])
  expect((await ComputeSettingsRoutes().request(`/jobs/${job.id}/log${two}`)).status).toBe(404)
  expect((await ComputeSettingsRoutes().request(`/jobs/${job.id}/cancel${two}`, { method: "POST" })).status).toBe(404)
  expect(await (await ComputeSettingsRoutes().request(`/jobs/completed${two}`, { method: "DELETE" })).json()).toEqual({
    cleared: 0,
  })

  expect((await ComputeSettingsRoutes().request(`/jobs/${job.id}/cancel${one}`, { method: "POST" })).status).toBe(200)
  expect((await ComputeSettingsRoutes().request(`/jobs/completed${one}`, { method: "DELETE" })).status).toBe(200)
})

test("mounted compute routes use an opaque project selector for every job operation", async () => {
  await using tmp = await tmpdir()
  const created = await Project.fromDirectory(tmp.path)
  const current = await session(tmp.path)
  const headers = {
    "content-type": "application/json",
    "x-openscience-project": created.project.id,
  }
  const started = await fetch(jobs, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionID: current.id,
      name: "project capability",
      command: "printf 'project-capability-ok\\n'",
      target: { kind: "local" },
    }),
  })

  expect(started.status).toBe(200)
  const first = (await started.json()) as {
    id: string
    cwd: string
    scope: { directory: string }
  }
  expect(first.cwd).toBe(tmp.path)
  expect(first.scope.directory).toBe(tmp.path)
  expect((await settle(jobs, first.id, headers)).status).toBe("succeeded")

  const output = await fetch(`${jobs}/${first.id}/log`, { headers })
  expect(output.status).toBe(200)
  expect(await output.json()).toEqual({ log: "project-capability-ok\n" })

  const cleared = await fetch(`${jobs}/completed`, { method: "DELETE", headers })
  expect(cleared.status).toBe(200)
  expect(await cleared.json()).toEqual({ cleared: 1 })
})

test("mounted compute routes reject unknown, stale, and mismatched project selectors", async () => {
  await using current = await tmpdir()
  await using other = await tmpdir()
  await using stale = await tmpdir()
  const valid = await Project.fromDirectory(current.path)
  const missing = await Project.fromDirectory(stale.path)
  const unknown = `prj_unknown_${crypto.randomUUID()}`
  await fs.rm(stale.path, { recursive: true, force: true })

  const [unknownResponse, staleResponse, mismatchResponse] = await Promise.all([
    fetch(jobs, {
      headers: {
        "x-openscience-project": unknown,
      },
    }),
    fetch(jobs, {
      headers: {
        "x-openscience-project": missing.project.id,
      },
    }),
    fetch(`${jobs}?directory=${encodeURIComponent(other.path)}`, {
      headers: {
        "x-openscience-project": valid.project.id,
      },
    }),
  ])

  expect(unknownResponse.status).toBe(404)
  expect(await unknownResponse.json()).toEqual({
    name: "ProjectUnknownError",
    data: {
      projectID: unknown,
    },
  })
  expect(staleResponse.status).toBe(410)
  expect(await staleResponse.json()).toEqual({
    name: "ProjectStaleError",
    data: {
      projectID: missing.project.id,
      reason: "missing_directory",
      directory: stale.path,
    },
  })
  expect(mismatchResponse.status).toBe(409)
  expect(await mismatchResponse.json()).toEqual({
    name: "ProjectMismatchError",
    data: {
      projectID: valid.project.id,
      directory: other.path,
    },
  })
})

test("mounted compute routes never resolve another project's job id", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const one = await Project.fromDirectory(first.path)
  const two = await Project.fromDirectory(second.path)
  const current = await session(first.path)
  const firstHeaders = {
    "content-type": "application/json",
    "x-openscience-project": one.project.id,
  }
  const secondHeaders = {
    "content-type": "application/json",
    "x-openscience-project": two.project.id,
  }
  const started = await fetch(jobs, {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({
      sessionID: current.id,
      name: "cross-project isolation",
      command: "printf 'cross-project-ok\\n'",
      target: { kind: "local" },
    }),
  })
  expect(started.status).toBe(200)
  const job = (await started.json()) as { id: string }
  expect((await settle(jobs, job.id, firstHeaders)).status).toBe("succeeded")

  const [listed, output, cancelled, cleared] = await Promise.all([
    fetch(jobs, { headers: secondHeaders }),
    fetch(`${jobs}/${job.id}/log`, { headers: secondHeaders }),
    fetch(`${jobs}/${job.id}/cancel`, { method: "POST", headers: secondHeaders }),
    fetch(`${jobs}/completed`, { method: "DELETE", headers: secondHeaders }),
  ])
  expect(await listed.json()).toEqual([])
  expect(output.status).toBe(404)
  expect(cancelled.status).toBe(404)
  expect(await cleared.json()).toEqual({ cleared: 0 })

  expect(await (await fetch(`${jobs}/completed`, { method: "DELETE", headers: firstHeaders })).json()).toEqual({
    cleared: 1,
  })
})

test("legacy directory requests and project selectors share one canonical symlink scope", async () => {
  await using tmp = await tmpdir()
  const created = await Project.fromDirectory(tmp.path)
  const current = await session(tmp.path)
  const link = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-compute-alias`)
  await fs.symlink(tmp.path, link)
  const legacy = `${jobs}?directory=${encodeURIComponent(link)}`
  const started = await fetch(legacy, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionID: current.id,
      name: "legacy symlink",
      command: "printf 'legacy-symlink-ok\\n'",
      target: { kind: "local" },
    }),
  })

  expect(started.status).toBe(200)
  const job = (await started.json()) as {
    id: string
    cwd: string
    scope: { directory: string }
  }
  expect(job.cwd).toBe(tmp.path)
  expect(job.scope.directory).toBe(tmp.path)

  const headers = {
    "x-openscience-project": created.project.id,
  }
  expect((await settle(jobs, job.id, headers)).status).toBe("succeeded")
  const output = await fetch(`${jobs}/${job.id}/log?directory=${encodeURIComponent(tmp.path)}`)
  expect(output.status).toBe(200)
  expect(await output.json()).toEqual({ log: "legacy-symlink-ok\n" })
  expect(await (await fetch(`${jobs}/completed`, { method: "DELETE", headers })).json()).toEqual({ cleared: 1 })

  await fs.rm(link, { force: true })
})

test("read-only projects cannot start compute jobs or create side effects", async () => {
  await using tmp = await tmpdir()
  const created = await Project.fromDirectory(tmp.path)
  const current = await session(tmp.path, false)
  const marker = path.join(tmp.path, "compute-started")
  const headers = {
    "content-type": "application/json",
    "x-openscience-project": created.project.id,
  }
  const response = await fetch(jobs, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionID: current.id,
      name: "read-only escape",
      command: `printf started > ${JSON.stringify(marker)}`,
      target: { kind: "local" },
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({
    name: "ExecutionAuthorityDeniedError",
    data: {
      allowed: false,
      reason: "project_untrusted",
      capability: "local_job",
      projectID: created.project.id,
      sessionID: current.id,
    },
  })
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(await (await fetch(jobs, { headers })).json()).toEqual([])
})

test("revoking project trust cancels its running compute jobs", async () => {
  if (!Sandbox.available()) return
  await using tmp = await tmpdir()
  const created = await Project.fromDirectory(tmp.path)
  const current = await session(tmp.path)
  const headers = {
    "content-type": "application/json",
    "x-openscience-project": created.project.id,
  }
  const started = await fetch(jobs, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionID: current.id,
      name: "trust-bound job",
      command: "sleep 30",
      target: { kind: "local" },
    }),
  })
  expect(started.status).toBe(200)
  const job = (await started.json()) as { id: string }

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
    },
  })

  expect((await settle(jobs, job.id, headers)).status).toBe("cancelled")
})
