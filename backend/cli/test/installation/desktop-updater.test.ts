import { afterEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertTransactionClean,
  canonical,
  packagedUpdateCache,
  settleTransaction,
  stopSuccessfulApp,
  updaterSettlementTimeout,
} from "../../../../frontend/desktop/script/update-lifecycle-canary.mjs"
import {
  apply,
  asset,
  checksum,
  destination,
  launch,
  newer,
  portable,
  release,
  reconcileTransactions,
  stage,
  stageCurrent,
  trustedTransaction,
} from "../../../../frontend/desktop/src/updater.mjs"
import { DarwinUpdateSwap } from "../../src/process/darwin-update-swap"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("desktop update release contract", () => {
  test("canonicalizes the synthetic install root before the handle-safe swap", async () => {
    const root = await canonical(process.arch)
    roots.push(root)
    expect(root).toBe(await realpath(root))
  })

  test("uses the packaged Electron user-data cache for lifecycle health receipts", () => {
    expect(packagedUpdateCache("/Users/release-runner")).toBe(
      "/Users/release-runner/Library/Application Support/@synsci/desktop/updates",
    )
    expect(() => packagedUpdateCache("/Users/release-runner", { name: "../escape" })).toThrow(
      "The packaged desktop user-data path is invalid",
    )
  })

  test("requires the authenticated runtime pair to remain usable until exact canary shutdown", async () => {
    const desktop = { pid: 101, started: "desktop-start", command: "/Applications/OpenScience" }
    const service = { pid: 202, started: "service-start", command: "/Applications/OpenScience serve" }
    const health = { process_identity: desktop, service_identity: service }
    const signaled: number[] = []
    const waited: number[] = []
    let observing = 0
    let concurrentObservations = 0

    await stopSuccessfulApp(health, {
      observe: async (identity: typeof desktop) => {
        observing++
        concurrentObservations = Math.max(concurrentObservations, observing)
        await Promise.resolve()
        observing--
        return identity
      },
      signal: (identity: typeof desktop) => signaled.push(identity.pid),
      waitForExit: async (identity: typeof desktop) => {
        waited.push(identity.pid)
        return true
      },
    })
    expect(signaled).toEqual([desktop.pid])
    expect(waited).toEqual([desktop.pid, service.pid])
    expect(concurrentObservations).toBe(2)

    signaled.length = 0
    await expect(
      stopSuccessfulApp(health, {
        observe: async () => undefined,
        signal: (identity: typeof desktop) => signaled.push(identity.pid),
        waitForExit: async () => true,
      }),
    ).rejects.toThrow("main exited; sidecar exited")
    expect(signaled).toEqual([])

    await expect(
      stopSuccessfulApp(health, {
        observe: async (identity: typeof desktop) => (identity.pid === desktop.pid ? undefined : identity),
        signal: (identity: typeof desktop) => signaled.push(identity.pid),
        waitForExit: async () => true,
      }),
    ).rejects.toThrow("main exited")
    expect(signaled).toEqual([service.pid])

    await expect(
      stopSuccessfulApp(health, {
        observe: async (identity: typeof desktop) => (identity.pid === desktop.pid ? undefined : identity),
        signal: () => {
          throw Object.assign(new Error("already exited"), { code: "ESRCH" })
        },
        waitForExit: async () => true,
      }),
    ).rejects.toThrow("main exited")

    await expect(
      stopSuccessfulApp(health, {
        observe: async (identity: typeof desktop) => (identity.pid === desktop.pid ? undefined : identity),
        signal: () => {
          throw Object.assign(new Error("signal denied"), { code: "EPERM" })
        },
        waitForExit: async () => true,
      }),
    ).rejects.toThrow("signal denied")

    signaled.length = 0
    await expect(
      stopSuccessfulApp(health, {
        observe: async (identity: typeof desktop) =>
          identity.pid === desktop.pid ? { ...identity, command: "/unrelated/reused-pid" } : identity,
        signal: (identity: typeof desktop) => signaled.push(identity.pid),
        waitForExit: async () => true,
      }),
    ).rejects.toThrow("main identity changed")
    expect(signaled).toEqual([service.pid])

    await expect(
      stopSuccessfulApp(health, {
        observe: async () => {
          throw new Error("ps unavailable")
        },
        signal: () => {
          throw new Error("must not signal without exact identity evidence")
        },
      }),
    ).rejects.toThrow("ps unavailable")
  })

  test("waits for renamed purge and health-write residue before declaring updater cleanup settled", async () => {
    expect(updaterSettlementTimeout).toBe(10 * 60_000)
    const root = await mkdtemp(path.join(os.tmpdir(), "openscience-update-residue-"))
    roots.push(root)
    const cache = path.join(root, "cache")
    const applications = path.join(root, "Applications")
    await Promise.all([mkdir(cache), mkdir(applications)])
    const token = "a".repeat(48)
    const info = {
      incoming: path.join(applications, "missing-incoming"),
      root: path.join(cache, `pending-${token}`),
      health: path.join(cache, `health-${token}.json`),
      runtime: path.join(cache, `runtime-${token}.json`),
      handoff: path.join(cache, `handoff-${token}.json`),
      ready: path.join(cache, `helper-${token}.json`),
      journal: path.join(cache, `transaction-${token}.json`),
    }
    const tomb = path.join(applications, ".openscience-purge-test")
    const healthTemporary = `${info.health}.tmp-123`
    await Promise.all([
      mkdir(tomb),
      Bun.write(healthTemporary, "partial"),
      Bun.write(path.join(cache, "last-result.json"), "{}\n"),
      Bun.write(path.join(cache, "update.log"), "settled\n"),
    ])
    await expect(assertTransactionClean(info, 1)).rejects.toThrow("applications:")

    let settled = false
    const waiting = assertTransactionClean(info, 1_000).then(() => {
      settled = true
    })
    await Bun.sleep(10)
    expect(settled).toBe(false)
    await Promise.all([rm(tomb, { recursive: true }), rm(healthTemporary)])
    await waiting

    await Bun.write(path.join(cache, "stuck-entry"), "stuck")
    await expect(assertTransactionClean(info, 1)).rejects.toThrow("cache:")
  })

  test("accepts only the reread final result after exact helper and cache settlement", async () => {
    const helper = { pid: 303, started: "helper-start", command: "/Applications/OpenScience helper" }
    const root = await mkdtemp(path.join(os.tmpdir(), "openscience-update-final-result-"))
    roots.push(root)
    const cache = path.join(root, "cache")
    const applications = path.join(root, "Applications")
    await Promise.all([mkdir(cache), mkdir(applications)])
    const token = "f".repeat(48)
    const info = {
      helper_identity: helper,
      result: path.join(cache, "last-result.json"),
      incoming: path.join(applications, "missing-incoming"),
      root: path.join(cache, `pending-${token}`),
      health: path.join(cache, `health-${token}.json`),
      runtime: path.join(cache, `runtime-${token}.json`),
      handoff: path.join(cache, `handoff-${token}.json`),
      ready: path.join(cache, `helper-${token}.json`),
      journal: path.join(cache, `transaction-${token}.json`),
    }
    const events: string[] = []
    let reads = 0
    const final = { status: "succeeded", version: "3.2.1", recovered: true }

    expect(
      await settleTransaction(
        info,
        { status: "succeeded", version: "3.2.1" },
        {
          timeout: 1,
          waitForExit: async (identity: typeof helper) => {
            events.push("helper-exit")
            expect(identity).toEqual(helper)
            return true
          },
          assertClean: async (value: typeof info) => {
            events.push("cache-clean")
            expect(value).toBe(info)
          },
          readResult: async (file: string) => {
            events.push("final-result")
            reads++
            expect(file).toBe(info.result)
            return final
          },
        },
      ),
    ).toEqual(final)
    expect(reads).toBe(2)
    expect(events).toEqual(["helper-exit", "final-result", "cache-clean", "final-result"])

    const tomb = path.join(applications, ".openscience-purge-exact-cleanup")
    await Promise.all([
      mkdir(tomb),
      Bun.write(path.join(cache, "update.log"), `must-not-appear\n${"x".repeat(9 * 1024)}\nexact purge timed out\n`),
    ])
    let cleanAfterHelperFailure = false
    const helperFailure = settleTransaction(
      info,
      { status: "succeeded", version: "3.2.1" },
      {
        waitForExit: async () => true,
        assertClean: async () => {
          cleanAfterHelperFailure = true
        },
        readResult: async () => ({ ...final, cleanup_error: "purge failed" }),
      },
    )
    const diagnostic = await helperFailure.then(
      () => undefined,
      (error) => error as Error,
    )
    expect(diagnostic).toBeInstanceOf(Error)
    expect(diagnostic?.message).toContain("purge failed")
    expect(diagnostic?.message).toContain(".openscience-purge-exact-cleanup")
    expect(diagnostic?.message).toContain("exact purge timed out")
    expect(diagnostic?.message).not.toContain("must-not-appear")
    expect(cleanAfterHelperFailure).toBe(false)
    await rm(tomb, { recursive: true })
    let lateReads = 0
    await expect(
      settleTransaction(
        info,
        { status: "succeeded", version: "3.2.1" },
        {
          waitForExit: async () => true,
          assertClean: async () => undefined,
          readResult: async () => (++lateReads === 1 ? final : { ...final, cleanup_error: "late purge failure" }),
        },
      ),
    ).rejects.toThrow("late purge failure")
    await expect(
      settleTransaction(
        info,
        { status: "succeeded", version: "3.2.1" },
        {
          waitForExit: async () => true,
          assertClean: async () => undefined,
          readResult: async () => ({ ...final, status: "failed" }),
        },
      ),
    ).rejects.toThrow("final state did not match")
    await expect(
      settleTransaction({ ...info, helper_identity: undefined }, { status: "succeeded", version: "3.2.1" }),
    ).rejects.toThrow("omitted its exact helper identity")
  })

  test("accepts only a strictly newer stable version", () => {
    expect(newer("2.0.53", "2.0.54")).toBe(true)
    expect(newer("2.0.54", "2.0.54")).toBe(false)
    expect(newer("2.1.0", "2.0.99")).toBe(false)
    expect(newer("local", "2.0.54")).toBe(false)
  })

  test("selects the exact architecture payload and requires GitHub's digest", async () => {
    const name = asset("arm64")
    const server = Bun.serve({
      port: 0,
      routes: {
        "/releases/tags/v3.2.1": Response.json({
          tag_name: "v3.2.1",
          draft: false,
          prerelease: false,
          assets: [
            {
              name,
              digest: `sha256:${"a".repeat(64)}`,
              size: 1_024,
              browser_download_url:
                "https://github.com/synthetic-sciences/openscience/releases/download/v3.2.1/update.zip",
            },
          ],
        }),
      },
    })

    expect(await release("3.2.1", { api: server.url, arch: "arm64" })).toEqual({
      version: "3.2.1",
      name,
      url: "https://github.com/synthetic-sciences/openscience/releases/download/v3.2.1/update.zip",
      digest: "a".repeat(64),
      size: 1_024,
    })
    server.stop(true)
  })

  test("recognizes both mounted disk images and App Translocation as portable installs", () => {
    expect(portable("/Volumes/OpenScience/OpenScience.app")).toBe(true)
    expect(portable("/private/var/folders/x/AppTranslocation/ABC/d/OpenScience.app")).toBe(true)
    expect(portable("/Applications/OpenScience.app")).toBe(false)
  })

  test("never lets a writable recovery journal weaken the installed publisher requirement", () => {
    const required = { team: "SYNTHETIC", designated: "identifier ai.syntheticsciences.openscience" }
    expect(trustedTransaction({ trusted: false, trust: required }, required)).toBe(false)
    expect(trustedTransaction({ trusted: true, trust: { ...required, team: "ATTACKER" } }, required)).toBe(false)
    expect(trustedTransaction({ trusted: true, trust: required }, required)).toBe(true)
  })
})

