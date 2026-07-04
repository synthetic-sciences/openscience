#!/usr/bin/env node

// `npx synsci`: the OpenScience install wizard.
//
// The npm package (and this bin) keep the historical `synsci` name so the
// one-liner everyone knows keeps working; everything it installs is the
// OpenScience CLI (`@synsci/openscience`, binary `openscience`), optionally with the
// Atlas managed platform on top.

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
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const SELF_PATH = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return "" }
})()

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
  " ██████╗ ██████╗ ███████╗███╗   ██╗",
  "██╔═══██╗██╔══██╗██╔════╝████╗  ██║",
  "██║   ██║██████╔╝█████╗  ██╔██╗ ██║",
  "██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║",
  "╚██████╔╝██║     ███████╗██║ ╚████║",
  " ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝",
  "███████╗ ██████╗██╗███████╗███╗   ██╗ ██████╗███████╗",
  "██╔════╝██╔════╝██║██╔════╝████╗  ██║██╔════╝██╔════╝",
  "███████╗██║     ██║█████╗  ██╔██╗ ██║██║     █████╗  ",
  "╚════██║██║     ██║██╔══╝  ██║╚██╗██║██║     ██╔══╝  ",
  "███████║╚██████╗██║███████╗██║ ╚████║╚██████╗███████╗",
  "╚══════╝ ╚═════╝╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝",
]

function ok(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`) }
function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`) }

