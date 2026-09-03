#!/usr/bin/env node

// `npx synsci`: the OpenScience installer and launcher.
//
// The npm package (and this bin) keep the historical `synsci` name so the
// one-liner everyone knows keeps working; everything it installs is the
// OpenScience CLI (`@synsci/openscience`, binary `openscience`).

// Hard guard against recursive invocation. If a check ever resolves to the
// launcher itself, this prevents an infinite spawn chain that exhausts memory.
if (process.env.__SYNSCI_LAUNCHER_PID) {
  process.stderr.write(
    `synsci: launcher invoked recursively (parent pid ${process.env.__SYNSCI_LAUNCHER_PID}). Exiting.\n`,
  )
  process.exit(2)
}
process.env.__SYNSCI_LAUNCHER_PID = String(process.pid)

import { execFileSync, execSync, spawn } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { constants, homedir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { npmDistTag, opensciencePackageSpec } from "../lib/channel.mjs"

const SELF_PATH = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return ""
  }
})()
const LAUNCHER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version || "0.0.0"
  } catch {
    return "0.0.0"
  }
})()
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(LAUNCHER_VERSION)
  process.exit(0)
}
const OPENSCIENCE_NPM_TAG = npmDistTag(LAUNCHER_VERSION)
const OPENSCIENCE_NPM_SPEC = opensciencePackageSpec(LAUNCHER_VERSION)
// `--allow-installer` is consumed here (consent to pipe the remote standalone
// installer into bash); everything else is forwarded to `openscience web`.
const ALLOW_INSTALLER = process.argv.includes("--allow-installer")
const ARGS = process.argv.slice(2).filter((arg) => arg !== "--allow-installer")
const STANDALONE_INSTALL =
  "PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c '/usr/bin/curl -fsSL https://openscience.sh/install | /bin/bash'"
const SAFE_GLOBAL_WRAPPER_VERSION = [2, 0, 2]
const MACOS_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
]
const TEST_CODESIGN = process.env.OPENSCIENCE_TEST_CODESIGN
const CODESIGN =
  process.env.OPENSCIENCE_TEST_HOME &&
  TEST_CODESIGN &&
  resolve(TEST_CODESIGN).startsWith(`${resolve(process.env.OPENSCIENCE_TEST_HOME)}/`)
    ? TEST_CODESIGN
    : "/usr/bin/codesign"

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const RESET = "\x1b[0m"
const HIDE_CURSOR = "\x1b[?25l"
const SHOW_CURSOR = "\x1b[?25h"
const CLEAR_LINE = "\x1b[2K\r"

const LOGO = [
  "███████╗██╗   ██╗███╗   ██╗████████╗██╗  ██╗███████╗████████╗██╗ ██████╗",
  "██╔════╝╚██╗ ██╔╝████╗  ██║╚══██╔══╝██║  ██║██╔════╝╚══██╔══╝██║██╔════╝",
  "███████╗ ╚████╔╝ ██╔██╗ ██║   ██║   ███████║█████╗     ██║   ██║██║     ",
  "╚════██║  ╚██╔╝  ██║╚██╗██║   ██║   ██╔══██║██╔══╝     ██║   ██║██║     ",
  "███████║   ██║   ██║ ╚████║   ██║   ██║  ██║███████╗   ██║   ██║╚██████╗",
  "╚══════╝   ╚═╝   ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝ ╚═════╝",
  "███████╗ ██████╗██╗███████╗███╗   ██╗ ██████╗███████╗███████╗",
  "██╔════╝██╔════╝██║██╔════╝████╗  ██║██╔════╝██╔════╝██╔════╝",
  "███████╗██║     ██║█████╗  ██╔██╗ ██║██║     █████╗  ███████╗",
  "╚════██║██║     ██║██╔══╝  ██║╚██╗██║██║     ██╔══╝  ╚════██║",
  "███████║╚██████╗██║███████╗██║ ╚████║╚██████╗███████╗███████║",
  "╚══════╝ ╚═════╝╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝╚══════╝",
]

function ok(msg) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}
function warn(msg) {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`)
}

function spinner(msg) {
  const frames = ["◒", "◐", "◓", "◑"]
  let i = 0
  process.stdout.write(HIDE_CURSOR)
  const id = setInterval(() => {
    process.stdout.write(`${CLEAR_LINE}  ${CYAN}${frames[i++ % frames.length]}${RESET} ${msg}`)
  }, 80)
  return {
    ok(result) {
      clearInterval(id)
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`)
      ok(result)
    },
    warn(result) {
      clearInterval(id)
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`)
      warn(result)
    },
    fail(result) {
      clearInterval(id)
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`)
      console.log(`  ${RED}✗${RESET} ${result}`)
    },
    update(m) {
      msg = m
    },
  }
}

