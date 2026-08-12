import { AuthorityProcessLedger } from "../../src/project/authority-process"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { KernelRuntime, type KernelIdentity } from "../../src/science/kernel/registry"
import { Session } from "../../src/session"
import "../../src/tool/notebook"
import "../../src/tool/rkernel"

const [, , workspace, language, marker] = process.argv

async function waitForMarker(attempt = 0): Promise<number> {
  const value = await Bun.file(marker)
    .text()
    .catch(() => "")
  const pid = Number(value.trim())
  if (Number.isSafeInteger(pid) && pid > 0) return pid
  if (attempt >= 500) throw new Error(`Timed out waiting for descendant marker ${marker}`)
  await Bun.sleep(10)
  return waitForMarker(attempt + 1)
}

async function processRow(pid: number) {
  const proc = Bun.spawn(["ps", "-o", "ppid=,pgid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Could not inspect descendant ${pid}: ${stderr.trim()}`)
  const [ppid, pgid] = stdout.trim().split(/\s+/).map(Number)
  return { ppid, pgid }
}

await Instance.provide({
  directory: workspace,
  fn: async () => {
    const status = await ProjectTrust.status(Instance.project)
    if (!status.canExecuteProjectCode) {
      await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
    }
    const session = await Session.create({})
    const identity: KernelIdentity = {
      projectID: Instance.project.id,
      sessionID: session.id,
      name: `setsid-${language}`,
      language,
    }
    const python = Bun.which("python3") ?? Bun.which("python")
    if (!python) throw new Error("Python is required for the setsid kernel regression")
    const childCode = [
      "import os,time",
      `open(${JSON.stringify(marker)}, "w").write(str(os.getpid()))`,
      "time.sleep(600)",
    ].join("; ")
    const code =
      language === "python"
        ? [
            "import subprocess, sys",
            `child = subprocess.Popen([sys.executable, "-c", ${JSON.stringify(childCode)}], start_new_session=True)`,
            `open(${JSON.stringify(marker)}, "w").write(str(child.pid))`,
            "child.pid",
          ].join("\n")
        : [
            "parallel::mcparallel({",
            `  system2(${JSON.stringify(python)}, c("-c", shQuote(${JSON.stringify(`import os; os.setsid(); ${childCode}`)})), wait=TRUE, stdout=FALSE, stderr=FALSE)`,
            "}, silent=TRUE)",
            "TRUE",
          ].join("\n")
    let childPID = 0
    let childIdentity: string | undefined
    try {
      const execution = await KernelRuntime.execute(identity, code)
      if (!execution.ok) throw new Error(`Could not launch ${language} descendant: ${execution.stderr}`)
      childPID = await waitForMarker()
      childIdentity = await AuthorityProcessLedger.identity(childPID)
      if (!childIdentity) throw new Error(`Could not establish descendant identity for ${childPID}`)
      const kernelPID = KernelRuntime.status(identity).process_id
      if (!kernelPID) throw new Error(`${language} kernel did not publish its leader PID`)
      const child = await processRow(childPID)
      const ancestors: number[] = []
      let ancestor = child.ppid
      for (let depth = 0; depth < 8 && ancestor > 0; depth++) {
        ancestors.push(ancestor)
        if (ancestor === kernelPID) break
        ancestor = (await processRow(ancestor)).ppid
      }
      await KernelRuntime.release(identity)
      console.log(
        JSON.stringify({
          language,
          kernelPID,
          childPID,
          childPPID: child.ppid,
          childPGID: child.pgid,
          childAncestors: ancestors,
          survived: await AuthorityProcessLedger.owns(childPID, childIdentity),
        }),
      )
    } finally {
      await KernelRuntime.release(identity).catch(() => undefined)
      if (childPID && (await AuthorityProcessLedger.owns(childPID, childIdentity))) {
        process.kill(childPID, "SIGKILL")
      }
    }
  },
})
