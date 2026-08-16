import { expect, test } from "bun:test"
import path from "path"
import { AppContainer } from "../../src/sandbox/appcontainer"
import { Installer } from "../../src/package/installer"
import { Sandbox } from "../../src/sandbox/sandbox"

/**
 * One measurement, on real hardware, that decides how Windows egress is built.
 *
 * The container cannot connect OUT to the host's loopback — the probe measured
 * that (timeout). The design therefore assumes a named pipe as the only
 * transport across the boundary, which in Bun means `CreateNamedPipeW` with a
 * hand-built DACL plus overlapped I/O through FFI: heavy, and every Win32 step
 * in this feature has cost several iterations.
 *
 * But the probe never tested the REVERSE direction. If the host can connect IN
 * to a listener the container binds, the transport is plain TCP that Bun handles
 * natively and the pipe disappears entirely.
 *
 * This file measures that and asserts nothing about the answer, deliberately.
 * A red CI job should mean a defect, not an open question — so the assertion is
 * only that the child bound a port (which container-internal loopback already
 * proved possible), and the direction under test is reported for a human to read
 * once. It becomes a real assertion as soon as we know which way it goes.
 */

const windows = process.platform === "win32"

test.if(windows)(
  "can the host reach a listener bound inside the container?",
  async () => {
    const python = (await Installer.select()).binary
    expect(python).toBeTruthy()

    // Bind, announce the port, accept one connection, answer. Nothing here needs
    // network access: the container binds its own loopback, which is permitted.
    const script = [
      "import socket,sys",
      "s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(1)",
      "print(s.getsockname()[1],flush=True)",
      "c,_=s.accept(); c.sendall(b'reached'); c.close()",
    ].join("\n")

    const wrapped = Sandbox.wrapArgv({
      file: python!,
      args: ["-u", "-c", script],
      workspace: [process.cwd()],
      // The interpreter lives outside the workspace, so it must be granted read
      // and execute or the container cannot start it.
      readable: [path.dirname(python!)],
      options: { enabled: true, network: "deny" },
    })
    expect(wrapped.sandboxed).toBe(true)

    const child = Bun.spawn([wrapped.file, ...wrapped.args], { stdout: "pipe", stderr: "pipe" })
    try {
      const reader = child.stdout.getReader()
      const deadline = Date.now() + 30_000
      let buffered = ""
      let port = 0
      while (!port && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += new TextDecoder().decode(value)
        port = Number(buffered.trim().split("\n")[0]) || 0
      }
      console.log(`  child bound 127.0.0.1:${port}`)
      expect(port).toBeGreaterThan(0)

      // The question. A host process has no isolation restriction outbound, but
      // whether Windows permits it to land on a socket owned by an AppContainer is
      // exactly what nobody has measured.
      const answer = await Bun.connect<undefined>({
        hostname: "127.0.0.1",
        port,
        socket: { data() {}, open() {}, close() {}, error() {} },
      })
        .then(() => "REACHED")
        .catch((error: Error) => `REFUSED (${error.message})`)

      console.log(`\n  ===> host -> container listener: ${answer}\n`)
      // Isolation runs both ways. If this ever reaches, Windows has relaxed
      // AppContainer network isolation and the transport can lose the pipe.
      expect(answer).toStartWith("REFUSED")
    } finally {
      child.kill()
    }
  },
  120_000,
)

