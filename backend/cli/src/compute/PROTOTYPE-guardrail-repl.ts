#!/usr/bin/env bun
/**
 * PROTOTYPE — throwaway TUI. Run:  cd backend/cli && bun run prototype:guardrail
 *
 * Drives the managed-compute guardrail state machine in
 * PROTOTYPE-guardrail-model.ts. See that file for the question this answers.
 *
 * POST /leases and /release are FAKED — the real ones provision GPUs and bill
 * real money. GET /options and POST /estimate are free, so [o] hits them for
 * real to verify response shapes (needs ATLAS_TOKEN + optional ATLAS_BASE).
 *
 * This shell is disposable. The model next door is the liftable part.
 */
import {
  decide,
  evaluate,
  attemptRelease,
  spend,
  overrunHours,
  quoteTotal,
  formatCents,
  formatHours,
  MAX_RELEASE_ATTEMPTS,
  type Proposal,
  type Quote,
  type GateMode,
  type Lease,
  type World,
  type Verdict,
} from "./PROTOTYPE-guardrail-model"

const B = "\x1b[1m"
const D = "\x1b[2m"
const R = "\x1b[0m"
const G = "\x1b[32m"
const Y = "\x1b[33m"
const RED = "\x1b[31m"
const C = "\x1b[36m"
const INV = "\x1b[7m"

const HOUR = 3_600_000

// A plausible managed H100 rate, from the Modal table in the Atlas source.
let quote: Quote = { funding: "managed", rateCentsPerHour: 699, balanceCents: 1500 }
let proposal: Proposal = { provider: "lambda", sku: "gpu_1x_h100_pcie", hours: 4 }
let mode: GateMode = "first-hour"
let world: World = {
  serverEnforcesDeadline: false,
  clientAlive: true,
  releaseFails: false,
  planTtlHours: 24,
}
let verdict: Verdict | null = null
let lease: Lease | null = null
let now = Date.now()
let realProbe: string[] = []
let log: string[] = []

function say(line: string) {
  log.unshift(line)
  log = log.slice(0, 6)
}

function launch() {
  verdict = decide({ proposal, quote, planTtlHours: world.planTtlHours, mode })
  if (!verdict.ok) {
    say(`${RED}REJECTED${R} ${verdict.code} — ${verdict.message}`)
    if (verdict.remedy)
      say(
        `  ${D}remedy the agent can act on:${R} propose ≤ ${formatHours(verdict.remedy.affordableHours)} ` +
          `(needs ${formatCents(verdict.remedy.neededCents)}, has ${formatCents(verdict.remedy.availableCents)})`,
      )
    lease = null
    return
  }
  lease = {
    id: `lease-${Math.abs(now % 100000)}`,
    rateCentsPerHour: quote.funding === "byok" ? 0 : quote.rateCentsPerHour,
    approvedHours: verdict.approvedHours,
    startedAtMs: now,
    // The server only records a deadline if we build that column.
    expiresAtMs: world.serverEnforcesDeadline ? now + verdict.approvedHours * HOUR : undefined,
    phase: "running",
    spentCents: 0,
    releaseAttempts: 0,
  }
  const clamp = verdict.clampedFrom ? ` ${Y}(clamped from ${formatHours(verdict.clampedFrom)})${R}` : ""
  say(
    `${G}APPROVED${R} ${formatHours(verdict.approvedHours)}${clamp} — ` +
      `${verdict.billed ? formatCents(verdict.costCents) : "free (BYOK)"}`,
  )
}

function tick(hours: number) {
  now += hours * HOUR
  if (!lease || lease.phase === "released" || lease.phase === "orphaned") return
  lease.spentCents = spend(lease, now)
  const action = evaluate(lease, now, world)
  if (action.kind === "server-releases") {
    lease.phase = "released"
    lease.note = action.why
    say(`${G}server released${R} — ${action.why} · billed ${formatCents(lease.spentCents)}`)
  } else if (action.kind === "client-should-release") {
    lease.phase = "past-deadline"
    say(`${Y}deadline passed${R} — ${action.why}. Press [r] to release.`)
  } else if (action.kind === "nobody-will-release") {
    lease.phase = "orphaned"
    lease.note = action.why
    say(`${RED}${INV} ORPHANED ${R} ${action.why}`)
    say(`  ${RED}projected extra spend: ${formatCents(action.exposureCents)}${R}`)
  }
}

function release() {
  if (!lease || lease.phase === "released") return say(`${D}nothing to release${R}`)
  lease.releaseAttempts++
  const res = attemptRelease(lease, world)
  if (res.ok) {
    lease.phase = "released"
    lease.spentCents = spend(lease, now)
    say(`${G}released${R}${res.already ? " (409 already — still success)" : ""} · billed ${formatCents(lease.spentCents)}`)
    return
  }
  say(`${RED}release failed${R} (attempt ${lease.releaseAttempts}/${MAX_RELEASE_ATTEMPTS}) — ${res.message}`)
  if (lease.releaseAttempts >= MAX_RELEASE_ATTEMPTS) {
    lease.phase = "orphaned"
    lease.note = "release failed repeatedly — fail closed, surface loudly"
    say(`${RED}${INV} FAIL CLOSED ${R} gave up after ${MAX_RELEASE_ATTEMPTS} — must alert, never assume cleanup`)
  }
}