describe.skipIf(process.platform !== "darwin")("macOS desktop update integration", () => {
  const buildBundle = async (root: string, name: string, version: string, healthMarker?: string) => {
    const bundle = path.join(root, name, "OpenScience.app")
    const contents = path.join(bundle, "Contents")
    const binary = path.join(contents, "MacOS", "openscience")
    await mkdir(path.dirname(binary), { recursive: true })
    await Bun.write(
      path.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>openscience</string>
<key>CFBundleIdentifier</key><string>ai.syntheticsciences.openscience</string>
<key>CFBundleName</key><string>OpenScience</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>`,
    )
    await Bun.write(
      binary,
      healthMarker
        ? `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs"
const input = process.argv.find((value) => value.startsWith("--openscience-update-health="))
if (!input) process.exit(2)
const request = JSON.parse(Buffer.from(input.slice("--openscience-update-health=".length), "base64url").toString("utf8"))
writeFileSync(${JSON.stringify(healthMarker)}, JSON.stringify({ electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? "unset" }))
const temporary = request.receipt + ".app-" + process.pid
writeFileSync(temporary, JSON.stringify({ healthy: true, pid: process.pid, token: request.token, version: request.version }))
renameSync(temporary, request.receipt)
`
        : "#!/bin/sh\nexit 0\n",
    )
    await chmod(binary, 0o755)
    expect((await Bun.$`codesign --force --deep --sign - ${bundle}`.quiet()).exitCode).toBe(0)
    return bundle
  }

  const buildSwapper = async (root: string) => {
    const executable = path.join(root, "test-update-swap")
    const module = new URL("../../src/process/darwin-update-swap.ts", import.meta.url).href
    await Bun.write(
      executable,
      `#!${process.execPath}
import { DarwinUpdateSwap } from ${JSON.stringify(module)}
process.exit(await DarwinUpdateSwap.run(process.argv.at(-1) ?? ""))
`,
    )
    await chmod(executable, 0o700)
    return executable
  }

  const buildCrashingBundle = async (root: string, name: string, version: string) => {
    const bundle = await buildBundle(root, name, version)
    const executable = path.join(bundle, "Contents", "MacOS", "openscience")
    const sidecar = path.join(bundle, "Contents", "Resources", "sidecar", "openscience")
    await mkdir(path.dirname(sidecar), { recursive: true })
    await Bun.write(sidecar, Bun.file("/bin/sleep"))
    await chmod(sidecar, 0o755)
    await Bun.write(
      executable,
      `#!${process.execPath}
import { execFileSync, spawn } from "node:child_process"
import { renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
const input = process.argv.find((value) => value.startsWith("--openscience-update-health="))
if (!input) process.exit(2)
const request = JSON.parse(Buffer.from(input.slice("--openscience-update-health=".length), "base64url").toString("utf8"))
const sidecar = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../Resources/sidecar/openscience")
const service = spawn(sidecar, ["2"], { detached: true, stdio: "ignore" })
await new Promise((resolve, reject) => { service.once("spawn", resolve); service.once("error", reject) })
service.unref()
const started = execFileSync("/bin/ps", ["-p", String(service.pid), "-o", "lstart="], { encoding: "utf8" }).trim()
const command = execFileSync("/bin/ps", ["-ww", "-p", String(service.pid), "-o", "command="], { encoding: "utf8" }).trim()
const temporary = request.runtime + ".app-" + process.pid
writeFileSync(temporary, JSON.stringify({ schema: 1, token: request.token, version: request.version, parent: process.pid, service_identity: { pid: service.pid, started, executable: sidecar, command } }))
renameSync(temporary, request.runtime)
await new Promise((resolve) => setTimeout(resolve, 100))
process.exit(70)
`,
    )
    await chmod(executable, 0o755)
    expect((await Bun.$`codesign --force --deep --sign - ${bundle}`.quiet()).exitCode).toBe(0)
    return bundle
  }

  const versionOf = async (bundle: string) =>
    (
      await Bun.$`plutil -extract CFBundleShortVersionString raw ${path.join(bundle, "Contents", "Info.plist")}`.text()
    ).trim()

  const entryOf = async (item: string) => {
    const stats = await lstat(item)
    return { dev: stats.dev, ino: stats.ino, type: "directory" as const }
  }

  test("the release canary consumes the exact updater ZIP against the installer app", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-artifact-canary-")))
    roots.push(root)
    const current = await buildBundle(root, "current-canary", "9.8.7")
    const sidecar = path.join(current, "Contents", "Resources", "sidecar", "openscience")
    await mkdir(path.dirname(sidecar), { recursive: true })
    await Bun.write(sidecar, "#!/bin/sh\nprintf '9.8.7\\n'\n")
    await chmod(sidecar, 0o755)
    expect((await Bun.$`codesign --force --deep --sign - ${current}`.quiet()).exitCode).toBe(0)
    const archive = path.join(root, asset(process.arch))
    expect((await Bun.$`ditto -c -k --sequesterRsrc --keepParent ${current} ${archive}`.quiet()).exitCode).toBe(0)
    const canary = path.resolve(import.meta.dir, "../../../../frontend/desktop/script/update-artifact-canary.mjs")
    const child = Bun.spawn(
      [
        process.execPath,
        canary,
        "--zip",
        archive,
        "--current",
        current,
        "--version",
        "9.8.7",
        "--arch",
        process.arch,
        "--trusted",
        "false",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
  }, 15_000)

  const authorize = async (cache: string, token: string, version: string, parent = 2_147_483_647) => {
    const handoff = path.join(cache, `handoff-${token}.json`)
    await Bun.write(
      handoff,
      `${JSON.stringify({
        schema: 1,
        authorized: true,
        token,
        version,
        parent,
        authorized_at: new Date().toISOString(),
      })}\n`,
    )
    return handoff
  }

  const writeTransaction = async (input: {
    cache: string
    token: string
    version: string
    state: "copying" | "incoming_ready" | "activated" | "committed" | "rolled_back" | "aborted"
    target: string
    incoming: string
    fallback: string
    root: string
    rootIdentity: Awaited<ReturnType<typeof entryOf>>
    replace: boolean
    helperPid?: number
    oldIdentity?: Awaited<ReturnType<typeof entryOf>>
    newIdentity: Awaited<ReturnType<typeof entryOf>>
  }) => {
    await mkdir(input.cache, { recursive: true })
    const file = path.join(input.cache, `transaction-${input.token}.json`)
    await Bun.write(
      file,
      `${JSON.stringify({
        schema: 1,
        token: input.token,
        version: input.version,
        helper_pid: input.helperPid ?? 2_147_483_647,
        target: input.target,
        incoming: input.incoming,
        fallback: input.fallback,
        root: input.root,
        root_identity: input.rootIdentity,
        health: path.join(input.cache, `health-${input.token}.json`),
        runtime: path.join(input.cache, `runtime-${input.token}.json`),
        handoff: path.join(input.cache, `handoff-${input.token}.json`),
        ready: path.join(input.cache, `helper-${input.token}.json`),
        result: path.join(input.cache, "last-result.json"),
        replace: input.replace,
        trusted: false,
        old_identity: input.oldIdentity,
        new_identity: input.newIdentity,
        state: input.state,
        updated_at: "2000-01-01T00:00:00.000Z",
      })}\n`,
    )
    return file
  }

  test("downloads a newer bundle, rolls back failed health, and commits only after health", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-update-test-")))
    roots.push(root)
    const swapper = await buildSwapper(root)
    const installedSource = await buildBundle(root, "old", "9.8.6")
    expect(
      (await Bun.$`xattr -w com.apple.quarantine "0081;test;OpenScience;" ${installedSource}`.quiet()).exitCode,
    ).toBe(0)

    const install = await stageCurrent({ current: installedSource, cache: path.join(root, "install-cache") })
    const installed = path.join(root, "Applications", "OpenScience.app")
    await mkdir(path.dirname(installed))
    const helper = new URL("../../../../frontend/desktop/src/update-helper.mjs", import.meta.url)
    const installPayload = Buffer.from(
      JSON.stringify({
        parent: 2_147_483_647,
        target: installed,
        incoming: path.join(root, "Applications", "OpenScience.incoming-aaaaaaaaaaaaaaaa.app"),
        fallback: installedSource,
        staged: install.bundle,
        root: install.root,
        replace: false,
        version: "9.8.6",
        health: path.join(root, "install-cache", `health-${"a".repeat(48)}.json`),
        runtime: path.join(root, "install-cache", `runtime-${"a".repeat(48)}.json`),
        handoff: await authorize(path.join(root, "install-cache"), "a".repeat(48), "9.8.6"),
        ready: path.join(root, "install-cache", `helper-${"a".repeat(48)}.json`),
        journal: path.join(root, "install-cache", `transaction-${"a".repeat(48)}.json`),
        result: path.join(root, "install-cache", "last-result.json"),
        token: "a".repeat(48),
        trusted: false,
      }),
    ).toString("base64url")
    const installChild = Bun.spawn([process.execPath, helper.pathname, installPayload], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        OPENSCIENCE_UPDATE_SKIP_LAUNCH: "1",
        OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE: swapper,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await installChild.exited).toBe(0)
    expect(await versionOf(installed)).toBe("9.8.6")
    expect((await Bun.$`codesign --verify --deep --strict ${installed}`.quiet()).exitCode).toBe(0)
    expect((await Bun.$`xattr -p com.apple.quarantine ${installed}`.quiet().nothrow()).exitCode).toBe(0)

    const launchMarker = path.join(root, "launch-environment.json")
    const bundle = await buildBundle(root, "new", "9.8.7", launchMarker)
    const archive = path.join(root, asset(process.arch))
    expect((await Bun.$`ditto -c -k --sequesterRsrc --keepParent ${bundle} ${archive}`.quiet()).exitCode).toBe(0)
    const digest = await checksum(archive)
    const server = Bun.serve({
      port: 0,
      routes: {
        "/releases/tags/v9.8.7": (request) =>
          Response.json({
            tag_name: "v9.8.7",
            draft: false,
            prerelease: false,
            assets: [
              {
                name: asset(process.arch),
                digest: `sha256:${digest}`,
                size: Bun.file(archive).size,
                browser_download_url: new URL("/asset", request.url).toString(),
              },
            ],
          }),
        "/asset": new Response(Bun.file(archive)),
      },
    })

    const failedUpdate = await stage("9.8.7", {
      api: server.url,
      arch: process.arch,
      cache: path.join(root, "failed-cache"),
      currentVersion: "9.8.6",
    })
    const rollbackTarget = path.join(root, "Rollback", "OpenScience.app")
    await mkdir(path.dirname(rollbackTarget))
    await Bun.$`ditto ${installed} ${rollbackTarget}`.quiet()
    const failedPayload = Buffer.from(
      JSON.stringify({
        parent: 2_147_483_647,
        target: rollbackTarget,
        incoming: path.join(root, "Rollback", "OpenScience.incoming-cccccccccccccccc.app"),
        fallback: installed,
        staged: failedUpdate.bundle,
        root: failedUpdate.root,
        replace: true,
        old_identity: await entryOf(rollbackTarget),
        version: "9.8.7",
        health: path.join(root, "failed-cache", `health-${"c".repeat(48)}.json`),
        runtime: path.join(root, "failed-cache", `runtime-${"c".repeat(48)}.json`),
        handoff: await authorize(path.join(root, "failed-cache"), "c".repeat(48), "9.8.7"),
        ready: path.join(root, "failed-cache", `helper-${"c".repeat(48)}.json`),
        journal: path.join(root, "failed-cache", `transaction-${"c".repeat(48)}.json`),
        result: path.join(root, "failed-cache", "last-result.json"),
        token: "c".repeat(48),
        trusted: false,
      }),
    ).toString("base64url")
    const failedChild = Bun.spawn([process.execPath, helper.pathname, failedPayload], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        OPENSCIENCE_UPDATE_SKIP_LAUNCH: "1",
        OPENSCIENCE_UPDATE_TEST_HEALTH_FAILURE: "1",
        OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE: swapper,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await failedChild.exited).toBe(1)
    expect(await versionOf(rollbackTarget)).toBe("9.8.6")
    expect(await Bun.file(path.join(root, "failed-cache", "last-result.json")).json()).toMatchObject({
      status: "failed",
      version: "9.8.7",
      error: "Injected desktop update health failure",
    })
    expect((await Bun.$`codesign --verify --deep --strict ${rollbackTarget}`.quiet()).exitCode).toBe(0)

    const update = await stage("9.8.7", {
      api: server.url,
      arch: process.arch,
      cache: path.join(root, "cache"),
      currentVersion: "9.8.6",
    })
    server.stop(true)
    const current = path.join(root, "Installed", "OpenScience.app")
    await mkdir(path.dirname(current))
    await Bun.$`ditto ${installed} ${current}`.quiet()
    const payload = Buffer.from(
      JSON.stringify({
        parent: 2_147_483_647,
        target: current,
        incoming: path.join(root, "Installed", "OpenScience.incoming-bbbbbbbbbbbbbbbb.app"),
        fallback: current,
        staged: update.bundle,
        root: update.root,
        replace: true,
        old_identity: await entryOf(current),
        version: "9.8.7",
        health: path.join(root, "cache", `health-${"b".repeat(48)}.json`),
        runtime: path.join(root, "cache", `runtime-${"b".repeat(48)}.json`),
        handoff: await authorize(path.join(root, "cache"), "b".repeat(48), "9.8.7"),
        ready: path.join(root, "cache", `helper-${"b".repeat(48)}.json`),
        journal: path.join(root, "cache", `transaction-${"b".repeat(48)}.json`),
        result: path.join(root, "cache", "last-result.json"),
        token: "b".repeat(48),
        trusted: false,
      }),
    ).toString("base64url")
    const child = Bun.spawn([process.execPath, helper.pathname, payload], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        ELECTRON_RUN_AS_NODE: "1",
        OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE: swapper,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(await versionOf(current)).toBe("9.8.7")
    expect(await Bun.file(path.join(root, "cache", "last-result.json")).json()).toMatchObject({
      status: "succeeded",
      version: "9.8.7",
    })
    expect((await Bun.$`codesign --verify --deep --strict ${current}`.quiet()).exitCode).toBe(0)
    expect(await Bun.file(launchMarker).json()).toEqual({ electronRunAsNode: "unset" })
    expect((await Bun.$`xattr -p com.apple.quarantine ${current}`.quiet().nothrow()).exitCode).not.toBe(0)
  })

  test("chooses a writable Applications folder for portable installs", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-destination-test-")))
    roots.push(root)
    const applications = path.join(root, "Applications")
    await mkdir(applications)

    expect(
      await destination("/Volumes/OpenScience/OpenScience.app", {
        applications,
        userApplications: path.join(root, "User Applications"),
      }),
    ).toBe(path.join(applications, "OpenScience.app"))
  })

  test("requires an explicit user-Applications migration for an administrator-owned install", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-migration-test-")))
    roots.push(root)
    const current = await buildBundle(root, "System Applications", "9.8.6")
    const parent = path.dirname(current)
    const userApplications = path.join(root, "User Applications")
    await chmod(parent, 0o555)
    try {
      await expect(destination(current, { userApplications })).rejects.toThrow("administrator-owned")
      expect(await destination(current, { userApplications, allowUserMigration: true })).toBe(
        path.join(userApplications, "OpenScience.app"),
      )
    } finally {
      await chmod(parent, 0o755)
    }
  })

  test("does not arm or mutate an install until the disposed runtime launches a ready helper", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-handoff-test-")))
    roots.push(root)
    const current = await buildBundle(root, "current", "9.8.6")
    const source = await buildBundle(root, "source", "9.8.7")
    const update = await stageCurrent({ current: source, cache: path.join(root, "cache") })

    const prepared = await apply(update, { current, executable: "/usr/bin/false" })
    expect(await versionOf(current)).toBe("9.8.6")
    expect(await Bun.file(prepared.handoff).exists()).toBe(false)
    expect(await Bun.file(prepared.ready).exists()).toBe(false)

    await expect(launch(prepared)).rejects.toThrow("exited before accepting")
    expect(await versionOf(current)).toBe("9.8.6")
    expect(await Bun.file(prepared.handoff).exists()).toBe(false)
    expect(await Bun.file(prepared.ready).exists()).toBe(false)
  })

  test("rolls back a hard-crashed desktop only after its exact sidecar has exited", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-supervisor-test-")))
    roots.push(root)
    const cache = path.join(root, "cache")
    const transactionRoot = path.join(cache, "pending-supervised")
    const staged = path.join(transactionRoot, "app", "OpenScience.app")
    const target = path.join(root, "Applications", "OpenScience.app")
    const incoming = path.join(root, "Applications", "OpenScience.incoming-dddddddddddddddd.app")
    await mkdir(path.dirname(staged), { recursive: true })
    await mkdir(path.dirname(target), { recursive: true })
    const old = await buildBundle(root, "old-supervised", "9.8.6")
    const crashing = await buildCrashingBundle(root, "new-supervised", "9.8.7")
    await Bun.$`ditto ${old} ${target}`.quiet()
    await Bun.$`ditto ${crashing} ${staged}`.quiet()
    const token = "d".repeat(48)
    const swapper = await buildSwapper(root)
    const helper = new URL("../../../../frontend/desktop/src/update-helper.mjs", import.meta.url)
    const payload = Buffer.from(
      JSON.stringify({
        parent: 2_147_483_647,
        target,
        incoming,
        fallback: target,
        staged,
        root: transactionRoot,
        replace: true,
        old_identity: await entryOf(target),
        version: "9.8.7",
        health: path.join(cache, `health-${token}.json`),
        runtime: path.join(cache, `runtime-${token}.json`),
        handoff: await authorize(cache, token, "9.8.7"),
        ready: path.join(cache, `helper-${token}.json`),
        journal: path.join(cache, `transaction-${token}.json`),
        result: path.join(cache, "last-result.json"),
        token,
        trusted: false,
      }),
    ).toString("base64url")
    const child = Bun.spawn([process.execPath, helper.pathname, payload], {
      env: { ...process.env, NODE_ENV: "test", OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE: swapper },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(1)
    expect(await versionOf(target)).toBe("9.8.6")
    expect(await Bun.file(path.join(cache, "last-result.json")).json()).toMatchObject({
      status: "failed",
      version: "9.8.7",
      error: "OpenScience 9.8.7 exited before startup health completed",
    })
  }, 30_000)

  test("rolls back an exact Electron child that exits before any sidecar receipt", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-pre-sidecar-test-")))
    roots.push(root)
    const cache = path.join(root, "cache")
    const transactionRoot = path.join(cache, "pending-pre-sidecar")
    const staged = path.join(transactionRoot, "app", "OpenScience.app")
    const target = path.join(root, "Applications", "OpenScience.app")
    const incoming = path.join(root, "Applications", "OpenScience.incoming-3333333333333333.app")
    await Promise.all([
      mkdir(path.dirname(staged), { recursive: true }),
      mkdir(path.dirname(target), { recursive: true }),
    ])
    const old = await buildBundle(root, "old-pre-sidecar", "9.8.6")
    const crashing = await buildBundle(root, "new-pre-sidecar", "9.8.7")
    await Promise.all([Bun.$`ditto ${old} ${target}`.quiet(), Bun.$`ditto ${crashing} ${staged}`.quiet()])
    const token = "3".repeat(48)
    const swapper = await buildSwapper(root)
    const helper = new URL("../../../../frontend/desktop/src/update-helper.mjs", import.meta.url)
    const payload = Buffer.from(
      JSON.stringify({
        parent: 2_147_483_647,
        target,
        incoming,
        fallback: target,
        staged,
        root: transactionRoot,
        replace: true,
        old_identity: await entryOf(target),
        version: "9.8.7",
        health: path.join(cache, `health-${token}.json`),
        runtime: path.join(cache, `runtime-${token}.json`),
        handoff: await authorize(cache, token, "9.8.7"),
        ready: path.join(cache, `helper-${token}.json`),
        journal: path.join(cache, `transaction-${token}.json`),
        result: path.join(cache, "last-result.json"),
        token,
        trusted: false,
      }),
    ).toString("base64url")
    const child = Bun.spawn([process.execPath, helper.pathname, payload], {
      env: { ...process.env, NODE_ENV: "test", OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE: swapper },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await child.exited).toBe(1)
    expect(await versionOf(target)).toBe("9.8.6")
    expect(await Bun.file(path.join(cache, "last-result.json")).json()).toMatchObject({
      status: "failed",
      version: "9.8.7",
      error: "OpenScience 9.8.7 exited before starting its local runtime",
    })
  }, 15_000)

  test("refuses to replace a same-publisher app that is already newer", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-downgrade-test-")))
    roots.push(root)
    const installed = await buildBundle(root, "installed", "9.8.7")
    const oldSource = await buildBundle(root, "old-source", "9.8.6")
    const oldUpdate = await stageCurrent({ current: oldSource, cache: path.join(root, "cache") })

    await expect(apply(oldUpdate, { current: installed })).rejects.toThrow("same version or newer")
    expect(await versionOf(installed)).toBe("9.8.7")
  })

  test("never removes an incoming path that existed before this helper transaction", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-preexisting-test-")))
    roots.push(root)
    const swapper = await buildSwapper(root)
    const source = await buildBundle(root, "source", "9.8.7")
    const cache = path.join(root, "cache")
    const prepared = await stageCurrent({ current: source, cache })
    const applications = path.join(root, "Applications")
    const target = path.join(applications, "OpenScience.app")
    const incoming = path.join(applications, "OpenScience.incoming-dddddddddddddddd.app")
    await mkdir(incoming, { recursive: true })
    await Bun.write(path.join(incoming, "identity"), "must survive\n")
    const token = "d".repeat(48)
    const helper = new URL("../../../../frontend/desktop/src/update-helper.mjs", import.meta.url)
    const payload = Buffer.from(
      JSON.stringify({
        parent: 2_147_483_647,
        target,
        incoming,
        fallback: source,
        staged: prepared.bundle,
        root: prepared.root,
        replace: false,
        version: "9.8.7",
        health: path.join(cache, `health-${token}.json`),
        runtime: path.join(cache, `runtime-${token}.json`),
        handoff: await authorize(cache, token, "9.8.7"),
        ready: path.join(cache, `helper-${token}.json`),
        journal: path.join(cache, `transaction-${token}.json`),
        result: path.join(cache, "last-result.json"),
        token,
        trusted: false,
      }),
    ).toString("base64url")
    const child = Bun.spawn([process.execPath, helper.pathname, payload], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        OPENSCIENCE_UPDATE_SKIP_LAUNCH: "1",
        OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE: swapper,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await child.exited).toBe(1)
    expect(await Bun.file(path.join(incoming, "identity")).text()).toBe("must survive\n")
  })

  test("recovers the post-swap pre-journal killpoint from authenticated slot identities", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-journal-swap-")))
    roots.push(root)
    const swapper = await buildSwapper(root)
    const cache = path.join(root, "cache")
    const staging = path.join(cache, "pending-abcdef")
    const applications = path.join(root, "Applications")
    const target = path.join(applications, "OpenScience.app")
    const incoming = path.join(applications, "OpenScience.incoming-eeeeeeeeeeeeeeee.app")
    const oldSource = await buildBundle(root, "old-source", "9.8.6")
    const newSource = await buildBundle(root, "new-source", "9.8.7")
    await Promise.all([mkdir(staging, { recursive: true }), mkdir(applications, { recursive: true })])
    await Promise.all([Bun.$`ditto ${oldSource} ${target}`.quiet(), Bun.$`ditto ${newSource} ${incoming}`.quiet()])
    const [rootIdentity, oldIdentity, newIdentity] = await Promise.all([
      entryOf(staging),
      entryOf(target),
      entryOf(incoming),
    ])
    const token = "e".repeat(48)
    const journal = await writeTransaction({
      cache,
      token,
      version: "9.8.7",
      state: "incoming_ready",
      target,
      incoming,
      fallback: target,
      root: staging,
      rootIdentity,
      replace: true,
      oldIdentity,
      newIdentity,
    })
    await DarwinUpdateSwap.run(
      Buffer.from(
        JSON.stringify({
          action: "swap",
          target,
          incoming,
          target_identity: oldIdentity,
          incoming_identity: newIdentity,
        }),
      ).toString("base64url"),
    )

    await reconcileTransactions(cache, {
      current: target,
      currentVersion: "9.8.7",
      healthyCurrent: true,
      trusted: false,
      swapExecutable: swapper,
    })

    expect(await versionOf(target)).toBe("9.8.7")
    await expect(lstat(incoming)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("recovers a first-install rename before its activated journal is durable", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-journal-install-")))
    roots.push(root)
    const swapper = await buildSwapper(root)
    const cache = path.join(root, "cache")
    const staging = path.join(cache, "install-abcdef")
    const applications = path.join(root, "Applications")
    const target = path.join(applications, "OpenScience.app")
    const incoming = path.join(applications, "OpenScience.incoming-ffffffffffffffff.app")
    const fallback = await buildBundle(root, "fallback", "9.8.7")
    const newSource = await buildBundle(root, "new-install", "9.8.7")
    await Promise.all([mkdir(staging, { recursive: true }), mkdir(applications, { recursive: true })])
    await Bun.$`ditto ${newSource} ${target}`.quiet()
    const [rootIdentity, newIdentity] = await Promise.all([entryOf(staging), entryOf(target)])
    const token = "f".repeat(48)
    await writeTransaction({
      cache,
      token,
      version: "9.8.7",
      state: "incoming_ready",
      target,
      incoming,
      fallback,
      root: staging,
      rootIdentity,
      replace: false,
      newIdentity,
    })
    await Bun.write(
      path.join(cache, `health-${token}.json`),
      JSON.stringify({ healthy: false, safe_to_terminate: true, token, version: "9.8.7" }),
    )

    const result = await reconcileTransactions(cache, {
      current: target,
      currentVersion: "9.8.7",
      healthyCurrent: false,
      trusted: false,
      swapExecutable: swapper,
    })

    expect(result.relaunch).toBe(fallback)
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("does not treat the exact live startup-health supervisor as a competing update", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-live-supervisor-")))
    roots.push(root)
    const cache = path.join(root, "cache")
    const staging = path.join(cache, "pending-abcdef")
    const applications = path.join(root, "Applications")
    const target = path.join(applications, "OpenScience.app")
    const incoming = path.join(applications, "OpenScience.incoming-abcdefabcdefabcd.app")
    const fallback = await buildBundle(root, "fallback-supervisor", "9.8.6")
    const installed = await buildBundle(root, "installed-supervisor", "9.8.7")
    const previous = await buildBundle(root, "previous-supervisor", "9.8.6")
    await Promise.all([mkdir(staging, { recursive: true }), mkdir(applications, { recursive: true })])
    await Promise.all([Bun.$`ditto ${installed} ${target}`.quiet(), Bun.$`ditto ${previous} ${incoming}`.quiet()])
    const token = "1".repeat(48)
    const [rootIdentity, newIdentity, oldIdentity] = await Promise.all([
      entryOf(staging),
      entryOf(target),
      entryOf(incoming),
    ])
    const journal = await writeTransaction({
      cache,
      token,
      version: "9.8.7",
      state: "activated",
      target,
      incoming,
      fallback,
      root: staging,
      rootIdentity,
      replace: true,
      helperPid: process.pid,
      oldIdentity,
      newIdentity,
    })
    const supervised = {
      token,
      version: "9.8.7",
      receipt: path.join(cache, `health-${token}.json`),
      runtime: path.join(cache, `runtime-${token}.json`),
    }

    expect(
      await reconcileTransactions(cache, {
        current: target,
        currentVersion: "9.8.7",
        trusted: false,
        supervised,
      }),
    ).toEqual({ relaunch: undefined, inProgress: false })
    expect((await lstat(journal)).isFile()).toBe(true)

    expect(
      await reconcileTransactions(cache, {
        current: target,
        currentVersion: "9.8.7",
        trusted: false,
        supervised: { ...supervised, token: "2".repeat(48) },
      }),
    ).toEqual({ relaunch: undefined, inProgress: true })
  })

  test("recovers a staged first install while the target is still absent", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-staged-install-")))
    roots.push(root)
    const swapper = await buildSwapper(root)
    const cache = path.join(root, "cache")
    const staging = path.join(cache, "install-abcdef")
    const applications = path.join(root, "Applications")
    const target = path.join(applications, "OpenScience.app")
    const incoming = path.join(applications, "OpenScience.incoming-abcdef0123456789.app")
    const fallback = await buildBundle(root, "fallback-staged", "9.8.7")
    const newSource = await buildBundle(root, "new-staged", "9.8.7")
    await Promise.all([mkdir(staging, { recursive: true }), mkdir(applications, { recursive: true })])
    await Bun.$`ditto ${newSource} ${incoming}`.quiet()
    const [rootIdentity, newIdentity] = await Promise.all([entryOf(staging), entryOf(incoming)])
    const token = "2".repeat(48)
    const journal = await writeTransaction({
      cache,
      token,
      version: "9.8.7",
      state: "incoming_ready",
      target,
      incoming,
      fallback,
      root: staging,
      rootIdentity,
      replace: false,
      newIdentity,
    })

    expect(
      await reconcileTransactions(cache, {
        current: fallback,
        currentVersion: "9.8.7",
        trusted: false,
        swapExecutable: swapper,
      }),
    ).toEqual({ relaunch: undefined, inProgress: false })
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(incoming)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("settles terminal journals after their owned slots and roots were already cleaned", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-journal-terminal-")))
    roots.push(root)
    const swapper = await buildSwapper(root)
    for (const [index, state] of (["committed", "rolled_back", "aborted"] as const).entries()) {
      const suffix = String(index + 1).repeat(48)
      const cache = path.join(root, `cache-${index}`)
      const staging = path.join(cache, `pending-abcde${index}`)
      const applications = path.join(root, `Applications-${index}`)
      const target = path.join(applications, "OpenScience.app")
      const incoming = path.join(applications, `OpenScience.incoming-${String(index + 1).repeat(16)}.app`)
      const oldSource = await buildBundle(root, `terminal-old-${index}`, "9.8.6")
      const newSource = await buildBundle(root, `terminal-new-${index}`, "9.8.7")
      await Promise.all([mkdir(staging, { recursive: true }), mkdir(applications)])
      if (state !== "aborted") {
        await Bun.$`ditto ${state === "committed" ? newSource : oldSource} ${target}`.quiet()
      }
      const oldIdentity = state === "rolled_back" ? await entryOf(target) : await entryOf(oldSource)
      const newIdentity = state === "committed" ? await entryOf(target) : await entryOf(newSource)
      const rootIdentity = await entryOf(staging)
      const journal = await writeTransaction({
        cache,
        token: suffix,
        version: "9.8.7",
        state,
        target,
        incoming,
        fallback: state === "aborted" ? oldSource : target,
        root: staging,
        rootIdentity,
        replace: state !== "aborted",
        oldIdentity: state === "aborted" ? undefined : oldIdentity,
        newIdentity,
      })
      await rm(staging, { recursive: true })

      await reconcileTransactions(cache, {
        current: target,
        currentVersion: "9.8.7",
        trusted: false,
        swapExecutable: swapper,
      })
      await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" })
    }
  })

  test("keeps aborted journal evidence when either pre-activation target invariant changed", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-journal-aborted-")))
    roots.push(root)
    const swapper = await buildSwapper(root)

    for (const [index, replace] of [false, true].entries()) {
      const cache = path.join(root, `cache-${index}`)
      const staging = path.join(cache, `pending-fedcb${index}`)
      const applications = path.join(root, `Applications-${index}`)
      const target = path.join(applications, "OpenScience.app")
      const incoming = path.join(applications, `OpenScience.incoming-${String(index + 7).repeat(16)}.app`)
      const expected = await buildBundle(root, `expected-${index}`, "9.8.6")
      const replacement = await buildBundle(root, `replacement-${index}`, "9.8.5")
      const staged = await buildBundle(root, `aborted-staged-${index}`, "9.8.7")
      await Promise.all([mkdir(staging, { recursive: true }), mkdir(applications)])
      let oldIdentity
      if (replace) {
        await Bun.$`ditto ${expected} ${target}`.quiet()
        oldIdentity = await entryOf(target)
        await rm(target, { recursive: true })
      }
      await Bun.$`ditto ${replacement} ${target}`.quiet()
      const rootIdentity = await entryOf(staging)
      const journal = await writeTransaction({
        cache,
        token: String(index + 7).repeat(48),
        version: "9.8.7",
        state: "aborted",
        target,
        incoming,
        fallback: expected,
        root: staging,
        rootIdentity,
        replace,
        oldIdentity,
        newIdentity: await entryOf(staged),
      })

      await expect(
        reconcileTransactions(cache, {
          current: target,
          currentVersion: "9.8.6",
          trusted: false,
          swapExecutable: swapper,
        }),
      ).rejects.toThrow("Aborted update target changed before recovery")
      expect(await versionOf(target)).toBe("9.8.5")
      expect((await lstat(journal)).isFile()).toBe(true)
    }
  })
})
