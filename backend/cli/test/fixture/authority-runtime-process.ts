import fs from "node:fs/promises"
import path from "node:path"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { AuthorityProcessLedger } from "../../src/project/authority-process"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { ExecutionAuthority } from "../../src/project/execution"
import { Pty } from "../../src/pty"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { NotebookTool } from "../../src/tool/biology/notebook"
import { Config } from "../../src/config/config"

const [mode, directory, result, sessionID, grantID, shell, descendantFileArg] = process.argv.slice(2)

const context = (id: string) => ({
  sessionID: id,
  messageID: "message_authority_orphan",
  callID: "call_authority_orphan",
  agent: "biology",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
})

async function waitText(file: string, attempt = 0): Promise<string> {
  const value = await fs.readFile(file, "utf8").catch(() => undefined)
  if (value?.trim()) return value.trim()
  if (attempt >= 300) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(20)
  return waitText(file, attempt + 1)
}

async function waitEscapedGroup(pid: number, leader: number, attempt = 0): Promise<number> {
  const proc = Bun.spawn(["/bin/ps", "-o", "pgid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const [code, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  const pgid = code === 0 ? Number(output.trim()) : 0
  if (pgid > 0 && pgid !== leader) return pgid
  if (attempt >= 300) throw new Error(`Process ${pid} did not leave group ${leader}`)
  await Bun.sleep(20)
  return waitEscapedGroup(pid, leader, attempt + 1)
}

async function processParent(pid: number): Promise<number> {
  const proc = Bun.spawn(["/bin/ps", "-o", "ppid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const [code, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  return code === 0 ? Number(output.trim()) : 0
}

async function ledger(kind: AuthorityProcessLedger.Kind) {
  const entries = (await Bun.file(AuthorityProcessLedger.pathForTests()).json()) as Array<{
    kind: AuthorityProcessLedger.Kind
    owner_pid: number
    pid: number
    identity: string
    project_id: string
    session_id: string
    authority_generation: string
  }>
  const entry = entries.find((item) => item.kind === kind && item.owner_pid === process.pid)
  if (!entry) throw new Error(`Missing ${kind} authority ledger entry for owner ${process.pid}`)
  return entry
}

async function hostPID(entry: { pid: number; identity: string }, reportedPID: number): Promise<number> {
  if (process.platform !== "linux") return reportedPID
  const resolved = await AuthorityProcessLedger.resolveLinuxNamespacePID({
    leaderPID: entry.pid,
    leaderIdentity: entry.identity,
    namespacePID: reportedPID,
  })
  if (!resolved) throw new Error(`Could not resolve sandbox PID ${reportedPID} below authority leader ${entry.pid}`)
  return resolved
}

await Instance.provide({
  directory,
  ...(mode.startsWith("revoke-") ? { init: InstanceBootstrap } : {}),
  fn: async () => {
    if (mode === "setup" || mode === "setup-installation") {
      // This fixture validates containment teardown, so opt into the global
      // sandbox explicitly now that new local installs default to Full access.
      await Config.setSandbox({ enabled: true })
      const status = await ProjectTrust.status(Instance.project)
      if (!status.canExecuteProjectCode) {
        await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
      }
      const session = await Session.create({ title: "authority orphan" })
      const grant = await SessionFilesystem.grant({
        sessionID: session.id,
        path: directory,
        access: "read",
        scope: mode === "setup-installation" ? "installation" : "session",
      })
      const scratch = await SessionFilesystem.workspace(session.id)
      const shellPath = path.join(scratch, "persistent-pty.sh")
      const descendantFile = path.join(scratch, "authority-descendant.pid")
      const python = Bun.which("python3") ?? "/usr/bin/python3"
      const escaped = [
        "import os, signal, time",
        "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        "os.fork() and os._exit(0)",
        "os.setsid()",
        "os.fork() and os._exit(0)",
        `marker = open(${JSON.stringify(descendantFile)}, 'w')`,
        "marker.write(str(os.getpid()))",
        "marker.close()",
        "time.sleep(3600)",
      ].join("; ")
      await Bun.write(
        shellPath,
        [
          "#!/bin/sh",
          "trap '' HUP TERM INT",
          `${JSON.stringify(python)} -c ${JSON.stringify(escaped)} &`,
          'child="$!"',
          'wait "$child"',
          "while :; do sleep 1; done",
          "",
        ].join("\n"),
      )
      await fs.chmod(shellPath, 0o700)
      await Bun.write(
        result,
        JSON.stringify({
          projectID: Instance.project.id,
          sessionID: session.id,
          grantID: grant.id,
          shell: shellPath,
          descendantFile,
        }),
      )
      return
    }

    if (mode === "owner-pty") {
      const descendantFile = descendantFileArg
      if (!descendantFile) throw new Error("Missing PTY descendant marker path")
      process.env.SHELL = shell
      const terminal = await Pty.create({ sessionID, title: "orphan" })
      const entry = await ledger("pty")
      const descendantPID = await hostPID(entry, Number(await waitText(descendantFile)))
      const descendantIdentity = await AuthorityProcessLedger.identity(descendantPID)
      if (!descendantIdentity) throw new Error(`Missing PTY descendant identity for ${descendantPID}`)
      const descendantGroup = await waitEscapedGroup(descendantPID, entry.pid)
      await Bun.write(
        result,
        JSON.stringify({
          ...entry,
          sandboxed: terminal.authority.sandbox.enforced,
          descendant: {
            pid: descendantPID,
            identity: descendantIdentity,
            pgid: descendantGroup,
            ppid: await processParent(descendantPID),
          },
        }),
      )
      await new Promise(() => {})
      return
    }

    if (mode === "owner-biology") {
      const descendantFile = descendantFileArg
      if (!descendantFile) throw new Error("Missing biology descendant marker path")
      const authority = await ExecutionAuthority.require({
        projectID: Instance.project.id,
        sessionID,
        capability: "kernel",
      })
      const tool = await NotebookTool.init()
      await tool.execute(
        {
          code: [
            "import subprocess, sys",
            `descendant = subprocess.Popen([sys.executable, "-c", ${JSON.stringify(
              [
                "import os, signal, time",
                "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
                "if os.fork(): os._exit(0)",
                "os.setsid()",
                "if os.fork(): os._exit(0)",
                `marker = open(${JSON.stringify(descendantFile)}, 'w')`,
                "marker.write(str(os.getpid()))",
                "marker.close()",
                "time.sleep(3600)",
              ].join("\n"),
            )}])`,
            "print(descendant.pid)",
          ].join("\n"),
          timeout: 30_000,
        },
        context(sessionID),
      )
      const entry = await ledger("biology")
      const descendantPID = await hostPID(entry, Number(await waitText(descendantFile)))
      const descendantIdentity = await AuthorityProcessLedger.identity(descendantPID)
      if (!descendantIdentity) throw new Error(`Missing biology descendant identity for ${descendantPID}`)
      const descendantGroup = await waitEscapedGroup(descendantPID, entry.pid)
      await Bun.write(
        result,
        JSON.stringify({
          ...entry,
          sandboxed: authority.sandbox.enforced,
          descendant: {
            pid: descendantPID,
            identity: descendantIdentity,
            pgid: descendantGroup,
            ppid: await processParent(descendantPID),
          },
        }),
      )
      await new Promise(() => {})
      return
    }

    if (mode === "revoke-trust") {
      await ProjectTrust.update(Instance.project, { trusted: false })
      return
    }
    if (mode === "revoke-filesystem") {
      await SessionFilesystem.revoke(sessionID, grantID)
      return
    }
    if (mode === "revoke-session") {
      await Session.remove(sessionID)
      return
    }
    if (mode === "reap") {
      await AuthorityProcessLedger.revoke({ projectID: Instance.project.id })
      return
    }
    if (mode === "mismatched-identity") {
      const child = Bun.spawn([process.execPath, "-e", "await new Promise(() => {})"], {
        detached: process.platform !== "win32",
        stdout: "ignore",
        stderr: "ignore",
      })
      const id = `identity-test-${crypto.randomUUID()}`
      const original = await AuthorityProcessLedger.identity(child.pid)
      if (!original) throw new Error("Could not capture fixture process identity")
      try {
        await AuthorityProcessLedger.register({
          id,
          kind: "biology",
          pid: child.pid,
          projectID: Instance.project.id,
          sessionID: "ses_identity_fixture",
          authorityGeneration: "identity-fixture-generation",
        })
        const entries = (await Bun.file(AuthorityProcessLedger.pathForTests()).json()) as Array<{
          id: string
          identity: string
        }>
        const entry = entries.find((item) => item.id === id)
        if (!entry) throw new Error("Missing identity fixture ledger entry")
        entry.identity = "0".repeat(64)
        await Bun.write(AuthorityProcessLedger.pathForTests(), JSON.stringify(entries))
        const killed = await AuthorityProcessLedger.revoke({ id })
        await Bun.write(
          result,
          JSON.stringify({ killed, survived: await AuthorityProcessLedger.owns(child.pid, original) }),
        )
      } finally {
        if (process.platform === "win32") child.kill("SIGKILL")
        else process.kill(-child.pid, "SIGKILL")
        await child.exited
      }
      return
    }
    if (mode === "non-group") {
      const child = Bun.spawn([process.execPath, "-e", "await new Promise(() => {})"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      let error = ""
      try {
        await AuthorityProcessLedger.register({
          id: `group-test-${crypto.randomUUID()}`,
          kind: "pty",
          pid: child.pid,
          projectID: Instance.project.id,
          sessionID: "ses_group_fixture",
          authorityGeneration: "group-fixture-generation",
        })
      } catch (value) {
        error = value instanceof Error ? value.message : String(value)
      } finally {
        child.kill("SIGKILL")
        await child.exited
      }
      await Bun.write(result, JSON.stringify({ error }))
      return
    }
    if (mode === "leader-exit-grandchild") {
      const childFile = `${result}.child`
      const releaseFile = `${result}.release`
      const leader = Bun.spawn(
        [
          process.execPath,
          "-e",
          [
            'import fs from "node:fs/promises"',
            "const [childFile, releaseFile] = process.argv.slice(1)",
            "const child = Bun.spawn([process.execPath, '-e', `process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdout: 'ignore', stderr: 'ignore' })",
            "child.unref()",
            "await fs.writeFile(childFile, String(child.pid))",
            "while (!(await fs.stat(releaseFile).then(() => true, () => false))) await Bun.sleep(10)",
          ].join(";"),
          childFile,
          releaseFile,
        ],
        { detached: true, stdout: "ignore", stderr: "ignore" },
      )
      const id = `leader-exit-${crypto.randomUUID()}`
      let childPID = 0
      try {
        const registered = await AuthorityProcessLedger.register({
          id,
          kind: "biology",
          pid: leader.pid,
          projectID: Instance.project.id,
          sessionID: "ses_leader_exit_fixture",
          authorityGeneration: "leader-exit-generation",
        })
        if (!registered) throw new Error("Leader exited before registration")
        childPID = Number(await waitText(childFile))
        const childIdentity = await AuthorityProcessLedger.identity(childPID)
        if (!childIdentity) throw new Error(`Missing child identity for ${childPID}`)
        await Bun.write(releaseFile, "release")
        await leader.exited
        const completed = await AuthorityProcessLedger.complete(id)
        await Bun.write(
          result,
          JSON.stringify({
            completed,
            child: { pid: childPID, identity: childIdentity },
            survived: await AuthorityProcessLedger.owns(childPID, childIdentity),
          }),
        )
      } finally {
        if (childPID) {
          const childIdentity = await AuthorityProcessLedger.identity(childPID)
          if (childIdentity) process.kill(childPID, "SIGKILL")
        }
        await AuthorityProcessLedger.revoke({ id }).catch(() => undefined)
      }
      return
    }
    throw new Error(`Unknown authority runtime fixture mode: ${mode}`)
  },
})

// Revocation modes bootstrap the same native watcher lifecycle as the server.
// One-shot CLI commands dispose this through cli/bootstrap; this direct
// fixture must do the equivalent after its revocation work completes.
await Instance.disposeAll()
