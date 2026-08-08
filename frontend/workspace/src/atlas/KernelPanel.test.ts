import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./KernelPanel.tsx", import.meta.url)), "utf8")
const card = () => readFileSync(fileURLToPath(new URL("./KernelCard.tsx", import.meta.url)), "utf8")
const styles = () => readFileSync(fileURLToPath(new URL("./ComputeSurface.css", import.meta.url)), "utf8")

describe("kernel control room", () => {
  test("makes project and session ownership plus runtime identity explicit", () => {
    const panel = `${source()}\n${card()}`

    expect(panel).toContain('aria-label="Project kernel control room"')
    expect(panel).toContain('class="kernel-session"')
    expect(panel).toContain("Current session")
    expect(panel).toContain("data-kernel-owner={owner()}")
    expect(panel).toContain('class="kernel-card__identity"')
    expect(panel).toContain("kernel.projectID")
    expect(panel).toContain("kernel.sessionID")
    expect(panel).toContain("kernel.id")
  })

  test("keeps ownership guidance compact and inline", () => {
    const panel = source()

    // Stated as prose rather than as a bolded callout with an icon — this is
    // how kernels work, not a warning about them.
    expect(panel).toContain("Only process-backed runtimes count as kernels.")
    expect(panel).toContain("Named environments survive app restarts")
    expect(panel).not.toContain("<strong>Session-owned kernels.</strong>")
    expect(panel).not.toContain("Project inventory")
  })

  test("exposes the complete lifecycle controls backed by current routes", () => {
    const panel = `${source()}\n${card()}`

    expect(panel).toContain('"interrupt" | "restart" | "stop" | "delete"')
    expect(panel).toContain("transport(path, init, query)")
    expect(panel).toContain("remove ? { sessionID: kernel.sessionID } : undefined")
    expect(panel).toContain("kernelCanInterrupt")
    expect(panel).toContain("kernelCanStop")
    expect(panel).toContain("kernelCanForget")
    expect(panel).toContain("if (!body) return undefined as T")
    expect(panel).toContain("aria-label={`Restart ${kernelLabel(props.kernel)}`}")
    expect(panel).toContain("aria-label={`Stop ${kernelLabel(props.kernel)}`}")
    expect(panel).toContain("aria-label={`Forget ${kernelLabel(props.kernel)}`}")
    expect(panel).toContain('request<KernelStatus>("/notebook/kernels"')
    expect(panel).toContain('aria-label="Create named kernel"')
    expect(panel).toContain('value="python">Python')
    expect(panel).toContain('value="r">R')
  })

  test("uses backend authority only for process-starting restart actions", () => {
    const panel = `${source()}\n${card()}`

    expect(panel).toContain('useExecutionAuthority("kernel")')
    expect(panel).toContain('if (action === "restart")')
    expect(panel).toContain("kernel.sessionID !== route()")
    expect(panel).toContain("restartDisabled={kernel.sessionID !== route() || !authority.allowed()}")
    expect(panel).toContain("disabled={!!props.action || props.restartDisabled}")
    expect(panel).toContain("disabled={!!props.action || !kernelCanStop(props.kernel)}")
    expect(panel).toContain("disabled={!!props.action || !kernelCanInterrupt(props.kernel)}")
  })

  test("explains state preservation and recovery after controls complete", () => {
    const panel = `${source()}\n${card()}`

    expect(panel).toContain("Runtime state was preserved.")
    expect(panel).toContain("Previous in-memory variables and queued work were cleared.")
    // The standing paragraph under the controls is gone with the 3a plate;
    // the same warning rides on the button that causes the loss.
    expect(panel).toContain("All in-memory variables and queued cells will be lost.")
    expect(panel).not.toContain('class="kernel-card__control-note"')
    expect(panel).toContain('class="kernel-card__recovery"')
    expect(panel).toContain('role="status"')
  })

  test("uses the canonical runtime shape without local stale-state or nullability patches", () => {
    const panel = source()
    const runtime = readFileSync(fileURLToPath(new URL("../notebook/runtime.ts", import.meta.url)), "utf8")

    // The inventory is project-wide, while the route only marks the current
    // session and gates process-starting controls.
    expect(panel).toContain("{ client }")
    expect(panel).not.toContain("{ sessionID: params.id, client }")
    expect(panel).not.toContain("Omit<KernelStatus")
    expect(panel).not.toContain("legacy")
    expect(runtime).toContain('"lazy" | "starting" | "idle" | "running" | "stopped" | "crashed"')
    expect(runtime).toContain("incarnation: number | null")
    expect(runtime).toContain("process_identity_verified: boolean | null")
  })

  test("keeps kernel cards mounted when project inventory polls", () => {
    const panel = source()

    // Session ids are stable primitives. Rebuilding wrapper objects here makes
    // Solid remount every session group on each poll and collapses an expanded
    // kernel card while the user is reading it.
    expect(panel).toContain("[...grouped().keys()].sort")
    expect(panel).toContain("<For each={groups()}>")
    expect(panel).toContain("{(sessionID) => (")
    expect(panel).not.toContain(".map(([sessionID, items]) => ({")
  })

  test("nests the kernel as its own card with a printed-record metric grid", () => {
    const css = styles()

    expect(css).toMatch(/\.compute-surface \.kernel-panel__header\s*\{[^}]*min-height: 48px/s)
    expect(css).toMatch(/\.compute-surface \.kernel-panel__scope\s*\{[^}]*background: transparent/s)
    // The runtime is a distinct object with its own controls, so it sits in an
    // inset card rather than flat on the panel.
    expect(css).toMatch(/\.compute-surface \.kernel-card\s*\{[^}]*border-radius: 18px/s)
    expect(css).toMatch(/\.compute-surface \.kernel-card\s*\{[^}]*background: var\(--color-bg-elevated\)/s)
    // Label and value joined by a dotted leader, as a printed record sets them.
    expect(css).toMatch(/\.compute-surface \.kernel-card__metric::after\s*\{[^}]*border-bottom: 1px dotted/s)
    expect(css).toMatch(/\.compute-surface \.kernel-card__metrics\b[^{]*\{[^}]*grid-template-columns: 1fr 1fr/s)
    // Only Stop carries a colour, because it is the one that discards work.
    expect(css).toMatch(/\.compute-surface \.kernel-card__stop\s*\{[^}]*color: var\(--color-error\)/s)
    // No hardcoded colour: the app ships 16 themes.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })

  test("materializes a new session and polls unconditionally while mounted", () => {
    const panel = source()

    expect(panel).toContain("props.onEnsureSession?.()")
    expect(panel).toContain("const sessionID = await ensureSession()")
    // Regression guard for the chicken-and-egg bug: a fresh session starts at
    // {live: 0, running: 0, queued: 0}, so gating the poll on summary() meant
    // the poll that would discover a kernel starting never began. The panel
    // must poll unconditionally, the way HostStrip.tsx does — skipping only
    // while the tab is hidden, and refreshing immediately on visibilitychange.
    expect(panel).not.toContain("summary().running === 0 && summary().queued === 0")
    expect(panel).toContain("if (document.hidden) return")
    expect(panel).toContain("setInterval(refresh, 2_500)")
    expect(panel).toContain('document.addEventListener("visibilitychange", refresh)')
    expect(panel).toContain('document.removeEventListener("visibilitychange", refresh)')
    expect(panel).not.toContain('disabled={!params.id || params.id === "new"')
  })

  test("takes its transport as an injectable prop, defaulting to the session SDK", () => {
    const panel = source()

    expect(panel).toContain("request?: (path: string, init?: RequestInit, query?: Record<string, string>)")
    expect(panel).toContain("const transport = props.request ?? useSDK().request")
  })

  test("names the empty state for live kernels across the project", () => {
    const panel = source()

    expect(panel).toContain("No live kernels")
    expect(panel).toContain("Kernels appear here when any session in this project starts a runtime.")
    expect(panel).not.toContain("on this machine")
  })

  test("routes every poll through the fetcher that resolves instead of rejecting", () => {
    const panel = source()

    // The behaviour itself is asserted in KernelPanel.poll.test.ts against the
    // real `inventory`; this pins load() to it. A fetcher that rejects leaves
    // an errored resource for `data.latest` to re-throw on the render path,
    // and app.tsx's ErrorBoundary — the only one in the app — replaces the
    // entire workspace with the error page.
    expect(panel).toContain("return inventory(")
    expect(panel).not.toContain("throw error")
  })

  test("says the list is unreadable rather than empty when a poll failed", () => {
    const panel = source()

    // An empty list after a failed poll is not "No live kernels" — the panel
    // does not know that. Degrading visibly is the difference between a poll
    // that failed and a project that is genuinely idle.
    expect(panel).toContain('{view.error ? "Kernel inventory unavailable" : "No live kernels"}')
    expect(panel).toContain("The last poll could not read this project's kernels")
    expect(panel).toContain("Kernel inventory unavailable. ${view.error}")
  })
})