function spinner(msg) {
  const frames = ["◒", "◐", "◓", "◑"]
  let i = 0
  process.stdout.write(HIDE_CURSOR)
  const id = setInterval(() => {
    process.stdout.write(`${CLEAR_LINE}  ${CYAN}${frames[i++ % frames.length]}${RESET} ${msg}`)
  }, 80)
  return {
    ok(result) { clearInterval(id); process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`); ok(result) },
    warn(result) { clearInterval(id); process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`); warn(result) },
    fail(result) { clearInterval(id); process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`); console.log(`  ${RED}✗${RESET} ${result}`) },
    update(m) { msg = m },
  }
}

function runQuiet(cmd) {
  try { return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim() }
  catch { return null }
}

function runFileQuiet(file, args = []) {
  try { return execFileSync(file, args, { encoding: "utf-8", stdio: "pipe" }).trim() }
  catch { return null }
}

function isLauncherPath(p) {
  try {
    const real = realpathSync(p)
    if (SELF_PATH && real === SELF_PATH) return true
    if (real.includes("/_npx/")) return true
    return false
  } catch { return false }
}

// Returns the absolute path to the real @synsci/openscience binary (`openscience`).
// Only trusts canonical install locations (no `$PATH` walk) to avoid picking
// up dev shims or workspace symlinks. Each candidate is verified by invoking
// `--version` so half-broken installs are skipped instead of accepted.
function resolveCli() {
  const candidates = []
  // 1. Global npm prefix (where `npm i -g @synsci/openscience` puts it)
  const prefix = runQuiet("npm prefix -g")
  if (prefix) candidates.push(join(prefix, "bin", "openscience"))
  // 2. ~/.openscience/bin/openscience (curl-installer location)
  candidates.push(join(homedir(), ".openscience", "bin", "openscience"))

  for (const cand of candidates) {
    if (!existsSync(cand) || isLauncherPath(cand)) continue
    try {
      const ver = execFileSync(cand, ["--version"], {
        encoding: "utf-8", stdio: "pipe", timeout: 5000,
      }).trim()
      if (/^\d/.test(ver)) return cand
    } catch { /* unrunnable candidate, try next */ }
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
  try { out = execSync("npm ls -g @synsci/cli --depth=0 --json", { encoding: "utf-8", stdio: "pipe" }) }
  catch (e) { out = e && typeof e.stdout === "string" ? e.stdout : "" }
  try { return Boolean(JSON.parse(out).dependencies["@synsci/cli"]) }
  catch { return false }
}

function isConnected() {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const sessionPath = join(xdgData, "openscience", "openscience-session.json")
  if (!existsSync(sessionPath)) return false
  try {
    const data = JSON.parse(readFileSync(sessionPath, "utf-8"))
    if (!data.access_token || !data.expires_at) return false
    return new Date(data.expires_at) > new Date()
  } catch { return false }
}

function hasAtlas() {
  return runQuiet("atlas --version") !== null
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()) })
  })
}

async function main() {
  process.on("exit", () => process.stdout.write(SHOW_CURSOR))
  process.on("SIGINT", () => { process.stdout.write(SHOW_CURSOR); process.exit(130) })

  // --- Logo ---
  console.log()
  for (const line of LOGO) console.log(`   ${CYAN}${line}${RESET}`)
  console.log()
  console.log(`   ${BOLD}OpenScience${RESET} ${DIM}the open-source AI research workspace${RESET}`)
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
      const latest = runQuiet("npm view @synsci/openscience version")
      if (!latest || current === latest) {
        s.ok(`openscience ${current} ${DIM}(up to date)${RESET}`)
      } else {
        s.update(`Upgrading ${current} → ${latest}...`)
        try {
          execFileSync(cliPath, ["upgrade"], { stdio: "pipe" })
          s.ok(`Upgraded to ${latest}`)
        } catch {
          s.warn(`Upgrade failed, continuing with ${current}`)
        }
      }
    }
  } else {
    const s = spinner("Installing OpenScience...")
    try {
      try {
        execSync("npm i -g @synsci/openscience@latest", { stdio: "pipe" })
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
        execSync("npm i -g @synsci/openscience@latest", { stdio: "pipe" })
      }
      cliPath = resolveCli()
      if (!cliPath) throw new Error("openscience not on PATH after install")
      s.ok("Installed OpenScience")
    } catch {
      // Global npm installs commonly fail on permissions. Fall back to the
      // standalone installer, which lands in ~/.openscience/bin without sudo
      // (resolveCli already checks that location).
      s.update("npm -g failed, trying the standalone installer...")
      try {
        execSync("curl -fsSL https://openscience.sh/install | bash", { stdio: "pipe" })
        cliPath = resolveCli()
        if (!cliPath) throw new Error("openscience not found after install")
        s.ok("Installed OpenScience")
      } catch (e2) {
        s.fail(`Install failed${e2 && e2.message ? ": " + e2.message : ""}`)
        console.log(`\n  Try manually: ${CYAN}npm i -g @synsci/openscience${RESET}`)
        console.log(`  or:           ${CYAN}curl -fsSL https://openscience.sh/install | bash${RESET}\n`)
        process.exit(1)
      }
    }
  }

  // --- Step 2: Choose a setup ---
  console.log()
  console.log(`  ${BOLD}How do you want to run it?${RESET}`)
  console.log()
  console.log(`    ${BOLD}1${RESET}  ${CYAN}OpenScience${RESET}         ${DIM}free and open source, bring your own API keys, no account${RESET}`)
  console.log(`    ${BOLD}2${RESET}  ${CYAN}OpenScience + Atlas${RESET} ${DIM}managed models, wallet billing, research graph & compute${RESET}`)
  console.log()

  const setup = await ask(`  ${DIM}❯${RESET} Choose [1/2]: `)
  console.log()

  if (setup === "2") {
    if (!hasAtlas()) {
      const s = spinner("Installing Atlas CLI...")
      try {
        execSync("npm i -g @synsci/atlas@latest", { stdio: "pipe" })
        s.ok("Installed Atlas CLI")
      } catch {
        s.warn(`Atlas CLI install failed, you can retry later: ${CYAN}npm i -g @synsci/atlas${RESET}`)
      }
    } else {
      ok("Atlas CLI already installed")
    }
    if (isConnected()) {
      ok("Connected to Atlas")
    } else {
      console.log()
      try {
        execFileSync(cliPath, ["connect", "login"], { stdio: "inherit" })
      } catch {}
    }
  } else {
    ok(`BYOK mode ${DIM}add provider keys inside the app (or via env vars like ANTHROPIC_API_KEY)${RESET}`)
  }

  console.log()

  // --- Step 3: Launch the workspace ---
  console.log(`  ${DIM}Opening the workspace in your browser…${RESET}`)
  console.log()

  const child = spawn(cliPath, ["web", ...process.argv.slice(2)], { stdio: "inherit" })
  child.on("close", (code) => process.exit(code ?? 0))
}

main().catch((err) => {
  process.stdout.write(SHOW_CURSOR)
  console.error(err)
  process.exit(1)
})
