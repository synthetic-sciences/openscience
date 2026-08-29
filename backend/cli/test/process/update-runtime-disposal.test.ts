import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { AuthorityProcessLedger } from "../../src/project/authority-process"
import { Pty } from "../../src/pty"
import { KernelRuntime, type KernelIdentity } from "../../src/science/kernel/registry"
import { Session } from "../../src/session"
import { UpdateQuiescence } from "../../src/process/update-quiescence"
import { Sandbox } from "../../src/sandbox/sandbox"
import { sandboxedExecution, tmpdir } from "../fixture/fixture"
import "../../src/tool/notebook"

async function waitFor(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error(message)
}

test.skipIf(!Sandbox.available() || !Bun.which("python3"))(
  "instance disposal releases PTY and executing-kernel update blockers and durable ownership",
  async () => {
    await using _sandbox = await sandboxedExecution()
    await using tmp = await tmpdir({ git: true })
    const baseline = UpdateQuiescence.inventory()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const session = await Session.create({})
        await Pty.create({ sessionID: session.id, title: "update blocker" })
        const identity: KernelIdentity = {
          projectID: Instance.project.id,
          sessionID: session.id,
          name: "update-blocker",
          language: "python",
        }
        const execution = KernelRuntime.execute(identity, "import time\ntime.sleep(30)").then(
          () => "completed" as const,
          () => "stopped" as const,
        )

        await waitFor(
          () => UpdateQuiescence.active("kernel") > baseline.kernel,
          "Kernel execution never crossed the desktop update admission boundary",
        )
        expect(UpdateQuiescence.active("pty")).toBe(baseline.pty + 1)
        expect(UpdateQuiescence.active("kernel")).toBe(baseline.kernel + 1)
        expect(() => UpdateQuiescence.begin()).toThrow("starting new work")

        const projectID = Instance.project.id
        await Instance.dispose({ strict: true })
        expect(await Promise.race([execution, Bun.sleep(5_000).then(() => "timeout" as const)])).toBe("stopped")
        await waitFor(
          () =>
            UpdateQuiescence.active("pty") === baseline.pty && UpdateQuiescence.active("kernel") === baseline.kernel,
          "Runtime disposal left desktop update blockers admitted",
        )
        const ledger = await Bun.file(AuthorityProcessLedger.pathForTests())
          .json()
          .catch(() => [])
        expect(
          (ledger as Array<{ project_id?: string; kind?: string }>).filter(
            (entry) => entry.project_id === projectID && (entry.kind === "pty" || entry.kind === "kernel"),
          ),
        ).toEqual([])
      },
    })
  },
  20_000,
)
