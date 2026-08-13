import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { ComputeJobs } from "../../src/compute/jobs"

async function run(argv: string[], env: Record<string, string | undefined> = process.env) {
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${stderr}`)
  return stdout
}

async function waitForRemoteID(root: string, id: string, timeout: number) {
  const file = path.join(root, "jobs.json")
  const deadline = Date.now() + timeout
  let snapshot = "missing"
  while (Date.now() < deadline) {
    snapshot = await fs.readFile(file, "utf8").catch(() => "missing")
    const jobs = snapshot === "missing" ? [] : (JSON.parse(snapshot) as { id: string; remote_id?: string }[])
    const job = jobs.find((item) => item.id === id)
    if (job?.remote_id) return job.remote_id
    await Bun.sleep(50)
  }
  throw new Error(`SSH job ${id} did not publish a durable remote id within ${timeout}ms\nJOBS:\n${snapshot}`)
}

async function port() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("no fixture port"))
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

function environment(root: string, socket: string) {
  return {
    ...process.env,
    SSH_AUTH_SOCK: socket,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
  }
}

function fixtureConfig(input: { listen: number; root: string; hostKey: string; authorized: string }) {
  return [
    `Port ${input.listen}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${input.hostKey}`,
    `PidFile ${path.join(input.root, "sshd.pid")}`,
    `AuthorizedKeysFile ${input.authorized}`,
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    "PubkeyAuthentication yes",
    "UsePAM no",
    "StrictModes no",
    "AllowTcpForwarding no",
    "AllowAgentForwarding no",
    "PermitTunnel no",
    "X11Forwarding no",
    "LogLevel VERBOSE",
    "",
  ].join("\n")
}

test("the real-sshd fixture stays portable without relaxing its isolation", () => {
  const config = fixtureConfig({
    listen: 22022,
    root: "/tmp/openscience-sshd-fixture",
    hostKey: "/tmp/openscience-sshd-fixture/host-ed25519",
    authorized: "/tmp/openscience-sshd-fixture/authorized_keys",
  })
  const directives = config.split("\n")

  // PerSourcePenalties was introduced after Ubuntu 24.04's OpenSSH 9.6. The
  // fixture does not need to override that daemon-side abuse protection.
  expect(directives.some((line) => line.startsWith("PerSourcePenalties "))).toBe(false)
  expect(directives).toContain("HostKey /tmp/openscience-sshd-fixture/host-ed25519")
  expect(directives).toContain("AuthorizedKeysFile /tmp/openscience-sshd-fixture/authorized_keys")
  expect(directives).toContain("ListenAddress 127.0.0.1")
  expect(directives).toContain("PasswordAuthentication no")
  expect(directives).toContain("KbdInteractiveAuthentication no")
  expect(directives).toContain("ChallengeResponseAuthentication no")
  expect(directives).toContain("PubkeyAuthentication yes")
  expect(directives).toContain("UsePAM no")
  expect(directives).toContain("AllowTcpForwarding no")
  expect(directives).toContain("AllowAgentForwarding no")
  expect(directives).toContain("PermitTunnel no")
  expect(directives).toContain("X11Forwarding no")
})

test("dispatches through a real OpenSSH daemon and reattaches from a fresh server process", async () => {
  const sshd = "/usr/sbin/sshd"
  if (!(await Bun.file(sshd).exists())) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-sshd-"))
  const workspace = path.join(root, "workspace")
  const state = path.join(root, "jobs")
  const remote = path.join(root, "remote")
  const hostKey = path.join(root, "host-ed25519")
  const clientKey = path.join(root, "client-ed25519")
  const authorized = path.join(root, "authorized_keys")
  const config = path.join(root, "sshd_config")
  const sessionFile = path.join(root, "session")
  const jobFile = path.join(root, "job")
  const hostFile = path.join(root, "host.json")
  const daemonLog = path.join(root, "sshd.log")
  const fixture = new URL("../fixture/ssh-compute-process.ts", import.meta.url).pathname
  const listen = await port()
  let daemon: ReturnType<typeof Bun.spawn> | undefined
  let agentPid: number | undefined
  try {
    await Promise.all([fs.mkdir(workspace), fs.mkdir(remote), fs.mkdir(path.join(root, "home"), { recursive: true })])
    await fs.writeFile(path.join(workspace, "input.txt"), "payload\n")
    await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey])
    await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", clientKey])
    await fs.copyFile(`${clientKey}.pub`, authorized)
    await fs.chmod(authorized, 0o600)
    await fs.writeFile(config, fixtureConfig({ listen, root, hostKey, authorized }))
    const agent = await run(["ssh-agent", "-s"])
    const socket = agent.match(/SSH_AUTH_SOCK=([^;]+)/)?.[1]
    agentPid = Number(agent.match(/SSH_AGENT_PID=([0-9]+)/)?.[1])
    if (!socket || !Number.isInteger(agentPid)) throw new Error("ssh-agent did not publish its environment")
    const env = environment(root, socket)
    await run(["ssh-add", clientKey], env)
    const listed = await run(["ssh-add", "-l"], env)
    if (!listed.includes("ED25519")) throw new Error(`SSH fixture agent did not retain the test key: ${listed}`)
    const logFile = await fs.open(daemonLog, "w", 0o600)
    daemon = Bun.spawn([sshd, "-D", "-e", "-f", config], { env, stdout: "ignore", stderr: logFile.fd })
    await logFile.close()
    const host = {
      id: "real-openssh",
      label: "OpenSSH fixture",
      host: "127.0.0.1",
      user: os.userInfo().username,
      port: listen,
      scheduler: "none" as const,
      workdir: remote,
      concurrency: 1,
    }
    const directDeadline = Date.now() + 3_000
    let direct = ""
    while (Date.now() < directDeadline) {
      direct = await run(
        [
          "ssh",
          "-vv",
          "-T",
          "-F",
          "/dev/null",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-p",
          String(listen),
          `${host.user}@${host.host}`,
          "true",
        ],
        env,
      ).then(
        () => "ok",
        (error) => String(error),
      )
      if (direct === "ok") break
      await Bun.sleep(50)
    }
    if (direct !== "ok") throw new Error(`Direct fixture SSH failed: ${direct}`)
    process.env.SSH_AUTH_SOCK = socket
    const deadline = Date.now() + 8_000
    let probe: ComputeJobs.Probe | undefined
    while (Date.now() < deadline) {
      if (!(await Bun.file(path.join(root, "sshd.pid")).exists())) {
        await Bun.sleep(50)
        continue
      }
      const scanned = await import("../../src/compute/ssh/adapter").then((module) => module.SshAdapter.scan(host))
      probe = await ComputeJobs.probe({ ...host, ...scanned })
      if (probe.ok) break
      await Bun.sleep(50)
    }
    if (!probe?.ok) {
      throw new Error(
        `${probe?.error ?? `OpenSSH fixture did not become ready (sshd exit ${daemon.exitCode})`}\n${await fs.readFile(daemonLog, "utf8")}`,
      )
    }
    expect(probe?.fingerprint).toStartWith("SHA256:")
    const pinned = ComputeJobs.Host.parse({ ...host, fingerprint: probe?.fingerprint, host_key: probe?.host_key })
    const unavailableScheduler = await ComputeJobs.probe({ ...pinned, scheduler: "slurm" })
    expect(unavailableScheduler.ok).toBe(false)
    expect(unavailableScheduler.error).toContain("Slurm (sbatch, squeue, sacct, scancel)")
    await fs.writeFile(hostFile, JSON.stringify(pinned))
    if (process.platform === "linux") {
      const commands = (value: string) => value.match(/Starting session: command/g)?.length ?? 0
      const before = commands(await fs.readFile(daemonLog, "utf8"))
      const failed = await run(
        [
          process.execPath,
          fixture,
          "start",
          workspace,
          path.join(root, "failed-jobs"),
          hostFile,
          path.join(root, "failed-session"),
          path.join(root, "failed-job"),
        ],
        { ...env, OPENSCIENCE_SSH_TEST_REGISTRATION_FAILURE: "1" },
      ).then(
        () => "unexpected-success",
        (error) => String(error),
      )
      expect(failed).toContain("Injected SSH control registration failure")
      expect(commands(await fs.readFile(daemonLog, "utf8"))).toBe(before)
    }
    const first = await run([process.execPath, fixture, "start", workspace, state, hostFile, sessionFile, jobFile], env)
    const started = JSON.parse(first.trim()) as {
      id: string
      remote_id?: string
      fingerprint: string
      session_workspace: string
    }
    expect(started.remote_id).toBeUndefined()
    expect(started.fingerprint).toBe(pinned.fingerprint!)
    expect(await fs.readFile(path.join(state, "jobs.json"), "utf8")).not.toContain('"owner"')
    const recovery = run([process.execPath, fixture, "recover", workspace, state, hostFile, sessionFile, jobFile], env)
    const attachedRemoteID = await waitForRemoteID(state, started.id, 60_000)
    expect(attachedRemoteID).toMatch(/^pid:[0-9]+$/)
    const second = await Promise.race([
      recovery,
      Bun.sleep(70_000).then(async () => {
        throw new Error(
          `SSH recovery timed out\nJOBS:\n${await fs.readFile(path.join(state, "jobs.json"), "utf8").catch(() => "missing")}\nSSHD:\n${await fs.readFile(daemonLog, "utf8")}`,
        )
      }),
    ])
    const recovered = JSON.parse(second.trim()) as {
      id: string
      status: string
      remote_id: string
      lifecycle: { delivery: string; resource: string }
      artifacts: { path: string; sha256: string }[]
      log: string
      events: string
    }
    expect(recovered).toMatchObject({
      id: started.id,
      status: "succeeded",
      lifecycle: { delivery: "complete", resource: "closed" },
    })
    expect(recovered.remote_id).toMatch(/^pid:[0-9]+$/)
    expect(recovered.remote_id).toBe(attachedRemoteID)
    expect(recovered.log).toContain("remote:payload")
    expect(recovered.events).toContain(`Submitted ${recovered.remote_id}`)
    expect(recovered.artifacts.map((item) => item.path)).toEqual(["outputs/result.txt"])
    expect(await fs.readFile(path.join(started.session_workspace, "outputs/result.txt"), "utf8")).toBe(
      "verified:payload\n",
    )
    expect(await Bun.file(path.join(remote, ".openscience", "jobs", started.id)).exists()).toBe(false)

    const long = JSON.parse(
      (
        await run([process.execPath, fixture, "start-cancel", workspace, state, hostFile, sessionFile, jobFile], env)
      ).trim(),
    ) as { id: string; remote_id?: string }
    expect(long.remote_id).toBeUndefined()
    const longAttached = JSON.parse(
      (await run([process.execPath, fixture, "attach", workspace, state, hostFile, sessionFile, jobFile], env)).trim(),
    ) as { id: string; remote_id: string }
    const longRemoteID = longAttached.remote_id
    expect(longRemoteID).toMatch(/^pid:[0-9]+$/)
    const remoteRuntime = JSON.parse(
      await fs.readFile(path.join(remote, ".openscience", "jobs", long.id, "runtime.json"), "utf8"),
    ) as { containment?: string; subreaper?: boolean; responsibility?: number }
    const containment = remoteRuntime.containment
    if (!containment) throw new Error("Remote SSH supervisor did not publish a containment primitive")
    expect(["linux-subreaper", "systemd-scope", "darwin-responsibility"]).toContain(containment)
    if (process.platform === "linux") {
      expect(remoteRuntime.subreaper || remoteRuntime.containment === "systemd-scope").toBe(true)
    }
    if (process.platform === "darwin") {
      expect(remoteRuntime.containment).toBe("darwin-responsibility")
      expect(remoteRuntime.responsibility).toBeGreaterThan(0)
    }
    const cancelled = JSON.parse(
      (await run([process.execPath, fixture, "cancel", workspace, state, hostFile, sessionFile, jobFile], env)).trim(),
    ) as {
      id: string
      status: string
      remote_id: string
      lifecycle: { execution: string; resource: string }
      events: string
    }
    expect(cancelled).toMatchObject({
      id: long.id,
      status: "cancelled",
      remote_id: longRemoteID,
      lifecycle: { execution: "cancelled", resource: "closed" },
    })
    expect(cancelled.events).toContain("Released remote workspace")
    expect(await Bun.file(path.join(remote, ".openscience", "jobs", long.id)).exists()).toBe(false)

    const stubborn = JSON.parse(
      (
        await run(
          [process.execPath, fixture, "start-ignore-term", workspace, state, hostFile, sessionFile, jobFile],
          env,
        )
      ).trim(),
    ) as { id: string; remote_id?: string }
    expect(stubborn.remote_id).toBeUndefined()
    const stubbornAttached = JSON.parse(
      (await run([process.execPath, fixture, "attach", workspace, state, hostFile, sessionFile, jobFile], env)).trim(),
    ) as { id: string; remote_id: string }
    const stubbornRemoteID = stubbornAttached.remote_id
    expect(stubbornRemoteID).toMatch(/^pid:[0-9]+$/)
    const stubbornPID = Number(stubbornRemoteID.slice(4))
    const stubbornCancelled = JSON.parse(
      (await run([process.execPath, fixture, "cancel", workspace, state, hostFile, sessionFile, jobFile], env)).trim(),
    ) as { status: string; lifecycle: { resource: string }; events: string }
    expect(stubbornCancelled).toMatchObject({ status: "cancelled", lifecycle: { resource: "closed" } })
    expect(stubbornCancelled.events).toContain("Released remote workspace")
    expect(await Bun.file(path.join(remote, ".openscience", "jobs", stubborn.id)).exists()).toBe(false)
    const stubbornAlive = await run(
      [
        "ssh",
        "-T",
        "-F",
        "/dev/null",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-p",
        String(listen),
        `${host.user}@${host.host}`,
        `kill -0 ${stubbornPID} >/dev/null 2>&1 && printf alive || printf gone`,
      ],
      env,
    )
    expect(stubbornAlive).toBe("gone")

    const forked = JSON.parse(
      (
        await run(
          [process.execPath, fixture, "start-double-fork", workspace, state, hostFile, sessionFile, jobFile],
          env,
        )
      ).trim(),
    ) as { id: string; remote_id: string; session_workspace: string }
    const forkedFinished = JSON.parse(
      (await run([process.execPath, fixture, "recover", workspace, state, hostFile, sessionFile, jobFile], env)).trim(),
    ) as { status: string; lifecycle: { resource: string }; log: string }
    expect(forkedFinished).toMatchObject({ status: "succeeded", lifecycle: { resource: "closed" } })
    expect(forkedFinished.log).toContain("leader-done")
    expect(await fs.readFile(path.join(forked.session_workspace, "outputs/double-fork.txt"), "utf8")).toBe(
      "contained\n",
    )
    expect(await Bun.file(path.join(remote, ".openscience", "jobs", forked.id)).exists()).toBe(false)

    const forkCancel = JSON.parse(
      (
        await run(
          [process.execPath, fixture, "start-double-fork-cancel", workspace, state, hostFile, sessionFile, jobFile],
          env,
        )
      ).trim(),
    ) as { id: string; remote_id?: string }
    expect(forkCancel.remote_id).toBeUndefined()
    const forkCancelAttached = JSON.parse(
      (await run([process.execPath, fixture, "attach", workspace, state, hostFile, sessionFile, jobFile], env)).trim(),
    ) as { id: string; remote_id: string }
    expect(forkCancelAttached.remote_id).toMatch(/^pid:[0-9]+$/)
    const pidFile = path.join(remote, ".openscience", "jobs", forkCancel.id, "work", "double-fork.pid")
    const forkDeadline = Date.now() + 3_000
    while (!(await Bun.file(pidFile).exists()) && Date.now() < forkDeadline) await Bun.sleep(20)
    const forkPID = Number(await fs.readFile(pidFile, "utf8"))
    expect(Number.isInteger(forkPID)).toBe(true)
    const forkCancelled = JSON.parse(
      (await run([process.execPath, fixture, "cancel", workspace, state, hostFile, sessionFile, jobFile], env)).trim(),
    ) as { status: string; lifecycle: { resource: string }; events: string }
    expect(forkCancelled).toMatchObject({ status: "cancelled", lifecycle: { resource: "closed" } })
    expect(forkCancelled.events).toContain("Released remote workspace")
    const forkAlive = await run(
      [
        "ssh",
        "-T",
        "-F",
        "/dev/null",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-p",
        String(listen),
        `${host.user}@${host.host}`,
        `kill -0 ${forkPID} >/dev/null 2>&1 && printf alive || printf gone`,
      ],
      env,
    )
    expect(forkAlive).toBe("gone")

    const killed = await run(
      [process.execPath, fixture, "start-killpoint", workspace, state, hostFile, sessionFile, jobFile],
      env,
    ).then(
      () => "unexpected-success",
      (error) => String(error),
    )
    expect(killed).toContain("exited")
    const durable = JSON.parse(await fs.readFile(path.join(state, "jobs.json"), "utf8")) as {
      id: string
      session_id: string
      remote_id?: string
    }[]
    const acceptedRecord = durable.at(-1)
    expect(acceptedRecord?.remote_id).toBeUndefined()
    if (acceptedRecord) {
      await Promise.all([
        fs.writeFile(jobFile, acceptedRecord.id),
        fs.writeFile(sessionFile, acceptedRecord.session_id),
      ])
    }
    const acceptedJob = acceptedRecord?.id ?? ""
    if (acceptedJob) {
      const accepted = path.join(remote, ".openscience", "jobs", acceptedJob)
      const markerDeadline = Date.now() + 3_000
      while (!(await Bun.file(path.join(accepted, "runtime.json")).exists()) && Date.now() < markerDeadline)
        await Bun.sleep(20)
      const recoveredKillpoint = JSON.parse(
        (
          await run([process.execPath, fixture, "recover", workspace, state, hostFile, sessionFile, jobFile], env)
        ).trim(),
      ) as { status: string; remote_id: string; events: string; log: string }
      expect(recoveredKillpoint.status).toBe("succeeded")
      expect(recoveredKillpoint.remote_id).toMatch(/^pid:[0-9]+$/)
      expect(recoveredKillpoint.events).toContain("Reattached")
      expect(recoveredKillpoint.log.match(/remote:payload/g)).toHaveLength(1)
    }
  } finally {
    daemon?.kill("SIGTERM")
    if (daemon) await daemon.exited.catch(() => undefined)
    if (agentPid) process.kill(agentPid, "SIGTERM")
    await fs.rm(root, { recursive: true, force: true })
  }
}, 360_000)