test.if(windows)(
  "only this container can open the broker pipe",
  async () => {
    // The measurement that decides whether the broker is buildable, taken before
    // writing it. The probe measured these two halves with .NET; this takes them
    // through OUR stack, because a grant that works in PowerShell but not through
    // bun:ffi would surface at the worst possible moment.
    //
    // Two claims, and the second matters more than the first:
    //   1. a pipe whose DACL names the package SID IS reachable from inside
    //   2. the DACL is doing the work - a DEFAULT one is NOT
    // Without (2) this proves nothing about confinement: a pipe anyone could
    // open would also satisfy (1). So the negative case creates a REAL pipe with
    // libuv's default security rather than pointing the child at a path that
    // does not exist - which would fail for the wrong reason and look identical.
    const python = (await Installer.select()).binary
    // The SAME profile the sandbox will put the child in, not one of our own.
    // Granting a pipe to a container nothing runs in denies exactly like having
    // no grant at all -- which is how the first run of this read, with both
    // halves reporting PermissionError and no way to tell them apart.
    const sid = AppContainer.ensureProfile(Sandbox.appContainerProfile([process.cwd()]))
    const stamp = `${process.pid}-${Date.now().toString(36)}`

    const script = (pipe: string) =>
      [
        `p = r'${AppContainer.pipePath(pipe)}'`,
        "try:",
        "    f = open(p, 'r+b', buffering=0)",
        "    f.write(b'ping'); f.flush()",
        "    print('OPENED', f.read(9).decode(), flush=True)",
        "except Exception as e:",
        "    print('DENIED', type(e).__name__, flush=True)",
      ].join("\n")

    // Always read the child, even when the host side gives up. A harness that
    // reports only its own timeout cannot tell "the DACL denied it" from "python
    // never started" - which is the one distinction it exists to make, and the
    // reason its first run taught us nothing.
    const attempt = (pipe: string) => {
      const wrapped = Sandbox.wrapArgv({
        file: python!,
        args: ["-u", "-c", script(pipe)],
        workspace: [process.cwd()],
        readable: [path.dirname(python!)],
        options: { enabled: true, network: "deny" },
      })
      const child = Bun.spawn([wrapped.file, ...wrapped.args], { stdout: "pipe", stderr: "pipe" })
      const said = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      return async () => {
        const [out, err] = await said
        return `${out.trim()}${err.trim() ? ` | stderr: ${err.trim().split("\n")[0]}` : ""}`
      }
    }

    // 1. Granted.
    const grantedPipe = `openscience-broker-${stamp}`
    const handle = AppContainer.createPipe(grantedPipe, sid)
    const grantedSaid = attempt(grantedPipe)
    let echoed: string
    try {
      echoed = AppContainer.pipeEchoOnce(handle, 30_000)
    } catch (error) {
      echoed = `<host gave up: ${(error as Error).message}>`
    }
    const granted = await grantedSaid()
    console.log(`  granted DACL -> child said: ${granted}`)
    console.log(`  granted DACL -> host read:  ${echoed}`)

    // 2. Default DACL: a REAL pipe, created by libuv with none of our security
    // attributes, so the only difference from (1) is the descriptor.
    const barePipe = `openscience-bare-${stamp}`
    const net = await import("node:net")
    const bare = net.createServer((socket) => socket.end("echo:ping"))
    await new Promise<void>((resolve) => bare.listen(AppContainer.pipePath(barePipe), () => resolve()))
    const denied = await attempt(barePipe)()
    bare.close()
    console.log(`  default DACL -> child said: ${denied}`)

    expect(granted).toContain("OPENED")
    expect(echoed).toBe("ping")
    // The grant is load-bearing, not decorative.
    expect(denied).toContain("DENIED")
  },
  180_000,
)

test.if(windows)(
  "which client primitive speaks named pipes",
  async () => {
    // Decides whether the in-container shim needs writing at all.
    //
    // `Egress.serveShim` already does precisely what the Windows shim must do —
    // accept on TCP loopback, relay to a socket path — and it connects with
    // `Bun.connect({ unix })`. libuv treats a `\\.\pipe\...` path as a named pipe,
    // so IF Bun's `unix:` option goes through that path, the shim is
    // `serveShim({ port, socket: pipePath })` and there is no new code to write.
    //
    // If it does not, `node:net` certainly does, and the shim becomes a small
    // variant that differs only in how it dials. Measured rather than assumed
    // because the difference is "no work" versus "a new relay to test".
    const net = await import("node:net")
    const name = `openscience-probe-${process.pid}-${Date.now().toString(36)}`
    const path_ = AppContainer.pipePath(name)
    const server = net.createServer((socket) => socket.end("pong"))
    await new Promise<void>((resolve) => server.listen(path_, () => resolve()))

    const viaBun = await Bun.connect<undefined>({
      unix: path_,
      socket: { data() {}, open() {}, close() {}, error() {} },
    })
      .then((s) => {
        s.end()
        return "CONNECTED"
      })
      .catch((error: Error) => `FAILED (${error.message})`)

    const viaNode = await new Promise<string>((resolve) => {
      const socket = net.connect(path_, () => {
        socket.end()
        resolve("CONNECTED")
      })
      socket.on("error", (error) => resolve(`FAILED (${error.message})`))
    })

    server.close()
    console.log(`\n  Bun.connect({unix})  -> ${viaBun}`)
    console.log(`  node:net.connect()   -> ${viaNode}\n`)
    console.log(
      viaBun === "CONNECTED"
        ? "  serveShim works unchanged: the shim is serveShim({port, socket: pipePath})."
        : "  serveShim needs a Windows dial path; node:net is the primitive to use.",
    )

    // node:net is the floor — if even that cannot reach a pipe, the transport
    // assumption underneath this whole design is wrong and everything else is
    // moot, so that is the only hard assertion here.
    expect(viaNode).toBe("CONNECTED")
  },
  60_000,
)
