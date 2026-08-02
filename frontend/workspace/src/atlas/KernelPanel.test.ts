import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./KernelPanel.tsx", import.meta.url)), "utf8")
const card = () => readFileSync(fileURLToPath(new URL("./KernelCard.tsx", import.meta.url)), "utf8")
const styles = () => readFileSync(fileURLToPath(new URL("./ComputeSurface.css", import.meta.url)), "utf8")

describe("kernel control room", () => {
  test("makes session ownership and runtime identity explicit", () => {
    const panel = `${source()}\n${card()}`

    expect(panel).toContain('aria-label="Session kernel control room"')
    expect(panel).toContain("data-kernel-owner={owner()}")
    expect(panel).toContain('class="kernel-card__identity"')
    expect(panel).toContain("kernel.projectID")
    expect(panel).toContain("kernel.sessionID")
    expect(panel).toContain("kernel.id")
  })

  test("keeps ownership guidance compact and inline", () => {
    const panel = source()

    expect(panel).toContain("<strong>Session-owned kernels.</strong>")
    expect(panel).not.toContain("Project inventory")
  })

  test("exposes the complete lifecycle controls backed by current routes", () => {
    const panel = `${source()}\n${card()}`

    expect(panel).toContain('"interrupt" | "restart" | "stop" | "delete"')
    expect(panel).toContain("sdk.request(path, init, query)")
    expect(panel).toContain("remove ? { sessionID: kernel.sessionID } : undefined")
    expect(panel).toContain("kernelCanInterrupt")
    expect(panel).toContain("kernelCanStop")
    expect(panel).toContain("kernelCanForget")
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
    expect(panel).toContain('action === "restart" && !authority.allowed()')
    expect(panel).toContain("restartDisabled={!authority.allowed()}")
    expect(panel).toContain("disabled={!!props.action || props.restartDisabled}")
    expect(panel).toContain("disabled={!!props.action || !kernelCanStop(props.kernel)}")
    expect(panel).toContain("disabled={!!props.action || !kernelCanInterrupt(props.kernel)}")
  })

  test("explains state preservation and recovery after controls complete", () => {
    const panel = `${source()}\n${card()}`

    expect(panel).toContain("Runtime state was preserved.")
    expect(panel).toContain("Previous in-memory variables and queued work were cleared.")
    expect(panel).toContain("every in-memory variable and queued")
    expect(panel).toContain("cell is lost")
    expect(panel).toContain('class="kernel-card__recovery"')
    expect(panel).toContain('role="status"')
  })

  test("uses the canonical runtime shape without local stale-state or nullability patches", () => {
    const panel = source()
    const runtime = readFileSync(fileURLToPath(new URL("../notebook/runtime.ts", import.meta.url)), "utf8")

    expect(panel).toContain("{ sessionID: params.id }")
    expect(panel).not.toContain("Omit<KernelStatus")
    expect(panel).not.toContain("legacy")
    expect(runtime).toContain('"lazy" | "starting" | "idle" | "running" | "stopped" | "crashed"')
    expect(runtime).toContain("incarnation: number | null")
    expect(runtime).toContain("process_identity_verified: boolean | null")
  })

  test("keeps the invoked compute control room compact and softly grouped", () => {
    const css = styles()

    expect(css).toMatch(/\.compute-surface \.kernel-panel__header\s*\{[^}]*min-height: 48px/s)
    expect(css).toMatch(/\.compute-surface \.kernel-panel__heading strong\s*\{[^}]*font-size: 15px/s)
    expect(css).toMatch(/\.compute-surface \.kernel-panel__scope\s*\{[^}]*background: transparent/s)
    expect(css).toMatch(/\.compute-surface \.kernel-card\s*\{[^}]*padding: 12px/s)
    expect(css).toMatch(/\.compute-surface \.kernel-card\s*\{[^}]*border-radius: 12px/s)
    expect(css).toMatch(/\.compute-surface \.kernel-card\s*\{[^}]*box-shadow: none/s)
    expect(css).toMatch(/\.compute-surface \.kernel-card__metric\s*\{[^}]*min-height: 40px/s)
  })

  test("materializes a new session and refreshes only while kernels are active", () => {
    const panel = source()

    expect(panel).toContain("props.onEnsureSession?.()")
    expect(panel).toContain("const sessionID = await ensureSession()")
    expect(panel).toContain("summary().running === 0 && summary().queued === 0")
    expect(panel).not.toContain('disabled={!params.id || params.id === "new"')
  })
})
