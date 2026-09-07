#!/usr/bin/env bun

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { DarwinResponsibility } from "../src/process/darwin-responsibility"
import {
  DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX,
  DARWIN_RESPONSIBILITY_LAUNCHER_ARG,
} from "../src/process/darwin-responsibility-launcher"

// The parent needs only Bun's libproc bindings. The subject must be the real
// installed binary: source launchers bypass the compiled bootstrap graph.
const binary = process.argv[2]
if (!binary || process.platform !== "darwin") {
  throw new Error("usage (macOS): smoke-darwin-launcher.ts <native-binary> [evidence-directory]")
}
const executable = await fs.realpath(binary)
const evidence = process.argv[3]
  ? path.resolve(process.argv[3])
  : await fs.mkdtemp(path.join(os.tmpdir(), "openscience-darwin-launcher-evidence-"))
await fs.mkdir(evidence, { recursive: true })
// After responsibility disclaim, a developer's Documents directory can be
// protected by macOS privacy controls. Evidence placement must not change the
// worker's cwd or HOME; CI already installs the native package in runner temp.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-darwin-launcher-"))
const retainedRoot = path.join(evidence, path.basename(root))
const application = path.join(root, "application")
const directories = Object.fromEntries(
  ["home", "data", "cache", "config", "share", "state"].map((name) => [name, path.join(application, name)]),
)
await Promise.all(
  Object.entries(directories)
    .filter(([name]) => name !== "config")
    .map(([, directory]) => fs.mkdir(directory, { recursive: true })),
)
// A worker launcher does not need application configuration. A regular file
// at the configured directory catches accidental imports of Global/DataRoot.
await Bun.write(directories.config, "Internal launchers must not initialize application configuration.\n")
const release = path.join(root, "release")
const ready = path.join(root, "stage-one-ready")
const latch = path.join(root, "stage-two-ready")
const payload = path.join(root, "payload-started")
const started = Date.now()
const stages: Array<{ name: string; elapsedMs: number }> = []
const record = (name: string) => stages.push({ name, elapsedMs: Date.now() - started })

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    result[entry.name] = entry.isDirectory()
      ? "directory"
      : entry.isSymbolicLink()
        ? `symlink:${await fs.readlink(file)}`
        : new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
    if (!entry.isDirectory()) continue
    for (const [name, value] of Object.entries(await snapshot(file))) result[`${entry.name}/${name}`] = value
  }
  return result
}

const before = await snapshot(application)
await Bun.write(path.join(evidence, "application-before.json"), JSON.stringify(before, null, 2) + "\n")
const owner = DarwinResponsibility.identity(process.pid)
assert.ok(owner, "could not capture the smoke runner's macOS process identity")
const child = spawn(
  executable,
  [
    DARWIN_RESPONSIBILITY_LAUNCHER_ARG,
    release,
    ready,
    "0",
    "0",
    String(process.pid),
    owner,
    "/bin/sh",
    "-c",
    'printf started > "$1"; exec /bin/cat',
    "--",
    payload,
  ],
  {
    cwd: root,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    // Never inherit developer/CI provider credentials or application state.
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: directories.home,
      TMPDIR: root,
      OPENSCIENCE_TEST_HOME: directories.home,
      OPENSCIENCE_DATA_DIR: directories.data,
      OPENSCIENCE_CONFIG_DIR: directories.config,
      XDG_DATA_HOME: directories.share,
      XDG_CACHE_HOME: directories.cache,
      XDG_CONFIG_HOME: directories.config,
      XDG_STATE_HOME: directories.state,
      OPENSCIENCE_DISABLE_MODELS_FETCH: "true",
      OPENSCIENCE_DISABLE_PROJECT_CONFIG: "true",
      OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENSCIENCE_DISABLE_SHARE: "true",
      OPENSCIENCE_DARWIN_SUPERVISOR_TEST_READY: latch,
    },
  },
)
let stdout = Buffer.alloc(0)
let stderr = Buffer.alloc(0)
let failure: unknown
let identity: string | undefined
let responsibility: string | undefined
let closed = false
const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
  child.once("error", reject)
  child.once("close", (code, signal) => {
    closed = true
    resolve({ code, signal })
  })
})
void completion.catch(() => undefined)
child.stdout.on("data", (chunk: Buffer) => {
  stdout = Buffer.concat([stdout, chunk]).subarray(0, 65_536)
})
child.stderr.on("data", (chunk: Buffer) => {
  stderr = Buffer.concat([stderr, chunk]).subarray(0, 65_536)
})
child.stdin.on("error", (error) => {
  failure ??= error
})

