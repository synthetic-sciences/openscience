import { test, expect, afterAll, spyOn } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Project } from "../../src/project/project"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { ProjectTrust } from "../../src/project/trust"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Server } from "../../src/server/server"
import { ComputeSettings, ComputeSettingsRoutes } from "../../src/server/routes/settings/compute"
import { Sandbox } from "../../src/sandbox/sandbox"
import { Log } from "../../src/util/log"
import { Global } from "../../src/global"
import { ModalVolume } from "../../src/compute/modal/volume"
import { executionSession, sandboxedExecution, tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const fetch = Server.internalFetch()
const jobs = "http://openscience.internal/settings/compute/jobs"
// These cases exercise real OS-owned process trees. On macOS the durable
// responsibility handoff and verified descendant reap routinely exceed Bun's
// 5s unit-test default even though the payload itself exits immediately.
const nativeLifecycleTimeout = 30_000

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

async function waitForRemoval(target: string) {
  for (const _ of Array.from({ length: 100 })) {
    if (!(await fs.stat(target).catch(() => undefined))) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${target} to be removed`)
}

async function session(directory: string, trusted = true) {
  return Instance.provide({
    directory,
    init: InstanceBootstrap,
    fn: async () => {
      if (trusted) return executionSession()
      await ProjectTrust.update(Instance.project, { trusted: false })
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

test("SSH host notes persist, remain editable, and clear without changing connection identity", async () => {
  const created = await ComputeSettingsRoutes().request("/ssh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "Notes test cluster",
      host: "notes-test.example.org",
      scheduler: "slurm",
      workdir: "/scratch/research",
      notes: "Load cuda/12.4. Use the gpu partition.",
      concurrency: 2,
    }),
  })
  expect(created.status).toBe(200)
  const host = ((await created.json()) as ComputeSettings.Info).ssh_hosts.find(
    (item) => item.host === "notes-test.example.org",
  )
  expect(host?.notes).toBe("Load cuda/12.4. Use the gpu partition.")
  if (!host) throw new Error("SSH notes test host was not created")

  try {
    const updated = await ComputeSettingsRoutes().request(`/ssh/${host.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "  Scratch: /scratch/research. Install packages in the project venv.  " }),
    })
    expect(updated.status).toBe(200)
    const saved = ((await updated.json()) as ComputeSettings.Info).ssh_hosts.find((item) => item.id === host.id)
    expect(saved).toMatchObject({
      host: host.host,
      scheduler: host.scheduler,
      workdir: host.workdir,
      notes: "Scratch: /scratch/research. Install packages in the project venv.",
    })

    const cleared = await ComputeSettingsRoutes().request(`/ssh/${host.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "" }),
    })
    expect(cleared.status).toBe(200)
    expect(
      ((await cleared.json()) as ComputeSettings.Info).ssh_hosts.find((item) => item.id === host.id)?.notes,
    ).toBeUndefined()
  } finally {
    await ComputeSettingsRoutes().request(`/ssh/${host.id}`, { method: "DELETE" })
  }
})

test("SSH config discovery reads literal hosts without executing or expanding config directives", async () => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "config")
  await Bun.write(
    config,
    [
      "Host lab login",
      '  HostName "login.cluster.example" # display target',
      "  User researcher",
      "  Port 2222",
      "  ProxyJump bastion",
      "Host *.internal !blocked.internal",
      "  User wildcard-user",
      "Match host lab",
      "  User should-not-override",
      "Include ~/.ssh/conf.d/*",
      "Host tokenized",
      "  HostName %h.example.org",
      "  Port invalid",
    ].join("\n"),
  )

  expect(await ComputeSettings.sshConfigHosts(config)).toEqual([
    { alias: "lab", hostname: "login.cluster.example", user: "researcher", port: 2222 },
    { alias: "login", hostname: "login.cluster.example", user: "researcher", port: 2222 },
    { alias: "tokenized" },
  ])
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
      'environment = "research-lab"',
    ].join("\n"),
  )

  expect(await ComputeSettings.modalFile(file)).toEqual({
    found: true,
    ready: true,
    status: "ready",
    profile: "openscience",
    environment: "research-lab",
  })
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
  expect(await ComputeSettings.modalConfig()).toMatchObject({ environment: "research-lab" })

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

test("Modal config discovery validates and selects the default profile", async () => {
  await using tmp = await tmpdir()
  const missing = path.join(tmp.path, ".modal.toml")
  expect(await ComputeSettings.modalFile(missing)).toMatchObject({
    found: false,
    ready: false,
    status: "absent",
  })

  await Bun.write(missing, '[default]\ntoken_id = "ak-id"\ntoken_secret = "as-secret"\n')
  expect(await ComputeSettings.modalFile(missing)).toEqual({
    found: true,
    ready: true,
    status: "ready",
    profile: "default",
  })
  const configured = await ComputeSettings.configureModal(missing)
  expect(configured.providers.find((item) => item.id === "modal")).toMatchObject({
    connected: true,
    enabled: true,
    source: "modal_toml",
  })
  expect(await ComputeSettings.providerEnv("modal")).toEqual({
    MODAL_TOKEN_ID: "ak-id",
    MODAL_TOKEN_SECRET: "as-secret",
  })
  await ComputeSettings.disconnectProvider("modal")
})

test("Modal config discovery rejects ambiguous or incomplete profiles before enabling", async () => {
  await using tmp = await tmpdir()
  const ambiguous = path.join(tmp.path, "ambiguous.toml")
  const incomplete = path.join(tmp.path, "incomplete.toml")
  await Promise.all([
    Bun.write(
      ambiguous,
      '[first]\ntoken_id = "ak-one"\ntoken_secret = "as-one"\n[second]\ntoken_id = "ak-two"\ntoken_secret = "as-two"\n',
    ),
    Bun.write(incomplete, '[default]\ntoken_id = "ak-only"\n'),
  ])

  expect(await ComputeSettings.modalFile(ambiguous)).toMatchObject({
    found: true,
    ready: false,
    status: "invalid",
    error: "Modal config does not identify one active profile.",
  })
  expect(await ComputeSettings.modalFile(incomplete)).toMatchObject({
    found: true,
    ready: false,
    status: "invalid",
    profile: "default",
  })
  await expect(ComputeSettings.configureModal(ambiguous)).rejects.toThrow("one active profile")
  await expect(ComputeSettings.configureModal(incomplete)).rejects.toThrow("missing token_id or token_secret")
})

test("Modal Volume browser downloads stream past the retired cap and clean up on cancel or abort", async () => {
  const size = 256 * 1024 * 1024 + 1
  const staging: string[] = []
  const context = spyOn(ComputeSettings, "modalContext").mockResolvedValue({
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none",
    timeoutMinutes: 10,
    concurrency: 1,
    tokenId: "ak-test",
    tokenSecret: "as-test",
  })
  const list = spyOn(ModalVolume, "list").mockResolvedValue([{ path: "large.bin", type: "file", size }])
  const download = spyOn(ModalVolume, "download").mockImplementation(async (_context, _volume, _paths, target) => {
    staging.push(target)
    const file = path.join(target, "large.bin")
    const handle = await fs.open(file, "w")
    await handle.truncate(size)
    await handle.close()
    return [{ path: "large.bin", staging: file, size, sha256: "0".repeat(64) }]
  })
  try {
    const cancelled = await ComputeSettingsRoutes().request("/modal/volumes/weights/file?path=/large.bin")
    expect(cancelled.status).toBe(200)
    expect(download.mock.calls[0]?.[4]?.declaredBytes).toBe(size)
    expect(cancelled.headers.get("content-length")).toBe(String(size))
    expect(cancelled.headers.get("content-disposition")).toContain('filename="large.bin"')
    const cancelledReader = cancelled.body!.getReader()
    const first = await cancelledReader.read()
    expect(first.done).toBe(false)
    expect(first.value?.byteLength).toBeGreaterThan(0)
    await cancelledReader.cancel()
    await waitForRemoval(staging[0]!)

    const controller = new AbortController()
    const aborted = await ComputeSettingsRoutes().request("/modal/volumes/weights/file?path=/large.bin", {
      signal: controller.signal,
    })
    const abortedReader = aborted.body!.getReader()
    expect((await abortedReader.read()).done).toBe(false)
    controller.abort()
    await waitForRemoval(staging[1]!)
    await abortedReader.cancel().catch(() => undefined)
  } finally {
    download.mockRestore()
    list.mockRestore()
    context.mockRestore()
    await Promise.all(staging.map((target) => fs.rm(target, { recursive: true, force: true })))
  }
})

test("Modal Volume browser downloads abort blocked staging and await helper teardown before cleanup", async () => {
  let staging: string | undefined
  let stopped = false
  const started = Promise.withResolvers<void>()
  const revoking = Promise.withResolvers<void>()
  const teardown = Promise.withResolvers<void>()
  const context = spyOn(ComputeSettings, "modalContext").mockResolvedValue({
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none",
    timeoutMinutes: 10,
    concurrency: 1,
    tokenId: "ak-test",
    tokenSecret: "as-test",
  })
  const list = spyOn(ModalVolume, "list").mockResolvedValue([{ path: "blocked.bin", type: "file", size: 1 }])
  const download = spyOn(ModalVolume, "download").mockImplementation(
    async (_context, _volume, _paths, target, options) => {
      const signal = options?.signal
      if (!signal) throw new Error("The Modal Volume route did not forward its request signal")
      expect(options.declaredBytes).toBe(1)
      staging = target
      await fs.writeFile(path.join(target, "partial"), "staged")
      const interrupted = Promise.withResolvers<never>()
      const abort = () => {
        revoking.resolve()
        void teardown.promise.then(() => {
          stopped = true
          interrupted.reject(signal.reason)
        })
      }
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
      started.resolve()
      try {
        return await interrupted.promise
      } finally {
        signal.removeEventListener("abort", abort)
      }
    },
  )
  const errors = spyOn(console, "error").mockImplementation(() => {})
  const controller = new AbortController()
  const reason = new DOMException("browser disconnected", "AbortError")

  try {
    const pending = ComputeSettingsRoutes().request("/modal/volumes/weights/file?path=/blocked.bin", {
      signal: controller.signal,
    })
    await started.promise
    controller.abort(reason)
    await revoking.promise
    expect(stopped).toBe(false)
    expect(await fs.stat(staging!).then((value) => value.isDirectory())).toBe(true)
    teardown.resolve()
    const response = await pending
    expect(response.status).toBe(500)
    expect(stopped).toBe(true)
    await waitForRemoval(staging!)
  } finally {
    teardown.resolve()
    controller.abort(reason)
    errors.mockRestore()
    download.mockRestore()
    list.mockRestore()
    context.mockRestore()
    if (staging) await fs.rm(staging, { recursive: true, force: true })
  }
})

test("Modal Volume browser downloads sanitize hostile filenames and remove staging after completion", async () => {
  let staging: string | undefined
  const payload = Buffer.from("streamed bytes")
  const remote = 'report"\r\nX-Injected: yes.csv'
  const context = spyOn(ComputeSettings, "modalContext").mockResolvedValue({
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none",
    timeoutMinutes: 10,
    concurrency: 1,
    tokenId: "ak-test",
    tokenSecret: "as-test",
  })
  const list = spyOn(ModalVolume, "list").mockResolvedValue([{ path: remote, type: "file", size: payload.byteLength }])
  const download = spyOn(ModalVolume, "download").mockImplementation(async (_context, _volume, _paths, target) => {
    staging = target
    const file = path.join(target, "result.bin")
    await fs.writeFile(file, payload)
    return [{ path: remote, staging: file, size: payload.byteLength, sha256: "0".repeat(64) }]
  })

  try {
    const response = await ComputeSettingsRoutes().request(
      `/modal/volumes/weights/file?path=${encodeURIComponent(`/${remote}`)}`,
    )
    expect(response.status).toBe(200)
    const disposition = response.headers.get("content-disposition")!
    expect(disposition).toContain('filename="report___X-Injected: yes.csv"')
    expect(disposition).toContain("filename*=UTF-8''report%22__X-Injected%3A%20yes.csv")
    expect(disposition).not.toContain("\r")
    expect(disposition).not.toContain("\n")
    expect(response.headers.get("x-injected")).toBeNull()
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload)
    await waitForRemoval(staging!)
  } finally {
    download.mockRestore()
    list.mockRestore()
    context.mockRestore()
    if (staging) await fs.rm(staging, { recursive: true, force: true })
  }
})

test("Modal Volume browser downloads remove staging when response handoff fails", async () => {
  let staging: string | undefined
  const payload = Buffer.from("staged")
  const context = spyOn(ComputeSettings, "modalContext").mockResolvedValue({
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none",
    timeoutMinutes: 10,
    concurrency: 1,
    tokenId: "ak-test",
    tokenSecret: "as-test",
  })
  const list = spyOn(ModalVolume, "list").mockResolvedValue([
    { path: "result.bin", type: "file", size: payload.byteLength },
  ])
  const download = spyOn(ModalVolume, "download").mockImplementation(async (_context, _volume, _paths, target) => {
    staging = target
    const file = path.join(target, "result.bin")
    await fs.writeFile(file, payload)
    return [{ path: "result.bin", staging: file, size: payload.byteLength, sha256: "0".repeat(64) }]
  })
  const set = Headers.prototype.set
  const headers = spyOn(Headers.prototype, "set").mockImplementation(function (this: Headers, name, value) {
    if (name.toLowerCase() === "content-disposition" && value.startsWith("attachment;")) {
      throw new TypeError("injected Content-Disposition failure")
    }
    return set.call(this, name, value)
  })
  const errors = spyOn(console, "error").mockImplementation(() => {})

  try {
    const response = await ComputeSettingsRoutes().request("/modal/volumes/weights/file?path=/result.bin")
    expect(response.status).toBe(500)
    await waitForRemoval(staging!)
  } finally {
    errors.mockRestore()
    headers.mockRestore()
    download.mockRestore()
    list.mockRestore()
    context.mockRestore()
    if (staging) await fs.rm(staging, { recursive: true, force: true })
  }
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

test(
  "compute job routes execute a real local command and expose its log",
  async () => {
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
  },
  nativeLifecycleTimeout,
)

test("compute job routes reject an unknown SSH profile before dispatch", async () => {
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
  expect(response.status).toBe(400)
  expect(await response.text()).toContain("The selected SSH compute profile was not found")
})

test("compute job routes require a valid project directory", async () => {
  const missing = await ComputeSettingsRoutes().request("/jobs")
  expect(missing.status).toBe(400)

  const invalid = await ComputeSettingsRoutes().request(
    `/jobs?directory=${encodeURIComponent("/path/that/does/not/exist")}`,
  )
  expect(invalid.status).toBe(400)
})

test(
  "compute job routes isolate list, log, cancel, and clear by project",
  async () => {
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
    expect(await (await ComputeSettingsRoutes().request(`/jobs/completed${two}`, { method: "DELETE" })).json()).toEqual(
      {
        cleared: 0,
      },
    )

    expect((await ComputeSettingsRoutes().request(`/jobs/${job.id}/cancel${one}`, { method: "POST" })).status).toBe(200)
    expect((await ComputeSettingsRoutes().request(`/jobs/completed${one}`, { method: "DELETE" })).status).toBe(200)
  },
  nativeLifecycleTimeout,
)

test(
  "mounted compute routes use an opaque project selector for every job operation",
  async () => {
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
    const workspace = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionFilesystem.workspace(current.id),
    })
    expect(first.cwd).toBe(workspace)
    expect(first.scope.directory).toBe(workspace)
    expect((await settle(jobs, first.id, headers)).status).toBe("succeeded")

    const output = await fetch(`${jobs}/${first.id}/log`, { headers })
    expect(output.status).toBe(200)
    expect(await output.json()).toEqual({ log: "project-capability-ok\n" })

    const cleared = await fetch(`${jobs}/completed`, { method: "DELETE", headers })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ cleared: 1 })
  },
  nativeLifecycleTimeout,
)

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

test(
  "mounted compute routes never resolve another project's job id",
  async () => {
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
  },
  nativeLifecycleTimeout,
)

test(
  "legacy directory requests and project selectors share one canonical symlink scope",
  async () => {
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
    const workspace = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionFilesystem.workspace(current.id),
    })
    expect(job.cwd).toBe(workspace)
    expect(job.scope.directory).toBe(workspace)

    const headers = {
      "x-openscience-project": created.project.id,
    }
    expect((await settle(jobs, job.id, headers)).status).toBe("succeeded")
    const output = await fetch(`${jobs}/${job.id}/log?directory=${encodeURIComponent(tmp.path)}`)
    expect(output.status).toBe(200)
    expect(await output.json()).toEqual({ log: "legacy-symlink-ok\n" })
    expect(await (await fetch(`${jobs}/completed`, { method: "DELETE", headers })).json()).toEqual({ cleared: 1 })

    await fs.rm(link, { force: true })
  },
  nativeLifecycleTimeout,
)

test("untrusted projects start local compute only when the OS sandbox is enforced", async () => {
  await using _sandbox = await sandboxedExecution()
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

  if (!Sandbox.available()) {
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      name: "ExecutionAuthorityDeniedError",
      data: {
        allowed: false,
        reason: "sandbox_unavailable",
        capability: "local_job",
        projectID: created.project.id,
        sessionID: current.id,
      },
    })
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await (await fetch(jobs, { headers })).json()).toEqual([])
    return
  }

  expect(response.status).toBe(200)
  const job = (await response.json()) as {
    id: string
    sandbox: { enforced: boolean }
    authority: { allowed: boolean; mode: string }
  }
  expect(job).toMatchObject({
    sandbox: { enforced: true },
    authority: { allowed: true, mode: "sandboxed" },
  })
  expect((await settle(jobs, job.id, headers)).status).toBe("succeeded")
  expect(await Bun.file(marker).text()).toBe("started")
})

test(
  "revoking project trust cancels its running compute jobs",
  async () => {
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
  },
  nativeLifecycleTimeout,
)