function runQuiet(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch {
    return null
  }
}

// Windows global installs expose a .cmd shim, which can't be exec'd
// directly — it needs cmd.exe. cmd parses the command token once for `/c`,
// but the shim's `%*` expansion parses the arguments a second time, so each
// argument is quoted per https://qntm.org/cmd and caret-escaped twice.
const isCmdShim = (p) => process.platform === "win32" && p.toLowerCase().endsWith(".cmd")
const CMD_META = /([()\][%!^"`<>&|;, *?])/g
const cmdEscape = (value) => value.replace(CMD_META, "^$1")

function cmdQuote(arg) {
  const quoted = `"${String(arg)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1")}"`
  return cmdEscape(cmdEscape(quoted))
}

function cmdLine(file, args) {
  return [cmdEscape(file), ...args.map(cmdQuote)].join(" ")
}

function execCli(file, args = [], opts = {}) {
  if (isCmdShim(file)) return execSync(cmdLine(file, args), opts)
  return execFileSync(file, args, opts)
}

function runFileQuiet(file, args = []) {
  try {
    return execCli(file, args, { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch {
    return null
  }
}

function isLauncherPath(p) {
  try {
    const real = realpathSync(p)
    if (SELF_PATH && real === SELF_PATH) return true
    if (real.includes("/_npx/")) return true
    return false
  } catch {
    return false
  }
}

// The recursion guard is process-local: the CLI (and every terminal or tool
// the workspace spawns from it) must not inherit it, or a nested `synsci`
// would exit with the recursion error. Self-recursion is caught instead by
// comparing the resolved CLI's realpath with the launcher before spawning.
function cliEnv() {
  const env = { ...process.env }
  delete env.__SYNSCI_LAUNCHER_PID
  return env
}

// Never pipe a remote script into bash without consent: an explicit
// `--allow-installer` flag, or a yes on an interactive terminal.
async function installerConsent() {
  if (ALLOW_INSTALLER) return true
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      `  Run the standalone installer (${CYAN}curl -fsSL https://openscience.sh/install | bash${RESET})? [y/N] `,
    )
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

function unsafeGlobalVersion(version) {
  const match = String(version || "").match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  if (!match) return true
  const parts = match.slice(1, 4).map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part))) return true
  if (match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return true
  const index = parts.findIndex((part, i) => part !== SAFE_GLOBAL_WRAPPER_VERSION[i])
  if (index !== -1) return parts[index] < SAFE_GLOBAL_WRAPPER_VERSION[index]
  return Boolean(match[4])
}

function globalPackage(prefix) {
  const detected = runQuiet("npm root -g")
  const fallback = process.platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules")
  const roots = [detected, fallback].filter((root, index, all) => root && all.indexOf(root) === index)
  for (const root of roots) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "@synsci", "openscience", "package.json"), "utf-8"))
      if (pkg.name === "@synsci/openscience" && typeof pkg.version === "string") {
        return { root, version: pkg.version, dependencies: pkg.optionalDependencies }
      }
    } catch {
      /* missing or malformed npm ownership metadata fails closed */
    }
  }
  return null
}

