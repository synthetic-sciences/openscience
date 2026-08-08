import { describe, expect, test } from "bun:test"
import {
  kernelCanInterrupt,
  kernelCanForget,
  kernelCanStop,
  kernelAtlasLabel,
  kernelCpuLabel,
  kernelEnvironmentLabel,
  kernelNetworkLabel,
  kernelNetworkTone,
  kernelEnvironmentTone,
  kernelGpuLabel,
  kernelLabel,
  kernelLanguageLabel,
  kernelMemoryLabel,
  kernelOwnershipLabel,
  kernelRecoveryLabel,
  kernelStateLabel,
  kernelTargetLabel,
  kernelUptimeLabel,
  kernelVramLabel,
  resolveNotebookSession,
  kernelStatusText,
  kernelTone,
  summarizeKernels,
  type KernelStatus,
} from "./runtime"

const kernel = (value: Partial<KernelStatus> = {}): KernelStatus => ({
  id: "kernel-123",
  active: true,
  state: "idle",
  projectID: "project-1",
  sessionID: "ses_123456789",
  name: "notebook:analysis.ipynb",
  language: "python",
  target: { kind: "local" },
  incarnation: 2,
  execution_count: 7,
  queue_depth: 0,
  environment: null,
  process_id: 1234,
  process_started_at: 90,
  process_identity_verified: true,
  started_at: 100,
  last_activity_at: 200,
  ...value,
})

