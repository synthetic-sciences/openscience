import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProcessIdentity } from "../../src/process/process-identity"

const routes = new URL("../../src/server/routes/settings/storage.ts", import.meta.url).href
const globalModule = new URL("../../src/global/index.ts", import.meta.url).href
const artifactModule = new URL("../../src/artifact/store.ts", import.meta.url).href
const leaseModule = new URL("../../src/util/file-lease.ts", import.meta.url).href
const logModule = new URL("../../src/util/log.ts", import.meta.url).href
const computeModule = new URL("../../src/compute/jobs.ts", import.meta.url).href
const instanceModule = new URL("../../src/project/instance.ts", import.meta.url).href
const trustModule = new URL("../../src/project/trust.ts", import.meta.url).href
const sessionModule = new URL("../../src/session/index.ts", import.meta.url).href
const configModule = new URL("../../src/config/config.ts", import.meta.url).href
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-storage-"))
  roots.push(value)
  return value
}

function isolatedEnv(root: string) {
  return {
    ...process.env,
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }
}

async function script(root: string, source: string, args: string[] = []) {
  const filepath = path.join(root, `storage-${crypto.randomUUID()}.ts`)
  await fs.writeFile(filepath, source)
  const proc = Bun.spawn([process.execPath, filepath, ...args], {
    cwd: root,
    env: isolatedEnv(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (exit !== 0) throw new Error(stderr || stdout || `storage helper exited ${exit}`)
  return stdout.trim()
}

async function waitFor(filepath: string) {
  const deadline = Date.now() + 10_000
  while (!(await fs.lstat(filepath).catch(() => undefined))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filepath}`)
    await Bun.sleep(20)
  }
}

async function processParent(pid: number): Promise<number> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
  return Number(
    stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[1],
  )
}

describe("Storage Settings integration", () => {
  test("returns promptly while scanning and counts hard-linked allocated bytes once", async () => {
    const workspace = await root()
    const source = [
      `import { StorageRoutes } from ${JSON.stringify(routes)}`,
      `import { Global } from ${JSON.stringify(globalModule)}`,
      'import fs from "node:fs/promises"',
      'import path from "node:path"',
      'const payload = path.join(Global.Path.data, "payload")',
      "await fs.mkdir(payload, { recursive: true })",
      'const original = path.join(payload, "original.bin")',
      "await fs.writeFile(original, Buffer.alloc(8192, 1))",
      'await fs.link(original, path.join(payload, "linked.bin"))',
      'const sparse = path.join(payload, "sparse.bin")',
      'await fs.writeFile(sparse, "")',
      "await fs.truncate(sparse, 256 * 1024 * 1024)",
      "const started = Date.now()",
      'let response = await StorageRoutes().request("/")',
      'if (Date.now() - started > 1000) throw new Error("initial usage request blocked on the full scan")',
      "let body = await response.json()",
      'for (let attempt = 0; body.scanning && attempt < 200; attempt++) { await Bun.sleep(10); response = await StorageRoutes().request("/"); body = await response.json() }',
      'if (body.scanning) throw new Error("usage scan did not settle")',
      'const entry = body.entries.find((item) => item.name === "payload")',
      'if (!entry) throw new Error("payload entry missing")',
      "const stat = await fs.stat(original)",
      "const sparseStat = await fs.stat(sparse)",
      "const expected = stat.blocks * 512 + sparseStat.blocks * 512",
      "if (entry.bytes !== expected) throw new Error(`hard link counted more than once: ${entry.bytes} !== ${expected}`)",
      'if (sparseStat.blocks === 0 && entry.bytes >= sparseStat.size) throw new Error("sparse logical bytes were reported as allocated disk usage")',
      'if (!body.updated_at || body.scan_error !== null) throw new Error("usage result did not expose truthful scan state")',
    ].join("\n")
    await script(workspace, source)
  })

  test("reports scan failures instead of presenting unreadable storage as empty", async () => {
    if (process.platform === "win32") return
    const workspace = await root()
    const source = [
      `import { StorageRoutes } from ${JSON.stringify(routes)}`,
      `import { Global } from ${JSON.stringify(globalModule)}`,
      'import fs from "node:fs/promises"',
      'import path from "node:path"',
      'const blocked = path.join(Global.Path.data, "blocked")',
      "await fs.mkdir(blocked, { recursive: true })",
      'await fs.writeFile(path.join(blocked, "payload.bin"), "payload")',
      "await fs.chmod(blocked, 0)",
      "try {",
      '  let body = await (await StorageRoutes().request("/")).json()',
      "  const deadline = Date.now() + 10_000",
      '  while (body.scanning && Date.now() < deadline) { await Bun.sleep(20); body = await (await StorageRoutes().request("/")).json() }',
      '  if (body.scanning) throw new Error("usage scan did not settle")',
      '  if (!body.scan_error) throw new Error("unreadable storage was silently reported as a successful scan")',
      "} finally { await fs.chmod(blocked, 0o700) }",
    ].join("\n")
    await script(workspace, source)
  })

  test("rejects relative and nested destinations", async () => {
    const workspace = await root()
    const source = [
      `import { StorageRoutes } from ${JSON.stringify(routes)}`,
      `import { Global } from ${JSON.stringify(globalModule)}`,
      'const relative = await StorageRoutes().request("/location", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "relative" }) })',
      "if (relative.status !== 400) throw new Error(`expected relative 400, got ${relative.status}`)",
      'const nested = await StorageRoutes().request("/location", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `${await Global.Path.dataTarget}/nested` }) })',
      "if (nested.status !== 409) throw new Error(`expected nested 409, got ${nested.status}: ${await nested.text()}`)",
    ].join("\n")
    await script(workspace, source)
  })

  test("preserves workspace lockfiles and SQLite journals while dropping app transients", async () => {
    const workspace = await root()
    const target = path.join(workspace, "relocated")
    const source = [
      `import { StorageRoutes } from ${JSON.stringify(routes)}`,
      `import { Global } from ${JSON.stringify(globalModule)}`,
      'import fs from "node:fs/promises"',
      'import path from "node:path"',
      "const target = process.argv.at(-1)",
      'const session = path.join(Global.Path.data, "workspaces", "prj_filter", "ses_filter")',
      'const storage = path.join(Global.Path.data, "storage", "filter")',
      'const artifactStore = path.join(Global.Path.data, "artifact-store")',
      'await Promise.all([fs.mkdir(session, { recursive: true }), fs.mkdir(storage, { recursive: true }), fs.mkdir(path.join(artifactStore, "partial"), { recursive: true })])',
      'await Promise.all([fs.writeFile(path.join(session, "bun.lock"), "bun"), fs.writeFile(path.join(session, "uv.lock"), "uv"), fs.writeFile(path.join(session, "analysis.db-wal"), "wal"), fs.writeFile(path.join(session, "analysis.db-shm"), "shm"), fs.writeFile(path.join(session, "report.partial"), "partial"), fs.writeFile(path.join(storage, "record.json.lock"), "stale lock"), fs.writeFile(path.join(storage, "record.json.123.tmp"), "stale temp"), fs.writeFile(path.join(artifactStore, "artifacts.db-wal"), "stale wal"), fs.writeFile(path.join(artifactStore, "artifacts.db-shm"), "stale shm"), fs.writeFile(path.join(artifactStore, "partial", "upload.partial"), "in flight")])',
      'const response = await StorageRoutes().request("/location", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target }) })',
      "if (response.status !== 200) throw new Error(`relocation failed ${response.status}: ${await response.text()}`)",
    ].join("\n")
    await script(workspace, source, [target])

    const session = path.join(target, "workspaces", "prj_filter", "ses_filter")
    expect(await fs.readFile(path.join(session, "bun.lock"), "utf8")).toBe("bun")
    expect(await fs.readFile(path.join(session, "uv.lock"), "utf8")).toBe("uv")
    expect(await fs.readFile(path.join(session, "analysis.db-wal"), "utf8")).toBe("wal")
    expect(await fs.readFile(path.join(session, "analysis.db-shm"), "utf8")).toBe("shm")
    expect(await fs.readFile(path.join(session, "report.partial"), "utf8")).toBe("partial")
    expect(await Bun.file(path.join(target, "storage", "filter", "record.json.lock")).exists()).toBe(false)
    expect(await Bun.file(path.join(target, "storage", "filter", "record.json.123.tmp")).exists()).toBe(false)
    expect(await Bun.file(path.join(target, "artifact-store", "artifacts.db-wal")).exists()).toBe(false)
    expect(await Bun.file(path.join(target, "artifact-store", "artifacts.db-shm")).exists()).toBe(false)
    expect(await Bun.file(path.join(target, "artifact-store", "partial", "upload.partial")).exists()).toBe(false)
  })

  test("drains a sibling writer, snapshots WAL data, and switches its precomputed paths without restart", async () => {
    const workspace = await root()
    const target = path.join(workspace, "relocated")
    const ready = path.join(workspace, "ready")
    const release = path.join(workspace, "release")
    const holderSource = [
      `import { Global } from ${JSON.stringify(globalModule)}`,
      `import { FileLease } from ${JSON.stringify(leaseModule)}`,
      'import fs from "node:fs/promises"',
      'import path from "node:path"',
      "const ready = process.argv.at(-2)",
      "const release = process.argv.at(-1)",
      'const record = path.join(Global.Path.data, "storage", "sibling-after.json")',
      "await fs.mkdir(path.dirname(record), { recursive: true })",
      'await using lease = await FileLease.acquire(path.join(Global.Path.data, "storage", "held.lock"), 60_000)',
      'await fs.writeFile(ready, "ready")',
      "while (!(await Bun.file(release).exists())) await Bun.sleep(10)",
      'await fs.writeFile(record, JSON.stringify({ side: "target" }))',
    ].join("\n")
    const holderFile = path.join(workspace, "holder.ts")
    await fs.writeFile(holderFile, holderSource)
    const holder = Bun.spawn([process.execPath, holderFile, ready, release], {
      cwd: workspace,
      env: isolatedEnv(workspace),
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitFor(ready)

    const moverSource = [
      `import { StorageRoutes } from ${JSON.stringify(routes)}`,
      `import { Global } from ${JSON.stringify(globalModule)}`,
      `import { ArtifactStore } from ${JSON.stringify(artifactModule)}`,
      `import { Log } from ${JSON.stringify(logModule)}`,
      'import fs from "node:fs/promises"',
      'import path from "node:path"',
      "const target = process.argv.at(-1)",
      "await Log.init({ print: false, dev: true })",
      'Log.Default.info("before storage switch")',
      "await Log.flush()",
      'await fs.mkdir(path.join(Global.Path.data, "storage"), { recursive: true })',
      'await fs.writeFile(path.join(Global.Path.data, "storage", "before.json"), JSON.stringify({ source: true }))',
      'const artifact = await ArtifactStore.save({ projectID: "prj_storage", sessionID: "ses_storage", sourcePath: "/result.txt", filename: "result.txt", kind: "document", content: new Blob(["immutable result"], { type: "text/plain" }) })',
      'const response = await StorageRoutes().request("/location", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target }) })',
      "if (response.status !== 200) throw new Error(`relocation failed ${response.status}: ${await response.text()}`)",
      'Log.Default.info("after storage switch")',
      "await Log.flush()",
      "console.log(JSON.stringify({ body: await response.json(), artifact: artifact.id }))",
    ].join("\n")
    const moverFile = path.join(workspace, "mover.ts")
    await fs.writeFile(moverFile, moverSource)
    const mover = Bun.spawn([process.execPath, moverFile, target], {
      cwd: workspace,
      env: isolatedEnv(workspace),
      stdout: "pipe",
      stderr: "pipe",
    })
    await Bun.sleep(100)
    expect(mover.exitCode).toBeNull()
    await fs.writeFile(release, "release")
    const [holderExit, moverExit, holderError, moverOut, moverError] = await Promise.all([
      holder.exited,
      mover.exited,
      new Response(holder.stderr).text(),
      new Response(mover.stdout).text(),
      new Response(mover.stderr).text(),
    ])
    expect(holderExit, holderError).toBe(0)
    expect(moverExit, moverError).toBe(0)
    const moved = JSON.parse(moverOut.trim()) as { body: { target: string; files: number }; artifact: string }
    expect(moved.body.target).toBe(await fs.realpath(target))
    expect(moved.body.files).toBeGreaterThan(0)
    expect(await Bun.file(path.join(target, "storage", "before.json")).json()).toEqual({ source: true })
    expect(await Bun.file(path.join(target, "storage", "sibling-after.json")).json()).toEqual({ side: "target" })
    expect(await Bun.file(path.join(target, "log", "dev.log")).text()).toContain("before storage switch")
    expect(await Bun.file(path.join(target, "log", "dev.log")).text()).toContain("after storage switch")

    const verifySource = [
      `import { ArtifactStore } from ${JSON.stringify(artifactModule)}`,
      `import { Global } from ${JSON.stringify(globalModule)}`,
      'const item = await ArtifactStore.read("prj_storage", process.argv.at(-1))',
      'if (!item || await item.content.text() !== "immutable result") throw new Error("artifact snapshot failed")',
      "if (await Global.Path.dataTarget !== process.argv.at(-2)) throw new Error(`wrong active root: ${await Global.Path.dataTarget}`)",
    ].join("\n")
    await script(workspace, verifySource, [await fs.realpath(target), moved.artifact])
  })

  test("serializes queued relocations from the newly active root", async () => {
    const workspace = await root()
    const first = path.join(workspace, "first-target")
    const second = path.join(workspace, "second-target")
    const ready = path.join(workspace, "holder-ready")
    const release = path.join(workspace, "holder-release")
    const initial = path.join(workspace, "home", ".openscience")
    await fs.mkdir(path.join(initial, "000-target-era"), { recursive: true })
    await fs.mkdir(path.join(initial, "zzz-copy-delay"), { recursive: true })
    const payload = Buffer.alloc(1024 * 1024, 7)
    await Promise.all(
      Array.from({ length: 48 }, (_, index) =>
        fs.writeFile(path.join(initial, "zzz-copy-delay", `${String(index).padStart(3, "0")}.bin`), payload),
      ),
    )

    const holderFile = path.join(workspace, "relocation-holder.ts")
    await fs.writeFile(
      holderFile,
      [
        `import { Global } from ${JSON.stringify(globalModule)}`,
        `import { FileLease } from ${JSON.stringify(leaseModule)}`,
        'import fs from "node:fs/promises"',
        'import path from "node:path"',
        "const ready = process.argv.at(-2)",
        "const release = process.argv.at(-1)",
        'await using lease = await FileLease.acquire(path.join(Global.Path.data, "queued-relocation.lock"), 60_000)',
        'await fs.writeFile(ready, "ready")',
        "while (!(await Bun.file(release).exists())) await Bun.sleep(5)",
      ].join("\n"),
    )
    const holder = Bun.spawn([process.execPath, holderFile, ready, release], {
      cwd: workspace,
      env: isolatedEnv(workspace),
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitFor(ready)

    const moverFile = path.join(workspace, "queued-relocation.ts")
    await fs.writeFile(
      moverFile,
      [
        `import { StorageRoutes } from ${JSON.stringify(routes)}`,
        `import { Global } from ${JSON.stringify(globalModule)}`,
        'import fs from "node:fs/promises"',
        'import path from "node:path"',
        "const target = process.argv.at(-2)",
        'const publish = process.argv.at(-1) === "publish"',
        'const response = await StorageRoutes().request("/location", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target }) })',
        "if (response.status !== 200) throw new Error(await response.text())",
        'if (publish) await fs.writeFile(path.join(Global.Path.data, "000-target-era", "after-first.txt"), "preserved")',
        "console.log(JSON.stringify(await response.json()))",
      ].join("\n"),
    )
    const spawnMover = (target: string, mode: string) =>
      Bun.spawn([process.execPath, moverFile, target, mode], {
        cwd: workspace,
        env: isolatedEnv(workspace),
        stdout: "pipe",
        stderr: "pipe",
      })
    const firstMove = spawnMover(first, "publish")
    await waitFor(path.join(workspace, "config", "openscience", "data-root-switch.intent"))
    const secondMove = spawnMover(second, "plain")
    await fs.writeFile(release, "release")
    const [holderCode, firstCode, secondCode, holderError, firstError, secondError] = await Promise.all([
      holder.exited,
      firstMove.exited,
      secondMove.exited,
      new Response(holder.stderr).text(),
      new Response(firstMove.stderr).text(),
      new Response(secondMove.stderr).text(),
    ])
    expect(holderCode, holderError).toBe(0)
    expect(firstCode, firstError).toBe(0)
    expect(secondCode, secondError).toBe(0)
    expect(await fs.readFile(path.join(second, "000-target-era", "after-first.txt"), "utf8")).toBe("preserved")
  }, 30_000)

  test.skipIf(process.platform !== "linux")(
    "reclaims a compute marker after owner-death supervision reaps the child",
    async () => {
      const workspace = await root()
      const project = path.join(workspace, "workspace")
      const target = path.join(workspace, "relocated")
      const ownerReady = path.join(project, "owner-ready.json")
      const childReady = path.join(project, "child-ready")
      const release = path.join(project, "release")
      await fs.mkdir(project)

      const ownerFile = path.join(workspace, "compute-owner.ts")
      await fs.writeFile(
        ownerFile,
        [
          `import { ComputeJobs } from ${JSON.stringify(computeModule)}`,
          `import { Instance } from ${JSON.stringify(instanceModule)}`,
          `import { ProjectTrust } from ${JSON.stringify(trustModule)}`,
          `import { Session } from ${JSON.stringify(sessionModule)}`,
          `import { Config } from ${JSON.stringify(configModule)}`,
          `import { Global } from ${JSON.stringify(globalModule)}`,
          'import fs from "node:fs/promises"',
          'import path from "node:path"',
          "const [project, ownerReady, childReady, release] = process.argv.slice(-4)",
          "const quote = (value) => `'${value.replaceAll(\"'\", \"'\\\"'\\\"'\")}'`",
          "await Config.setSandbox({ enabled: false })",
          "await Instance.provide({",
          "  directory: project,",
          "  fn: async () => {",
          "    const status = await ProjectTrust.status(Instance.project)",
          "    if (!status.canExecuteProjectCode) await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })",
          "    const session = await Session.create({})",
          "    const python = Bun.which('python3')",
          "    if (!python) throw new Error('Python is required for the compute subreaper fixture')",
          "    const daemon = path.join(project, 'compute-daemon.py')",
          "    await fs.writeFile(daemon, [",
          "      'import os, sys, time',",
          "      'os.setsid()',",
          "      'if os.fork(): os._exit(0)',",
          "      `open(${JSON.stringify(childReady)}, 'w').write(str(os.getpid()))`,",
          "      `while not os.path.exists(${JSON.stringify(release)}): time.sleep(0.02)`,",
          "      `print('surviving-child', flush=True)`,",
          "      'time.sleep(600)',",
          "    ].join('\\n'))",
          "    const command = `${quote(python)} ${quote(daemon)}; while :; do sleep 0.02; done`",
          "    const root = path.join(Global.Path.data, 'compute-runtime')",
          "    const job = await ComputeJobs.start({ name: 'survivor', command, target: { kind: 'local' }, sessionID: session.id }, { root, workspace: project })",
          "    const stored = await ComputeJobs.get(job.id, { root, workspace: project })",
          "    if (!stored?.pid || !stored.process_identity) throw new Error('compute identity was not persisted')",
          "    await fs.writeFile(ownerReady, JSON.stringify({ id: job.id, pid: stored.pid, identity: stored.process_identity }))",
          "    await new Promise(() => undefined)",
          "  },",
          "})",
        ].join("\n"),
      )

      const env = isolatedEnv(workspace)
      const owner = Bun.spawn([process.execPath, ownerFile, project, ownerReady, childReady, release], {
        cwd: workspace,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const ownerError = new Response(owner.stderr).text()
      let childOwner: { pid: number; identity: string } | undefined
      let escaped: { pid: number; identity: string } | undefined
      try {
        await Promise.race([
          waitFor(ownerReady),
          owner.exited.then(async (code) => {
            throw new Error(`Compute owner exited ${code} before registration: ${await ownerError}`)
          }),
        ])
        await waitFor(childReady)
        const running = (await Bun.file(ownerReady).json()) as { id: string; pid: number; identity: string }
        childOwner = running
        const daemonPID = Number((await fs.readFile(childReady, "utf8")).trim())
        const daemonIdentity = await ProcessIdentity.capture(daemonPID)
        if (!daemonIdentity) throw new Error("compute daemon identity was not captured")
        escaped = { pid: daemonPID, identity: daemonIdentity }
        const operations = path.join(workspace, "config", "openscience", "data-root-operations")
        const records = await Promise.all(
          (await fs.readdir(operations)).map((name) => Bun.file(path.join(operations, name)).json()),
        )
        expect(records).toContainEqual(expect.objectContaining({ pid: running.pid, identity: running.identity }))
        expect(await ProcessIdentity.owns(running.pid, running.identity)).toBe(true)
        expect(await ProcessIdentity.owns(escaped.pid, escaped.identity)).toBe(true)
        expect(await processParent(escaped.pid)).toBe(running.pid)

        process.kill(owner.pid, "SIGKILL")
        await owner.exited
        for (let attempt = 0; attempt < 300 && (await ProcessIdentity.owns(running.pid, running.identity)); attempt++) {
          await Bun.sleep(10)
        }
        expect(await ProcessIdentity.owns(running.pid, running.identity)).toBe(false)
        expect(await ProcessIdentity.owns(escaped.pid, escaped.identity)).toBe(false)

        const moverFile = path.join(workspace, "compute-mover.ts")
        await fs.writeFile(
          moverFile,
          [
            `import { StorageRoutes } from ${JSON.stringify(routes)}`,
            "const target = process.argv.at(-1)",
            'const response = await StorageRoutes().request("/location", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target }) })',
            "if (response.status !== 200) throw new Error(await response.text())",
            "console.log(await response.text())",
          ].join("\n"),
        )
        const mover = Bun.spawn([process.execPath, moverFile, target], {
          cwd: workspace,
          env,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [moverExit, moverOut, moverError] = await Promise.all([
          mover.exited,
          new Response(mover.stdout).text(),
          new Response(mover.stderr).text(),
        ])
        expect(moverExit, moverError).toBe(0)
        expect(JSON.parse(moverOut)).toMatchObject({ target: await fs.realpath(target) })
        const remaining = await Promise.all(
          (await fs.readdir(operations)).map((name) => Bun.file(path.join(operations, name)).json()),
        )
        expect(remaining).not.toContainEqual(expect.objectContaining({ pid: running.pid, identity: running.identity }))
        const log = await fs.readFile(path.join(target, "compute-runtime", "jobs", `${running.id}.log`), "utf8")
        expect(log).not.toContain("surviving-child")
      } finally {
        if (owner.exitCode === null) {
          try {
            process.kill(owner.pid, "SIGKILL")
          } catch {}
        }
        if (childOwner && (await ProcessIdentity.owns(childOwner.pid, childOwner.identity))) {
          try {
            process.kill(-childOwner.pid, "SIGKILL")
          } catch {}
        }
        if (escaped && (await ProcessIdentity.owns(escaped.pid, escaped.identity))) {
          try {
            process.kill(escaped.pid, "SIGKILL")
          } catch {}
        }
      }
    },
    30_000,
  )

  test("reset reverse-migrates target-era writes and preserves both safety copies", async () => {
    const workspace = await root()
    const target = path.join(workspace, "custom")
    const flow = [
      `import { StorageRoutes } from ${JSON.stringify(routes)}`,
      `import { Global } from ${JSON.stringify(globalModule)}`,
      'import fs from "node:fs/promises"',
      'import path from "node:path"',
      "const target = process.argv.at(-1)",
      'await fs.writeFile(path.join(Global.Path.data, "default-only.txt"), "old default")',
      'let response = await StorageRoutes().request("/location", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target }) })',
      "if (response.status !== 200) throw new Error(await response.text())",
      'await fs.writeFile(path.join(Global.Path.data, "target-era.txt"), "kept")',
      'response = await StorageRoutes().request("/location", { method: "DELETE" })',
      "if (response.status !== 200) throw new Error(await response.text())",
      "const body = await response.json()",
      'if (!body.backup) throw new Error("reset did not preserve the prior default")',
      'if (await Bun.file(path.join(Global.Path.data, "target-era.txt")).text() !== "kept") throw new Error("target-era write was lost")',
      'if (await Bun.file(path.join(target, "target-era.txt")).text() !== "kept") throw new Error("custom safety copy was removed")',
      'if (await Bun.file(path.join(body.backup, "default-only.txt")).text() !== "old default") throw new Error("default safety copy was removed")',
      'if (await Bun.file(path.join(Global.Path.config, "data-location")).exists()) throw new Error("pointer survived reset")',
      "console.log(JSON.stringify(body))",
    ].join("\n")
    const body = JSON.parse(await script(workspace, flow, [target])) as { target: string; backup: string }
    expect(body.target).toBe(await fs.realpath(path.join(workspace, "home", ".openscience")))
    expect(body.backup).toContain(".pre-reset-")
  })
})