async function wait(name: string, condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await condition())) {
    if (closed) throw new Error(`${name}: launcher exited early (${JSON.stringify(await completion)})`)
    if (failure) throw failure
    if (Date.now() >= deadline) throw new Error(`${name}: timed out after 10000ms`)
    await Bun.sleep(25)
  }
  record(name)
}

try {
  assert.ok(child.pid, "native launcher did not receive a PID")
  identity = DarwinResponsibility.identity(child.pid)
  assert.ok(identity, "could not capture the native launcher's identity")
  // An empty pipe must not block either bootstrap. Input is deliberately sent
  // only after both ownership gates, just as the control-plane bridge does.
  await wait(
    "stage one ready with stdin open",
    async () =>
      (await Bun.file(ready)
        .text()
        .catch(() => "")) === String(child.pid),
  )
  assert.equal(await Bun.file(payload).exists(), false, "payload ran before stage-one release")
  await fs.writeFile(release, String(child.pid), { flag: "wx", mode: 0o600 })
  await wait("independent responsibility root", () => DarwinResponsibility.responsible(child.pid!) === child.pid)
  responsibility = DarwinResponsibility.unique(child.pid)
  assert.ok(responsibility, "native launcher has no unique responsibility identity")
  await wait(
    "stage two ready with stdin open",
    async () =>
      (await Bun.file(latch)
        .text()
        .catch(() => "")) === String(child.pid),
  )
  assert.equal(await Bun.file(payload).exists(), false, "payload ran before durable activation")
  await fs.writeFile(`${release}${DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX}`, String(child.pid), {
    flag: "wx",
    mode: 0o600,
  })
  const input = Buffer.from(JSON.stringify({ nonce: crypto.randomUUID(), text: "scientific stdin\nαβ" }) + "\n")
  child.stdin.end(input)
  await wait("payload exited", () => closed)
  const outcome = await completion
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr.toString())
  assert.equal(await Bun.file(payload).text(), "started")
  assert.deepEqual(stdout, input, "native supervisor changed or consumed the payload's stdin")
  assert.deepEqual(await snapshot(application), before, "internal launcher initialized application state")
  record("verified exact stdin round trip without application initialization")
} catch (error) {
  failure = error
} finally {
  // Authenticate every cleanup target. The release smoke must never signal
  // another local process merely because a recorded PID was reused.
  try {
    if (responsibility) {
      for (const pid of DarwinResponsibility.uniqueMembers(responsibility)) {
        if (pid === child.pid || !DarwinResponsibility.uniquelyOwns(responsibility, pid)) continue
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
  } catch (error) {
    failure ??= error
  }
  if (!closed && child.pid && identity && DarwinResponsibility.identity(child.pid) === identity) child.kill("SIGKILL")
  await Promise.race([completion.catch(() => undefined), Bun.sleep(2_000)])
  await fs.cp(root, retainedRoot, { recursive: true, preserveTimestamps: true }).catch((error) => {
    failure ??= error
  })
  await Promise.all([
    Bun.write(path.join(evidence, "stdout.log"), stdout),
    Bun.write(path.join(evidence, "stderr.log"), stderr),
    Bun.write(
      path.join(evidence, "application-after.json"),
      JSON.stringify(await snapshot(application), null, 2) + "\n",
    ),
    Bun.write(
      path.join(evidence, "result.json"),
      JSON.stringify(
        {
          executable,
          root,
          retainedRoot,
          pid: child.pid,
          identity,
          responsibility,
          stages,
          status: failure ? "failed" : "passed",
          error: failure instanceof Error ? failure.message : failure,
        },
        null,
        2,
      ) + "\n",
    ),
  ])
  if (!failure) await fs.rm(root, { recursive: true, force: true })
}
console.log(`Darwin launcher evidence: ${evidence}`)
if (failure) throw failure
console.log("Verified compiled Darwin launcher activation, stdin round trip, and application-state isolation")