describe("kernel runtime presentation", () => {
  test("turns canonical names into concise scientist-facing labels", () => {
    expect(kernelLabel(kernel())).toBe("analysis.ipynb")
    expect(kernelLabel(kernel({ name: "agent", language: "r" }))).toBe("R analysis")
  })

  test("maps lifecycle states to stable semantic tones", () => {
    expect(kernelTone("idle")).toBe("ready")
    expect(kernelTone("running")).toBe("active")
    expect(kernelTone("starting")).toBe("pending")
    expect(kernelTone("crashed")).toBe("danger")
    expect(kernelTone("stopped")).toBe("muted")
  })

  test("exposes an idle kernel as ready without hiding canonical running states", () => {
    expect(kernelStateLabel("idle")).toBe("Ready")
    expect(kernelStateLabel("running")).toBe("Running")
    expect(kernelStateLabel("starting")).toBe("Starting")
    expect(kernelStateLabel("lazy")).toBe("Not started")
  })

  test("summarizes live, running, and queued work independently", () => {
    expect(
      summarizeKernels([
        kernel(),
        kernel({ id: "kernel-456", state: "running", queue_depth: 2 }),
        kernel({ id: "kernel-789", active: false, state: "stopped" }),
      ]),
    ).toEqual({ live: 2, running: 1, queued: 2 })
  })

  test("describes the actual incarnation, execution count, and waiting work", () => {
    expect(kernelStatusText()).toBe("stopped")
    expect(kernelStatusText(kernel())).toBe("idle · r2 · 7 runs")
    expect(kernelStatusText(kernel({ state: "running", queue_depth: 2 }))).toBe("running · r2 · 7 runs · 2 queued")
    expect(kernelStatusText(kernel({ execution_count: 1 }))).toBe("idle · r2 · 1 run")
    expect(kernelStatusText(kernel({ state: "lazy", active: false, incarnation: null }))).toBe("lazy · 7 runs")
  })

  test("only offers interruption for an executing kernel", () => {
    expect(kernelCanInterrupt()).toBe(false)
    expect(kernelCanInterrupt(kernel())).toBe(false)
    expect(kernelCanInterrupt(kernel({ state: "stopped", active: false }))).toBe(false)
    expect(kernelCanInterrupt(kernel({ state: "running" }))).toBe(true)
  })

  test("offers stop for starting and live kernels", () => {
    expect(kernelCanStop()).toBe(false)
    expect(kernelCanStop(kernel({ state: "stopped", active: false }))).toBe(false)
    expect(kernelCanStop(kernel({ state: "starting", active: false }))).toBe(true)
    expect(kernelCanStop(kernel())).toBe(true)
    expect(kernelCanStop(kernel({ state: "running" }))).toBe(true)
  })

  test("only offers record deletion for inactive named kernels", () => {
    expect(kernelCanForget()).toBe(false)
    expect(kernelCanForget(kernel())).toBe(false)
    expect(kernelCanForget(kernel({ name: "agent", active: false, state: "stopped" }))).toBe(false)
    expect(kernelCanForget(kernel({ active: false, state: "starting" }))).toBe(false)
    expect(kernelCanForget(kernel({ active: false, state: "stopped" }))).toBe(true)
    expect(kernelCanForget(kernel({ active: false, state: "crashed" }))).toBe(true)
  })

  test("labels language, ownership, and recovery without inventing environment metadata", () => {
    expect(kernelLanguageLabel(kernel())).toBe("Python")
    expect(kernelLanguageLabel(kernel({ language: "r" }))).toBe("R")
    expect(kernelLanguageLabel(kernel({ language: "julia" }))).toBe("julia")
    expect(kernelOwnershipLabel(kernel(), "ses_123456789")).toBe("This session")
    expect(kernelOwnershipLabel(kernel(), "new")).toBe("Project session")
    expect(kernelOwnershipLabel(kernel(), "ses_other")).toBe("Project session")
    expect(kernelRecoveryLabel(kernel())).toBe("Ready. In-memory state persists for the next cell.")
    expect(kernelRecoveryLabel(kernel({ execution_count: 0 }))).toBe("Ready for the first cell.")
    expect(kernelRecoveryLabel(kernel({ state: "starting", active: false }))).toBe(
      "Starting the interpreter and applying its environment.",
    )
    expect(kernelRecoveryLabel(kernel({ state: "running", queue_depth: 2 }))).toBe(
      "Executing now. 2 cells are waiting in this kernel.",
    )
    expect(kernelRecoveryLabel(kernel({ state: "crashed", active: false }))).toBe(
      "The process exited. Restart to replace it; in-memory variables were lost.",
    )
    expect(kernelRecoveryLabel(kernel({ state: "stopped", active: false }))).toBe(
      "Run a cell to start a fresh runtime.",
    )
  })

  test("states network reach on its own, with an open network as the notable case", () => {
    const sandboxed = (network: "deny" | "allow", enforced = true) =>
      kernel({
        environment: {
          cwd: "/work/project",
          atlas: { access: "host_broker", credentials: "withheld", sources: "source_ids_only" },
          sandbox: { requested: true, enforced, backend: "bubblewrap", network, platform: "linux", available: true },
        },
      })

    expect(kernelNetworkLabel(sandboxed("deny"))).toBe("Network disabled")
    expect(kernelNetworkTone(sandboxed("deny"))).toBe("muted")
    expect(kernelNetworkLabel(sandboxed("allow"))).toBe("Network allowed")
    expect(kernelNetworkTone(sandboxed("allow"))).toBe("pending")

    // A sandbox that was asked for but never took hold does not block anything,
    // whatever its recorded network setting says.
    expect(kernelNetworkLabel(sandboxed("deny", false))).toBe("Network allowed")
    expect(kernelNetworkTone(sandboxed("deny", false))).toBe("pending")

    // Nothing measured yet is not the same as an open network.
    expect(kernelNetworkLabel(kernel())).toBeNull()
  })

  test("states the actual sandbox and network contract", () => {
    expect(kernelEnvironmentLabel(kernel())).toBe("Environment pending")
    expect(
      kernelEnvironmentLabel(
        kernel({
          environment: {
            cwd: "/work/project",
            atlas: {
              access: "host_broker",
              credentials: "withheld",
              sources: "source_ids_only",
            },
            sandbox: {
              requested: true,
              enforced: true,
              backend: "seatbelt",
              network: "deny",
              platform: "darwin",
              available: true,
            },
          },
        }),
      ),
    ).toBe("Seatbelt sandbox")
    expect(
      kernelEnvironmentLabel(
        kernel({
          environment: {
            cwd: "/work/project",
            atlas: {
              access: "host_broker",
              credentials: "withheld",
              sources: "source_ids_only",
            },
            sandbox: {
              requested: true,
              enforced: false,
              backend: "none",
              network: "deny",
              platform: "win32",
              available: false,
            },
          },
        }),
      ),
    ).toBe("Sandbox unavailable · host access")
    expect(
      kernelEnvironmentLabel(
        kernel({
          environment: {
            cwd: "/work/project",
            atlas: {
              access: "host_broker",
              credentials: "withheld",
              sources: "source_ids_only",
            },
            sandbox: {
              requested: false,
              enforced: false,
              backend: "none",
              network: "allow",
              platform: "darwin",
              available: true,
            },
          },
        }),
      ),
    ).toBe("Sandbox off · host access")
    expect(kernelEnvironmentTone(kernel())).toBe("muted")
    expect(
      kernelEnvironmentTone(
        kernel({
          environment: {
            cwd: "/work/project",
            atlas: {
              access: "host_broker",
              credentials: "withheld",
              sources: "source_ids_only",
            },
            sandbox: {
              requested: true,
              enforced: false,
              backend: "none",
              network: "allow",
              platform: "win32",
              available: false,
            },
          },
        }),
      ),
    ).toBe("danger")
  })

  test("formats sampled cpu as a one-decimal percentage and never invents a zero", () => {
    expect(kernelCpuLabel()).toBe("Unavailable")
    expect(kernelCpuLabel(undefined)).toBe("Unavailable")
    expect(kernelCpuLabel(Number.NaN)).toBe("Unavailable")
    expect(kernelCpuLabel(-1)).toBe("Unavailable")
    expect(kernelCpuLabel(12.34)).toBe("12.3%")
    expect(kernelCpuLabel(0)).toBe("0.0%")
    expect(kernelCpuLabel(150)).toBe("150.0%")
  })

  test("formats sampled memory as human bytes and never invents a zero", () => {
    expect(kernelMemoryLabel()).toBe("Unavailable")
    expect(kernelMemoryLabel(undefined)).toBe("Unavailable")
    expect(kernelMemoryLabel(Number.NaN)).toBe("Unavailable")
    expect(kernelMemoryLabel(-5)).toBe("Unavailable")
    expect(kernelMemoryLabel(0)).toBe("0 B")
    expect(kernelMemoryLabel(512)).toBe("512 B")
    expect(kernelMemoryLabel(2_400)).toBe("2 KB")
    expect(kernelMemoryLabel(412_000_000)).toBe("412 MB")
    expect(kernelMemoryLabel(1_500_000_000)).toBe("1.5 GB")
  })

  test("reports every registry kernel as local without inventing remote targets", () => {
    expect(kernelTargetLabel()).toBe("Unavailable")
    expect(kernelTargetLabel(kernel())).toBe("Local")
  })

  test("reports uptime and unavailable GPU metrics truthfully", () => {
    expect(kernelGpuLabel()).toBe("Unavailable")
    expect(kernelGpuLabel(42.75)).toBe("42.8%")
    expect(kernelVramLabel()).toBe("Unavailable")
    expect(kernelVramLabel(1_500_000_000)).toBe("1.5 GB")
    expect(kernelUptimeLabel()).toBe("Unavailable")
    expect(kernelUptimeLabel(kernel({ active: false }), 10_000)).toBe("Unavailable")
    expect(kernelUptimeLabel(kernel({ started_at: 1_000 }), 66_000)).toBe("1m 5s")
  })

  test("states the Atlas credential and source boundary", () => {
    expect(kernelAtlasLabel(kernel())).toBe("Atlas access pending")
    expect(
      kernelAtlasLabel(
        kernel({
          environment: {
            cwd: "/work/project",
            atlas: {
              access: "host_broker",
              credentials: "withheld",
              sources: "source_ids_only",
            },
            sandbox: {
              requested: true,
              enforced: true,
              backend: "seatbelt",
              network: "deny",
              platform: "darwin",
              available: true,
            },
          },
        }),
      ),
    ).toBe("Atlas host broker · credentials withheld · source IDs only")
  })

  test("reuses the route session without creating a second owner", async () => {
    const created: string[] = []
    const result = await resolveNotebookSession("ses_existing", async () => {
      created.push("created")
      return { data: { id: "ses_unexpected" } }
    })

    expect(result).toBe("ses_existing")
    expect(created).toEqual([])
  })

  test("creates a real owner for a notebook opened on the new research route", async () => {
    const result = await resolveNotebookSession(undefined, async () => ({
      data: { id: "ses_created" },
    }))

    expect(result).toBe("ses_created")
  })

  test("rejects a session response that cannot own a kernel", async () => {
    expect(resolveNotebookSession(undefined, async () => ({ data: {} }))).rejects.toThrow(
      "session.create returned no id",
    )
  })
})
