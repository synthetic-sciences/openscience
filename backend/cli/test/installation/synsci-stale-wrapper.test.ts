import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const launcher = path.join(import.meta.dir, "../../../../tooling/launcher/bin/synsci.mjs")
const scopes: string[] = []
const posix = process.platform === "win32" ? test.skip : test
const mac = process.platform === "darwin" ? test : test.skip
const keys = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
]
const plist = (entries: string[]) =>
  `<?xml version="1.0"?><plist><dict>${entries.map((key) => `<key>${key}</key><true/>`).join("")}</dict></plist>`
const entitled = plist(keys)
const noJit = plist(keys.slice(1))
const jitOnly = plist(keys.slice(0, 1))

afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => fs.rm(scope, { recursive: true, force: true })))
})

async function fixture(options: {
  standalone?: "safe" | "rejected"
  version?: string
  manifest?: "valid" | "missing" | "malformed"
  globalEntitlements?: string | false
  standaloneEntitlements?: string | false
  installedEntitlements?: string | false
  dependencyVersion?: string
  override?: boolean
  npmInstall?: "success" | "fail"
  pathCandidate?: boolean
}) {
  const scope = await fs.mkdtemp(path.join(os.tmpdir(), "synsci-stale-wrapper-"))
  scopes.push(scope)
  const home = path.join(scope, "home")
  const prefix = path.join(scope, "prefix")
  const root = path.join(prefix, "lib", "node_modules")
  const bin = path.join(prefix, "bin", "openscience")
  const manifest = path.join(root, "@synsci", "openscience", "package.json")
  const native = path.join(
    root,
    "@synsci",
    "openscience",
    "node_modules",
    "@synsci",
    `openscience-darwin-${process.arch}`,
    "bin",
    "openscience",
  )
  const nativeManifest = path.join(path.dirname(path.dirname(native)), "package.json")
  const tools = path.join(home, "tools")
  const npm = path.join(tools, "npm")
  const codesign = path.join(tools, "codesign")
  const data = path.join(home, ".openscience")
  const local = path.join(data, "bin", "openscience")
  const globalMarker = path.join(scope, "global-wrapper-ran")
  const nativeMarker = path.join(scope, "global-native-ran")
  const installedMarker = path.join(scope, "installed-native-ran")
  const installedWrapperMarker = path.join(scope, "installed-wrapper-ran")
  const standaloneMarker = path.join(scope, "standalone-ran")
  const overrideMarker = path.join(scope, "override-ran")
  const pathMarker = path.join(scope, "path-candidate-ran")
  const recursionMarker = path.join(scope, "launcher-guard-leaked")
  const override = path.join(scope, "override")
  const pathCandidate = path.join(tools, "openscience")
  const calls = path.join(scope, "cli-calls.jsonl")
  const npmCalls = path.join(scope, "npm-calls.jsonl")
  const codesignCalls = path.join(scope, "codesign-calls.jsonl")
  const mapFile = path.join(scope, "codesign-map.json")
  const version = options.version ?? "1.3.0"
  const globalSource = `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(process.env.FAKE_GLOBAL_MARKER, "executed\\n")
if (process.argv[2] === "--version") console.log(${JSON.stringify(version)})
`
  const safeSource = `#!/usr/bin/env node
const fs = require("node:fs")
fs.appendFileSync(process.env.FAKE_CLI_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n")
if (process.argv[2] === "--version") console.log("2.0.66")
if (process.argv[2] === "web" && process.env.__SYNSCI_LAUNCHER_PID) fs.writeFileSync(process.env.FAKE_RECURSION_MARKER, "leaked\\n")
`
  const nativeSource = `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(process.env.FAKE_NATIVE_MARKER, "executed\\n")
fs.appendFileSync(process.env.FAKE_CLI_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n")
if (process.argv[2] === "--version") console.log(${JSON.stringify(version)})
`
  const installedSource = `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(process.env.FAKE_INSTALLED_MARKER, "executed\\n")
fs.appendFileSync(process.env.FAKE_CLI_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n")
if (process.argv[2] === "--version") console.log("2.0.66")
`
  const installedWrapperSource = `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(process.env.FAKE_INSTALLED_WRAPPER_MARKER, "executed\\n")
fs.appendFileSync(process.env.FAKE_CLI_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n")
if (process.argv[2] === "--version") console.log("2.0.66")
`
  const rejectedSource = `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(process.env.FAKE_STANDALONE_MARKER, "executed\\n")
if (process.argv[2] === "--version") console.log("2.0.66")
`
  const overrideSource = `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(process.env.FAKE_OVERRIDE_MARKER, "executed\\n")
if (process.argv[2] === "--version") console.log("2.0.66")
`
  const pathSource = `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(process.env.FAKE_PATH_MARKER, "executed\\n")
if (process.argv[2] === "--version") console.log("2.0.66")
`
  const npmSource = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_NPM_CALLS, JSON.stringify(args) + "\\n")
