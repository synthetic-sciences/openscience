import { expect, test } from "bun:test"
import { Sandbox } from "../../src/sandbox/sandbox"

/**
 * The AppContainer counterpart to egress-live-seatbelt.test.ts: a real
 * `CreateProcessW` with real `SECURITY_CAPABILITIES`, on a real Windows kernel.
 *
 * Everything else in `test/sandbox/` exercises the Windows branch from Linux
 * with `platform: "win32"` injected, which proves what we COMPOSE and nothing
 * about what Windows does with it. That gap cost roughly ten manual round trips
 * on a human's machine, one command at a time, and the bugs it hid were not
 * exotic: `-c` where cmd wanted `/c`, `printf` in a shell that has no `printf`,
 * `CommandLineToArgvW` quoting handed to the one program that does not parse it
 * that way, and a child with no inherited stdio. Every one of them would have
 * been a red job here within minutes of being written.
 *
 * `platform` is deliberately never injected below. The whole point is to let
 * `Sandbox.backend()` resolve for real, from a real `AppContainer.usable()`
 * probe, on a machine where that probe can succeed.
 *
 * A red run means one of three things, and the check names distinguish them:
 *   1. "the child actually runs inside the AppContainer" fails — the launch is
 *      not applying SECURITY_CAPABILITIES. Look at `appcontainer.ts`; run with
 *      OPENSCIENCE_SANDBOX_DEBUG=1 for the values handed to the kernel.
 *   2. that passes but "write inside the workspace succeeds" fails — the
 *      container is live and the grants are wrong. Look at `grant()`.
 *   3. that passes but "write outside" is not blocked — containment is real but
 *      leaky, which is the only genuinely alarming outcome.
 */

const windows = process.platform === "win32"

test.if(windows)(
  "a trivial command survives the container at all",
  async () => {
    // Separates "the container cannot host a process here" from "this command
    // failed inside it". A CI runner produced exit 66 with nothing on either
    // stream, where a developer machine running the same build produced a token.
    // `exit 7` needs no executable beyond the shell itself and no readable path,
    // so it fails only if the container cannot host a process on this machine.
    const { Shell } = await import("../../src/shell/shell")
    const shell = Shell.acceptable()
    const plan = Sandbox.plan({
      command: "exit 7",
      shell,
      cwd: process.cwd(),
      workspace: [process.cwd()],
      options: { enabled: true, network: "deny" },
    })
    const proc = Bun.spawn([plan.file, ...(plan.args ?? [])], { stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    console.log(
      `  shell ${shell}\n  exit ${proc.exitCode} (expect 7)\n  stdout: ${out.trim()}\n  stderr: ${err.trim()}`,
    )
    expect(proc.exitCode).toBe(7)
  },
  120_000,
)
test.if(windows)(
  "the AppContainer confines a real child on a real Windows kernel",
  async () => {
    const result = await Sandbox.selfTest()
    // Print every check before asserting: a bare "expected true, got false" from
    // CI is worth almost nothing when the machine is not one we can log into.
    for (const check of result.checks)
      console.log(
        `  ${check.skipped ? "skip" : check.pass ? "pass" : "FAIL"}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`,
      )
    expect(result.available).toBe(true)
    expect(result.backend).toBe("appcontainer")
    const containment = result.checks.find((c) => c.name.includes("runs inside the AppContainer"))
    expect(containment?.pass).toBe(true)
    expect(result.ok).toBe(true)
  },
  120_000,
)

test.if(!windows)("this file's assertions are inert off Windows", () => {
  // Guard against the file quietly becoming dead weight: if `selfTest` stops
  // reporting an appcontainer backend name, the test above would skip forever
  // on Windows too and nobody would notice.
  expect(Sandbox.backend("win32")).toBe("appcontainer")
})