async function probeReal() {
  const base = process.env["ATLAS_BASE"] || "https://app.syntheticsciences.ai"
  const token = process.env["ATLAS_TOKEN"]
  realProbe = [`${D}base ${base}${R}`]
  if (!token) {
    realProbe.push(`${Y}set ATLAS_TOKEN=thk_… to probe the real (free) endpoints${R}`)
    return
  }
  for (const [label, path, body] of [
    ["GET  /api/compute/options", "/api/compute/options", null],
    ["POST /api/compute/estimate", "/api/compute/estimate", { provider: proposal.provider, sku: proposal.sku }],
  ] as const) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = (await res.text()).slice(0, 160).replace(/\s+/g, " ")
      realProbe.push(`${res.ok ? G : RED}${res.status}${R} ${label}  ${D}${text}${R}`)
    } catch (err) {
      realProbe.push(`${RED}ERR${R} ${label}  ${D}${err instanceof Error ? err.message : String(err)}${R}`)
    }
  }
}

function render() {
  console.clear()
  console.log(`${B}managed-compute guardrail — state-machine prototype${R}`)
  console.log(`${D}Q: does agent-proposes / Atlas-decides hold up? who enforces the deadline?${R}\n`)

  const total = quoteTotal(quote.rateCentsPerHour, Math.min(proposal.hours, world.planTtlHours))
  console.log(
    `${B}PROPOSAL${R}  ${proposal.sku} ${D}on${R} ${proposal.provider}  ` +
      `${C}${formatHours(proposal.hours)}${R}  ${D}→ ${formatCents(total)} at ${formatCents(quote.rateCentsPerHour)}/h${R}`,
  )
  console.log(
    `${B}WALLET${R}    ${formatCents(quote.balanceCents)}   ${B}FUNDING${R} ${quote.funding}   ` +
      `${B}PLAN TTL${R} ${world.planTtlHours}h`,
  )
  console.log(
    `${B}GATE${R}      ${mode === "first-hour" ? `${Y}first-hour (Atlas today)${R}` : `${G}total (proposed)${R}`}` +
      `   ${B}SERVER DEADLINE${R} ${world.serverEnforcesDeadline ? `${G}yes${R}` : `${RED}no (Atlas today)${R}`}` +
      `   ${B}CLIENT${R} ${world.clientAlive ? `${G}alive${R}` : `${RED}dead${R}`}` +
      `   ${B}RELEASE${R} ${world.releaseFails ? `${RED}failing${R}` : `${G}ok${R}`}\n`,
  )

  if (lease) {
    const el = (now - lease.startedAtMs) / HOUR
    const over = overrunHours(lease, now)
    const phase =
      lease.phase === "running"
        ? `${G}running${R}`
        : lease.phase === "past-deadline"
          ? `${Y}past-deadline${R}`
          : lease.phase === "released"
            ? `${D}released${R}`
            : `${RED}${INV} ORPHANED ${R}`
    console.log(`${B}LEASE${R} ${lease.id}  ${phase}`)
    console.log(
      `  ${D}approved${R} ${formatHours(lease.approvedHours)}   ${D}elapsed${R} ${formatHours(el)}` +
        (over > 0 ? `   ${RED}overrun ${formatHours(over)}${R}` : "") +
        `   ${D}billed${R} ${formatCents(spend(lease, now))}`,
    )
    if (lease.note) console.log(`  ${D}${lease.note}${R}`)
  } else console.log(`${D}no lease — press [enter] to submit the proposal${R}`)

  if (realProbe.length) {
    console.log(`\n${B}REAL API PROBE${R} ${D}(free endpoints only)${R}`)
    for (const l of realProbe) console.log(`  ${l}`)
  }

  if (log.length) {
    console.log(`\n${B}LOG${R}`)
    for (const l of log) console.log(`  ${l}`)
  }

  console.log(
    `\n${D}[h/H] hours -/+   [b/B] wallet -/+   [g] gate mode   [s] server deadline   [x] kill client` +
      `\n[f] release failure   [enter] submit   [t] +1h   [T] +6h   [r] release   [o] probe real   [n] reset   [q] quit${R}`,
  )
}

function reset() {
  now = Date.now()
  lease = null
  verdict = null
  log = []
  say(`${D}reset${R}`)
}

async function main() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    console.error("This prototype is interactive — run it in a terminal:\n  bun run prototype:guardrail\n")
    process.exit(1)
  }
  process.stdin.setRawMode(true)
  process.stdin.resume()
  render()
  for await (const chunk of process.stdin) {
    const k = chunk.toString()
    if (k === "q" || k === "") break
    if (k === "h") proposal.hours = Math.max(0.5, proposal.hours - 0.5)
    else if (k === "H") proposal.hours = Math.min(48, proposal.hours + 0.5)
    else if (k === "b") quote.balanceCents = Math.max(0, quote.balanceCents - 500)
    else if (k === "B") quote.balanceCents += 500
    else if (k === "g") mode = mode === "first-hour" ? "total" : "first-hour"
    else if (k === "s") world.serverEnforcesDeadline = !world.serverEnforcesDeadline
    else if (k === "x") world.clientAlive = !world.clientAlive
    else if (k === "f") world.releaseFails = !world.releaseFails
    else if (k === "\r" || k === "\n") launch()
    else if (k === "t") tick(1)
    else if (k === "T") tick(6)
    else if (k === "r") release()
    else if (k === "n") reset()
    else if (k === "o") {
      say(`${D}probing real endpoints…${R}`)
      render()
      await probeReal()
    }
    render()
  }
  process.stdin.setRawMode(false)
  console.clear()
  console.log("prototype exited\n")
  process.exit(0)
}

main()