if (args[0] === "prefix" && args[1] === "-g") {
  console.log(process.env.FAKE_NPM_PREFIX)
  process.exit(0)
}
if (args[0] === "root" && args[1] === "-g") {
  console.log(process.env.FAKE_NPM_ROOT)
  process.exit(0)
}
if (args[0] === "ls") {
  console.log('{"dependencies":{}}')
  process.exit(0)
}
if (args[0] === "view") {
  console.log("2.0.66")
  process.exit(0)
}
if (args[0] === "i" && args[1] === "-g") {
  if (process.env.FAKE_NPM_INSTALL === "fail") process.exit(1)
  fs.mkdirSync(path.dirname(process.env.FAKE_GLOBAL_MANIFEST), { recursive: true })
  fs.mkdirSync(path.dirname(process.env.FAKE_GLOBAL_NATIVE), { recursive: true })
  fs.writeFileSync(process.env.FAKE_GLOBAL_MANIFEST, JSON.stringify({
    name: "@synsci/openscience",
    version: "2.0.66",
    optionalDependencies: { [process.env.FAKE_GLOBAL_NATIVE_NAME]: "2.0.66" },
  }))
  fs.writeFileSync(process.env.FAKE_GLOBAL_BIN, process.env.FAKE_INSTALLED_WRAPPER_SOURCE)
  fs.writeFileSync(process.env.FAKE_GLOBAL_NATIVE, process.env.FAKE_INSTALLED_SOURCE)
  fs.writeFileSync(process.env.FAKE_GLOBAL_NATIVE_MANIFEST, JSON.stringify({ name: process.env.FAKE_GLOBAL_NATIVE_NAME, version: "2.0.66" }))
  fs.chmodSync(process.env.FAKE_GLOBAL_BIN, 0o755)
  fs.chmodSync(process.env.FAKE_GLOBAL_NATIVE, 0o755)
  const map = JSON.parse(fs.readFileSync(process.env.FAKE_CODESIGN_MAP, "utf8"))
  if (process.env.FAKE_INSTALLED_ENTITLEMENTS) {
    map[process.env.FAKE_GLOBAL_NATIVE] = process.env.FAKE_INSTALLED_ENTITLEMENTS
  } else {
    delete map[process.env.FAKE_GLOBAL_NATIVE]
  }
  fs.writeFileSync(process.env.FAKE_CODESIGN_MAP, JSON.stringify(map))
  process.exit(0)
}
process.exit(1)
`
  const codesignSource = `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
