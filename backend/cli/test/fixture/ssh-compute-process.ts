import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { ComputeJobs } from "../../src/compute/jobs"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"

const [mode, workspace, root, hostFile, sessionFile, jobFile] = process.argv.slice(2)
if (!mode || !workspace || !root || !hostFile || !sessionFile || !jobFile)
  throw new Error("missing SSH fixture arguments")
const host = ComputeJobs.Host.parse(JSON.parse(await fs.readFile(hostFile, "utf8")))

await Config.setSandbox({ enabled: true, network: "deny", onUnavailable: "error" })
await Instance.provide({
  directory: workspace,
  fn: async () => {
    const trust = await ProjectTrust.status(Instance.project)
    if (!trust.canExecuteProjectCode) await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
    if (
      mode === "start" ||
      mode === "start-cancel" ||
      mode === "start-ignore-term" ||
      mode === "start-killpoint" ||
      mode === "start-double-fork" ||
      mode === "start-double-fork-cancel"
    ) {
      const session = await Session.create({})
      const sessionWorkspace = await SessionFilesystem.workspace(session.id)
      await fs.copyFile(path.join(workspace, "input.txt"), path.join(sessionWorkspace, "input.txt"))
      const request = {
        sessionID: session.id,
        name: "OpenSSH durable dispatch",
        command:
          mode === "start-ignore-term"
            ? "trap '' TERM; printf 'cancel-ready\\n'; sleep 30"
            : mode === "start-double-fork"
              ? 'python3 -c \'import os,time,pathlib; p=os.fork(); p and os._exit(0); os.setsid(); p=os.fork(); p and os._exit(0); os.environ.clear(); time.sleep(1); pathlib.Path("outputs").mkdir(exist_ok=True); pathlib.Path("outputs/double-fork.txt").write_text("contained\\n")\'; printf \'leader-done\\n\''
              : mode === "start-double-fork-cancel"
                ? "python3 -c 'import os,signal,time,pathlib; p=os.fork(); p and os._exit(0); os.setsid(); p=os.fork(); p and os._exit(0); os.environ.clear(); pathlib.Path(\"double-fork.pid\").write_text(str(os.getpid())); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)'"
                : mode === "start-cancel"
                  ? "printf 'cancel-ready\\n'; sleep 30"
                  : "mkdir -p outputs; printf 'remote:%s\\n' \"$(cat input.txt)\"; printf 'verified:%s\\n' \"$(cat input.txt)\" > outputs/result.txt; sleep 1",
        target: { kind: "ssh" as const, host_id: host.id },
        uploads: ["input.txt"],
        artifacts:
          mode === "start-cancel" || mode === "start-ignore-term" || mode === "start-double-fork-cancel"
            ? undefined
            : ["outputs/*.txt"],
      }
      const plan = await ComputeJobs.plan(request, { root, workspace, hosts: [host] })
      if (plan.provider !== "ssh") throw new Error("expected SSH plan")
      if (mode === "start-killpoint") process.env.OPENSCIENCE_SSH_TEST_KILLPOINT = "after-accept"
      const job = await ComputeJobs.start(
        { ...request, approval: plan.digest },
        { root, workspace, hosts: [host] },
      ).catch(async (error) => {
        if (mode === "start-killpoint") {
          delete process.env.OPENSCIENCE_SSH_TEST_KILLPOINT
          const latest = (await ComputeJobs.list({ root, workspace, hosts: [host] })).at(-1)
          if (latest) await Promise.all([fs.writeFile(sessionFile, session.id), fs.writeFile(jobFile, latest.id)])
        }
        throw error
      })
      await Promise.all([fs.writeFile(sessionFile, session.id), fs.writeFile(jobFile, job.id)])
      if (mode === "start-killpoint") {
        await Bun.sleep(90_000)
        throw new Error("SSH after-accept killpoint did not terminate the fixture process")
      }
      console.log(
        JSON.stringify({
          id: job.id,
          remote_id: job.remote_id,
          fingerprint: job.ssh?.fingerprint,
          session_workspace: sessionWorkspace,
        }),
      )
      process.exit(0)
    }
    const id = (await fs.readFile(jobFile, "utf8")).trim()
    if (mode === "attach") {
      const deadline = Date.now() + 60_000
      let latest = await ComputeJobs.list({ root, workspace, hosts: [host] })
      for (;;) {
        const job = latest.find((item) => item.id === id)
        if (job?.remote_id) {
          console.log(JSON.stringify({ id: job.id, remote_id: job.remote_id }))
          process.exit(0)
        }
        if (Date.now() >= deadline) throw new Error(`Timed out attaching SSH job ${id}`)
        await Bun.sleep(50)
        latest = await ComputeJobs.list({ root, workspace, hosts: [host] })
      }
    }
    if (mode === "cancel") {
      const cancelled = await ComputeJobs.cancel(id, { root, workspace, hosts: [host] })
      console.log(
        JSON.stringify({
          id: cancelled.id,
          status: cancelled.status,
          remote_id: cancelled.remote_id,
          lifecycle: cancelled.lifecycle,
          events: await ComputeJobs.events(id, { root, workspace, hosts: [host] }),
        }),
      )
      process.exit(0)
    }
    // Recovery crosses several real, host-key-pinned SSH control calls. Under
    // the parallel backend suite those calls can exceed 20s even though the
    // remote workload has finished, so keep the fixture poll inside the
    // enclosing native integration budget rather than imposing a unit-test
    // deadline here.
    const finished = await ComputeJobs.wait(id, { root, workspace, hosts: [host], timeout: 60_000 })
    console.log(
      JSON.stringify({
        id: finished.id,
        status: finished.status,
        remote_id: finished.remote_id,
        lifecycle: finished.lifecycle,
        artifacts: finished.artifacts,
        log: await ComputeJobs.log(id, { root, workspace, hosts: [host] }),
        events: await ComputeJobs.events(id, { root, workspace, hosts: [host] }),
      }),
    )
    process.exit(0)
  },
})