function avx2() {
  if (process.arch !== "x64") return undefined
  try {
    const value = execFileSync("/usr/sbin/sysctl", ["-n", "machdep.cpu.leaf7_features"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
    return value.toLowerCase().split(/\s+/).includes("avx2")
  } catch {
    return undefined
  }
}

function globalMacBinary(root, version, dependencies) {
  if (process.platform !== "darwin") return null
  const base = `openscience-darwin-${process.arch}`
  const names = process.arch === "x64" && avx2() === false ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
  const packageRoot = join(root, "@synsci", "openscience")
  const modules = [join(packageRoot, "node_modules"), root]
  for (const name of names) {
    for (const dir of modules) {
      for (const scoped of [true, false]) {
        const packageDir = scoped ? join(dir, "@synsci", name) : join(dir, name)
        const file = join(packageDir, "bin", "openscience")
        if (!existsSync(file)) continue
        try {
          const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8"))
          const expected = scoped ? `@synsci/${name}` : name
          if (pkg.name === expected && pkg.version === version && dependencies?.[expected] === version) return file
        } catch {
          /* native package ownership and version must be exact */
        }
      }
    }
  }
  return null
}

function macEntitled(file) {
  if (process.platform !== "darwin") return true
  try {
    execFileSync(CODESIGN, ["--verify", "--strict", file], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    })
    const plist = execFileSync(CODESIGN, ["-d", "--entitlements", ":-", file], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
    return MACOS_ENTITLEMENTS.every((key) => {
      const tag = `<key>${key}</key>`
      const index = plist.indexOf(tag)
      if (index === -1) return false
      return /^\s*<true\s*\/>/.test(plist.slice(index + tag.length))
    })
  } catch {
    return false
  }
}

function macCandidateReady(binaries) {
  if (process.platform !== "darwin") return true
  if (binaries.length === 0) return false
  return binaries.every(macEntitled)
}

// Returns the absolute path to the real @synsci/openscience binary (`openscience`).
// Only trusts canonical install locations (no `$PATH` walk) to avoid picking
// up dev shims or workspace symlinks. Each candidate is verified by invoking
// `--version` so half-broken installs are skipped instead of accepted.
function resolveCli() {
  const candidates = []
  // 1. Global npm prefix (where `npm i -g @synsci/openscience` puts it).
  // On Windows the global bin dir is the prefix itself and the entry is an
  // openscience.cmd shim; on POSIX it's <prefix>/bin/openscience.
  const prefix = runQuiet("npm prefix -g")
  if (prefix) {
    const pkg = globalPackage(prefix)
    // Versions before 2.0.2 recursively ran `xattr -rc ~/.openscience` even
    // for `--version`. Never execute one as a health probe: use a safe
    // standalone install, or let the normal install path repair npm first.
    // Missing ownership metadata also fails closed: an arbitrary global bin
    // must never be executed while attempting to repair OpenScience.
    if (pkg && !unsafeGlobalVersion(pkg.version)) {
      const wrapper =
        process.platform === "win32" ? join(prefix, "openscience.cmd") : join(prefix, "bin", "openscience")
      const native = globalMacBinary(pkg.root, pkg.version, pkg.dependencies)
      // On macOS execute the exact version-bound native package directly.
      // The npm wrapper honors OPENSCIENCE_BIN_PATH, so running it after
      // validating a different binary would reintroduce an entitlement bypass.
      const file = process.platform === "darwin" ? native : wrapper
      if (file) candidates.push({ file, binaries: [file] })
    }
  }
  // 2. ~/.openscience/bin/openscience (curl-installer location, POSIX only)
  if (process.platform !== "win32") {
    const file = join(homedir(), ".openscience", "bin", "openscience")
    candidates.push({ file, binaries: [file] })
  }

  for (const cand of candidates) {
    if (!existsSync(cand.file) || isLauncherPath(cand.file)) continue
    // A malformed or JIT-incompatible macOS executable can enter an
    // uninterruptible kernel wait before `--version` returns. Inspect the
    // native executable's signature without running it; Node's timeout cannot
    // recover a process once that wait begins.
    if (!macCandidateReady(cand.binaries)) continue
    try {
      const ver = execCli(cand.file, ["--version"], {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }).trim()
      if (/^\d/.test(ver)) return cand.file
    } catch {
      /* unrunnable candidate, try next */
    }
  }
  return null
}

// The deprecated `@synsci/cli` package links the same `openscience` bin. npm
// refuses to overwrite a bin file owned by another package (EEXIST), so a
// stale global install dead-ends the upgrade — and its old binary shadows the
// real one on PATH. `npm ls` exits nonzero when the package is absent but
// still prints JSON, so read stdout either way.
function hasDeprecatedCli() {
  let out = ""
  try {
    out = execSync("npm ls -g @synsci/cli --depth=0 --json", { encoding: "utf-8", stdio: "pipe" })
  } catch (e) {
    out = e && typeof e.stdout === "string" ? e.stdout : ""
  }
  try {
    return Boolean(JSON.parse(out).dependencies["@synsci/cli"])
  } catch {
    return false
  }
}

function isConnected() {
  const explicit = process.env.OPENSCIENCE_DATA_DIR?.trim()
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const pointerPath = join(xdgConfig, "openscience", "data-location")
  const pointer = (() => {
    try {
      return readFileSync(pointerPath, "utf-8").trim()
    } catch {
      return ""
    }
  })()
  const roots = explicit
    ? [resolve(explicit)]
    : pointer
      ? [resolve(pointer)]
      : [join(homedir(), ".openscience"), join(xdgData, "openscience")]
  const sessionPath = roots.map((root) => join(root, "openscience-session.json")).find(existsSync)
  if (!sessionPath) return false
  try {
    const data = JSON.parse(readFileSync(sessionPath, "utf-8"))
    return typeof data.api_key === "string" && /^thk_[^.]+\.[A-Za-z0-9_-]+$/.test(data.api_key)
  } catch {
    return false
  }
}
async function main() {
  process.on("exit", () => process.stdout.write(SHOW_CURSOR))
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR)
    process.exit(130)
  })

  // --- Logo ---
  console.log()
  for (const line of LOGO) console.log(`   ${CYAN}${line}${RESET}`)
  console.log()
  console.log(`   ${BOLD}Synthetic Sciences${RESET} ${DIM}OpenScience, the open-source AI research workspace${RESET}`)
  console.log()

  // --- Step 1: Install or upgrade the OpenScience CLI ---
  if (hasDeprecatedCli()) {
    const s = spinner("Removing the deprecated @synsci/cli so it can't shadow the openscience command...")
    if (runQuiet("npm rm -g @synsci/cli") !== null) {
      s.ok("Removed the deprecated @synsci/cli")
    } else {
      s.warn(`Couldn't remove the deprecated @synsci/cli — if install fails, run: ${CYAN}npm rm -g @synsci/cli${RESET}`)
    }
  }

  let cliPath = resolveCli()
  if (cliPath) {
    const raw = runFileQuiet(cliPath, ["--version"]) || "unknown"
    const isDev = raw === "local" || raw.includes("-")
    if (isDev) {
      ok(`openscience ${DIM}(dev build)${RESET}`)
    } else {
      const s = spinner("Checking for updates...")
      const current = raw.replace(/[^0-9.]/g, "")
      const latest = runQuiet(`npm view @synsci/openscience@${OPENSCIENCE_NPM_TAG} version`)
      if (!latest || current === latest) {
        s.ok(`openscience ${current} ${DIM}(up to date)${RESET}`)
      } else {
        s.update(`Upgrading ${current} → ${latest}...`)
        if (process.platform !== "darwin") {
          try {
            execCli(cliPath, ["upgrade", latest], { stdio: "pipe" })
            s.ok(`Upgraded to ${latest}`)
          } catch {
            s.warn(`Upgrade failed, continuing with ${current}`)
          }
        }
        if (process.platform === "darwin") {
          // A macOS CLI self-upgrade replaces its running native executable
          // and immediately probes the replacement. A malformed signature can
          // hang that probe in an uninterruptible kernel wait, so install with
          // npm and resolve the new executable through the entitlement gate.
          cliPath = null
          try {
            execFileSync("npm", ["i", "-g", `@synsci/openscience@${latest}`], { stdio: "pipe" })
            cliPath = resolveCli()
            if (!cliPath) throw new Error("updated OpenScience failed validation")
            const upgraded = runFileQuiet(cliPath, ["--version"])
            if (upgraded !== latest) throw new Error("updated OpenScience version mismatch")
            s.ok(`Upgraded to ${latest}`)
          } catch {
            // npm may have replaced only part of the old package before
            // failing. Never reuse the pre-install path; resolve and preflight
            // every surviving candidate again.
            cliPath = resolveCli()
            if (!cliPath) {
              s.fail("Upgrade failed and no safe OpenScience installation remains")
              process.exit(1)
            }
            const fallback = runFileQuiet(cliPath, ["--version"]) || "a safe installed version"
            s.warn(`Upgrade failed, continuing with ${fallback}`)
          }
        }
      }
    }
  } else {
    const s = spinner("Installing OpenScience...")
    try {
      try {
        execSync(`npm i -g ${OPENSCIENCE_NPM_SPEC}`, { stdio: "pipe" })
      } catch (e) {
        // npm refuses to overwrite a bin file owned by another package
        // (EEXIST). If the conflict is the deprecated @synsci/cli, remove it
        // and retry once before falling back to the standalone installer.
        const stderr = e && e.stderr ? String(e.stderr) : ""
        const conflict = stderr.includes("EEXIST") && (stderr.includes("@synsci/cli") || hasDeprecatedCli())
        if (!conflict) throw e
        s.update("Removing the deprecated @synsci/cli so it can't shadow the openscience command...")
        runQuiet("npm rm -g @synsci/cli")
        s.update("Retrying the OpenScience install...")
        execSync(`npm i -g ${OPENSCIENCE_NPM_SPEC}`, { stdio: "pipe" })
      }
      cliPath = resolveCli()
      if (!cliPath) throw new Error("openscience not on PATH after install")
      s.ok("Installed OpenScience")
    } catch {
      // The remote installer performs its own unbounded `openscience
      // --version` check. Discovering a command is harmless; running the
      // installer while one is present is not, because it could be the stale
      // or unentitled candidate that sent us into recovery.
      const existing = process.platform === "win32" ? null : runQuiet("command -v openscience")
      if (existing) {
        s.fail("Install failed; refusing to execute an existing unverified openscience command")
        console.log(`\n  Try manually: ${CYAN}npm i -g ${OPENSCIENCE_NPM_SPEC}${RESET}\n`)
        process.exit(1)
      }
      // The current standalone installer probes any `openscience` already on
      // PATH before replacing it. On macOS that can execute the same rejected
      // binary whose signature sent us into recovery, so don't delegate to the
      // remote installer until it can perform an equivalent preflight.
      if (process.platform === "win32" || process.platform === "darwin" || process.env.OPENSCIENCE_TEST_HOME) {
        s.fail("Install failed")
        console.log(`\n  Try manually: ${CYAN}npm i -g ${OPENSCIENCE_NPM_SPEC}${RESET}\n`)
        process.exit(1)
      }
      // Global npm installs commonly fail on permissions. The standalone
      // installer lands in ~/.openscience/bin without sudo (resolveCli already
      // checks that location), but it is a remote script piped into bash, so
      // it only runs with explicit consent. Otherwise print the manual
      // commands and stop.
      s.warn("npm -g install failed")
      if (!(await installerConsent())) {
        console.log(`\n  Try manually: ${CYAN}npm i -g ${OPENSCIENCE_NPM_SPEC}${RESET}`)
        console.log(`  or:           ${CYAN}${STANDALONE_INSTALL}${RESET}`)
        console.log(`  or rerun with ${CYAN}--allow-installer${RESET} to let synsci run the standalone installer\n`)
        process.exit(1)
      }
      const t = spinner("Running the standalone installer...")
      try {
        execSync("/usr/bin/curl -fsSL https://openscience.sh/install | /bin/bash", {
          stdio: "pipe",
          env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        })
        cliPath = resolveCli()
        if (!cliPath) throw new Error("openscience not found after install")
        t.ok("Installed OpenScience")
      } catch (e2) {
        t.fail(`Install failed${e2 && e2.message ? ": " + e2.message : ""}`)
        console.log(`\n  Try manually: ${CYAN}npm i -g ${OPENSCIENCE_NPM_SPEC}${RESET}`)
        console.log(`  or:           ${CYAN}${STANDALONE_INSTALL}${RESET}\n`)
        process.exit(1)
      }
    }
  }
  if (isLauncherPath(cliPath)) {
    console.error("synsci: the resolved openscience command is the launcher itself; refusing to recurse")
    process.exit(2)
  }

  // --- Step 2: Connect this device ---
  if (isConnected()) {
    ok("Connected to Synthetic Sciences")
  } else {
    console.log()
    try {
      execCli(cliPath, ["login"], { stdio: "inherit", env: cliEnv() })
    } catch {
      warn("Synthetic Sciences sign-in did not finish")
      process.exit(1)
    }
    if (!isConnected()) {
      warn("A Synthetic Sciences account is required before the workspace can open")
      process.exit(1)
    }
    ok("Connected to Synthetic Sciences")
  }
  console.log()

  // --- Step 3: Launch the workspace ---
  console.log(`  ${DIM}Opening the workspace in your browser…${RESET}`)
  console.log()

  const webArgs = ["web", ...ARGS]
  const child = isCmdShim(cliPath)
    ? spawn(cmdLine(cliPath, webArgs), { stdio: "inherit", shell: true, env: cliEnv() })
    : spawn(cliPath, webArgs, { stdio: "inherit", env: cliEnv() })
  child.on("close", (code, signal) => {
    // A child killed by a signal has no exit code; report it as the shell
    // would (128 + signal number) instead of a silent success.
    if (signal) {
      console.error(`synsci: openscience exited on ${signal}`)
      process.exit(128 + (constants.signals[signal] ?? 0))
    }
    process.exit(code ?? 1)
  })
}

main().catch((err) => {
  process.stdout.write(SHOW_CURSOR)
  console.error(err)
  process.exit(1)
})