const file = args.at(-1)
fs.appendFileSync(process.env.FAKE_CODESIGN_CALLS, JSON.stringify(args) + "\\n")
const map = JSON.parse(fs.readFileSync(process.env.FAKE_CODESIGN_MAP, "utf8"))
if (typeof map[file] !== "string") process.exit(1)
process.stdout.write(map[file])
`

  await Promise.all([
    fs.mkdir(path.dirname(manifest), { recursive: true }),
    fs.mkdir(path.dirname(native), { recursive: true }),
    fs.mkdir(path.dirname(bin), { recursive: true }),
    fs.mkdir(path.dirname(local), { recursive: true }),
    fs.mkdir(tools, { recursive: true }),
    fs.mkdir(data, { recursive: true }),
  ])
  await Promise.all([
    fs.writeFile(bin, globalSource),
    fs.writeFile(native, nativeSource),
    fs.writeFile(nativeManifest, JSON.stringify({ name: `@synsci/openscience-darwin-${process.arch}`, version })),
    fs.writeFile(npm, npmSource),
    fs.writeFile(codesign, codesignSource),
    fs.writeFile(override, overrideSource),
    options.pathCandidate ? fs.writeFile(pathCandidate, pathSource) : undefined,
    fs.writeFile(path.join(data, "openscience-session.json"), JSON.stringify({ api_key: "thk_fixture.token" })),
  ])
  if ((options.manifest ?? "valid") === "valid") {
    await fs.writeFile(
      manifest,
      JSON.stringify({
        name: "@synsci/openscience",
        version,
        optionalDependencies: {
          [`@synsci/openscience-darwin-${process.arch}`]: options.dependencyVersion ?? version,
        },
      }),
    )
  }
  if (options.manifest === "malformed") await fs.writeFile(manifest, "{")
  if (options.standalone) {
    await fs.writeFile(local, options.standalone === "safe" ? safeSource : rejectedSource)
  }

  const map: Record<string, string> = {}
  const globalEntitlements = Object.hasOwn(options, "globalEntitlements") ? options.globalEntitlements : entitled
  if (typeof globalEntitlements === "string") map[native] = globalEntitlements
  const standaloneEntitlements = Object.hasOwn(options, "standaloneEntitlements")
    ? options.standaloneEntitlements
    : options.standalone === "safe"
      ? entitled
      : false
  if (typeof standaloneEntitlements === "string") map[local] = standaloneEntitlements
  const installedEntitlements = Object.hasOwn(options, "installedEntitlements")
    ? options.installedEntitlements
    : entitled
  await fs.writeFile(mapFile, JSON.stringify(map))
  await Promise.all([
    fs.chmod(bin, 0o755),
    fs.chmod(native, 0o755),
    fs.chmod(npm, 0o755),
    fs.chmod(codesign, 0o755),
    fs.chmod(override, 0o755),
    options.pathCandidate ? fs.chmod(pathCandidate, 0o755) : undefined,
    options.standalone ? fs.chmod(local, 0o755) : undefined,
  ])

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    OPENSCIENCE_TEST_HOME: home,
    OPENSCIENCE_TEST_CODESIGN: codesign,
    XDG_CONFIG_HOME: path.join(scope, "config"),
    XDG_DATA_HOME: path.join(scope, "share"),
    OPENSCIENCE_DATA_DIR: data,
    PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_NPM_PREFIX: prefix,
    FAKE_NPM_ROOT: root,
    FAKE_NPM_CALLS: npmCalls,
    FAKE_GLOBAL_MANIFEST: manifest,
    FAKE_GLOBAL_BIN: bin,
    FAKE_GLOBAL_NATIVE: native,
    FAKE_GLOBAL_NATIVE_MANIFEST: nativeManifest,
    FAKE_GLOBAL_NATIVE_NAME: `@synsci/openscience-darwin-${process.arch}`,
    FAKE_INSTALLED_SOURCE: installedSource,
    FAKE_INSTALLED_WRAPPER_SOURCE: installedWrapperSource,
    FAKE_GLOBAL_MARKER: globalMarker,
    FAKE_NATIVE_MARKER: nativeMarker,
    FAKE_INSTALLED_MARKER: installedMarker,
    FAKE_INSTALLED_WRAPPER_MARKER: installedWrapperMarker,
    FAKE_STANDALONE_MARKER: standaloneMarker,
    FAKE_OVERRIDE_MARKER: overrideMarker,
    FAKE_PATH_MARKER: pathMarker,
    FAKE_RECURSION_MARKER: recursionMarker,
    FAKE_CLI_CALLS: calls,
    FAKE_CODESIGN_MAP: mapFile,
    FAKE_CODESIGN_CALLS: codesignCalls,
    FAKE_INSTALLED_ENTITLEMENTS: typeof installedEntitlements === "string" ? installedEntitlements : "",
    FAKE_NPM_INSTALL: options.npmInstall ?? "success",
  }
  if (options.override) env.OPENSCIENCE_BIN_PATH = override
  delete env.__SYNSCI_LAUNCHER_PID
  return {
    scope,
    globalMarker,
    nativeMarker,
    installedMarker,
    installedWrapperMarker,
    standaloneMarker,
    overrideMarker,
    pathMarker,
    recursionMarker,
    calls,
    npmCalls,
    codesignCalls,
    native,
    local,
    env,
  }
}

async function launch(env: NodeJS.ProcessEnv) {
  const proc = Bun.spawn(["node", launcher], {
    cwd: env.HOME,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

describe("synsci unsafe candidate recovery", () => {
  posix("never probes a pre-2.0.2 global wrapper when a standalone binary is available", async () => {
    const setup = await fixture({ standalone: "safe" })
    const result = await launch(setup.env)

    expect(result.code, result.stderr).toBe(0)
    expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
    expect(await Bun.file(setup.calls).text()).toContain('["web"]')
    expect(await Bun.file(setup.npmCalls).text()).not.toContain('["i","-g"')
    expect(await Bun.file(setup.recursionMarker).exists()).toBe(false)
  })

  posix("repairs npm before executing a pre-2.0.2 wrapper when no standalone binary exists", async () => {
    const setup = await fixture({})
    const result = await launch(setup.env)

    expect(result.code, result.stderr).toBe(0)
    expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
    expect(await Bun.file(setup.npmCalls).text()).toContain('["i","-g","@synsci/openscience@latest"]')
    expect(await Bun.file(setup.calls).text()).toContain('["web"]')
  })

  for (const state of ["missing", "malformed"] as const) {
    posix(`does not probe a global wrapper with ${state} ownership metadata`, async () => {
      const setup = await fixture({ version: "2.0.66", manifest: state, standalone: "safe" })
      const result = await launch(setup.env)

      expect(result.code, result.stderr).toBe(0)
      expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
      expect(await Bun.file(setup.npmCalls).text()).not.toContain('["i","-g"')
      expect(await Bun.file(setup.calls).text()).toContain('["web"]')
    })
  }

  for (const version of ["garbage", "2.0", "2.0.02", "2.0.2.5", "2.0.2-01", "2.0.2-beta.1", "9007199254740992.0.0"]) {
    posix(`does not probe a global wrapper with unsafe version ${version}`, async () => {
      const setup = await fixture({ version, standalone: "safe" })
      const result = await launch(setup.env)

      expect(result.code, result.stderr).toBe(0)
      expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
      expect(await Bun.file(setup.calls).text()).toContain('["web"]')
    })
  }

  mac("rejects a version-current global wrapper whose native binary lacks allow-jit", async () => {
    const setup = await fixture({
      version: "2.0.66",
      standalone: "safe",
      globalEntitlements: noJit,
    })
    const result = await launch(setup.env)

    expect(result.code, result.stderr).toBe(0)
    expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
    expect(await Bun.file(setup.nativeMarker).exists()).toBe(false)
    expect(await Bun.file(setup.calls).text()).toContain('["web"]')
    const calls = await Bun.file(setup.codesignCalls).text()
    expect(calls).toContain(JSON.stringify(["--verify", "--strict", setup.native]))
    expect(calls).toContain(setup.native)
    expect(calls).toContain(setup.local)
  })

  mac("rejects a native package not bound to the wrapper's exact dependency version", async () => {
    const setup = await fixture({
      version: "2.0.66",
      dependencyVersion: "2.0.65",
      standalone: "safe",
    })
    const result = await launch(setup.env)

    expect(result.code, result.stderr).toBe(0)
    expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
    expect(await Bun.file(setup.nativeMarker).exists()).toBe(false)
    expect(await Bun.file(setup.calls).text()).toContain('["web"]')
  })

  mac("repairs npm without probing a standalone binary missing the full entitlement set", async () => {
    const setup = await fixture({
      version: "2.0.66",
      manifest: "missing",
      standalone: "rejected",
      standaloneEntitlements: jitOnly,
    })
    const result = await launch(setup.env)

    expect(result.code, result.stderr).toBe(0)
    expect(await Bun.file(setup.standaloneMarker).exists()).toBe(false)
    expect(await Bun.file(setup.npmCalls).text()).toContain('["i","-g","@synsci/openscience@latest"]')
    expect(await Bun.file(setup.codesignCalls).text()).toContain(setup.local)
    expect(await Bun.file(setup.calls).text()).toContain('["web"]')
  })

  mac("executes the validated native package directly and ignores OPENSCIENCE_BIN_PATH", async () => {
    const setup = await fixture({ version: "2.0.66", override: true })
    const result = await launch(setup.env)

    expect(result.code, result.stderr).toBe(0)
    expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
    expect(await Bun.file(setup.overrideMarker).exists()).toBe(false)
    expect(await Bun.file(setup.nativeMarker).exists()).toBe(true)
    expect(await Bun.file(setup.codesignCalls).text()).toContain(setup.native)
    expect(await Bun.file(setup.calls).text()).toContain('["web"]')
  })

  mac("revalidates a mac npm update and never executes a rejected replacement", async () => {
    const setup = await fixture({
      version: "2.0.65",
      standalone: "safe",
      installedEntitlements: false,
      override: true,
    })
    const result = await launch(setup.env)

    expect(result.code, result.stderr).toBe(0)
    expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
    expect(await Bun.file(setup.installedWrapperMarker).exists()).toBe(false)
    expect(await Bun.file(setup.installedMarker).exists()).toBe(false)
    expect(await Bun.file(setup.overrideMarker).exists()).toBe(false)
    expect(await Bun.file(setup.nativeMarker).exists()).toBe(true)
    expect(await Bun.file(setup.npmCalls).text()).toContain('["i","-g","@synsci/openscience@2.0.66"]')
    expect(await Bun.file(setup.codesignCalls).text()).toContain(setup.native)
    expect(await Bun.file(setup.calls).text()).toContain('["web"]')
  })

  posix("does not let installer recovery execute an unverified command already on PATH", async () => {
    const setup = await fixture({ manifest: "missing", npmInstall: "fail", pathCandidate: true })
    const result = await launch(setup.env)

    expect(result.code).toBe(1)
    expect(result.stdout).toContain("refusing to execute an existing unverified openscience command")
    expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
    expect(await Bun.file(setup.pathMarker).exists()).toBe(false)
    expect(await Bun.file(setup.npmCalls).text()).toContain('["i","-g","@synsci/openscience@latest"]')
  })

  // The standalone binary is only "rejected" by the macOS entitlement gate;
  // elsewhere its `--version` probe succeeds and it is a valid install.
  mac("does not let installer recovery execute a rejected command already on PATH", async () => {
    const setup = await fixture({
      manifest: "missing",
      standalone: "rejected",
      standaloneEntitlements: false,
      npmInstall: "fail",
      pathCandidate: true,
    })
    const result = await launch(setup.env)

    expect(result.code).toBe(1)
    expect(result.stdout).toContain("refusing to execute an existing unverified openscience command")
    expect(await Bun.file(setup.globalMarker).exists()).toBe(false)
    expect(await Bun.file(setup.standaloneMarker).exists()).toBe(false)
    expect(await Bun.file(setup.pathMarker).exists()).toBe(false)
    expect(await Bun.file(setup.npmCalls).text()).toContain('["i","-g","@synsci/openscience@latest"]')
  })
})
