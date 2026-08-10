import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Sandbox } from "../../src/sandbox/sandbox"
import { tmpdir } from "../fixture/fixture"

const shell = "/bin/sh"

describe("Sandbox.seatbeltProfile", () => {
  test("denies writes by default and re-allows the workspace", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/work/project"], network: "allow" })
    expect(profile).toContain("(version 1)")
    expect(profile).toContain("(allow default)")
    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain('(subpath "/work/project")')
  })

  test('network:"deny" adds a network deny; network:"allow" does not', () => {
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: "deny" })).toContain("(deny network*)")
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: "allow" })).not.toContain("(deny network*)")
  })

  test("a path outside the allowlist is not granted write access", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/work/project"], network: "allow" })
    expect(profile).not.toContain('(subpath "/etc/passwd")')
    expect(profile).not.toContain(process.env.HOME + "/.ssh")
  })

  test("adds the macOS /private firmlink alias for /tmp", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/tmp"], network: "allow" })
    expect(profile).toContain('(subpath "/tmp")')
    expect(profile).toContain('(subpath "/private/tmp")')
  })

  test("escapes quotes in paths so the profile cannot be broken out of", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ['/weird/pa"th'], network: "allow" })
    expect(profile).toContain('/weird/pa\\"th')
  })

  test("denies reads of host credential files", () => {
    const profile = Sandbox.seatbeltProfile({
      writable: ["/work/project"],
      unreadable: ["/home/user/.config/atlas-cli/config.json"],
      network: "allow",
    })
    expect(profile).toContain('(deny file-read* (literal "/home/user/.config/atlas-cli/config.json"))')
  })
})

describe("Sandbox.bubblewrapArgs", () => {
  test("mounts the fs read-only then re-binds the workspace writable", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/work/project"], network: "allow" })
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]) // whole fs read-only first
    expect(args).toContain("--die-with-parent")
    const i = args.indexOf("--bind-try")
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe("/work/project")
    expect(args[i + 2]).toBe("/work/project")
  })

  test('network:"deny" unshares the network namespace', () => {
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: "deny" })).toContain("--unshare-net")
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: "allow" })).not.toContain("--unshare-net")
  })

  test("skips the /tmp tmpfs root but binds workspace paths under it", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/tmp", "/tmp/sub"], network: "allow" })
    expect(args).toContain("--tmpfs")
    const binds = args.flatMap((a, n) => (a === "--bind-try" ? [args[n + 1]!] : []))
    // the /tmp mount root itself is never bound from the host (the tmpfs provides it)
    expect(binds).not.toContain("/tmp")
    // ...but a workspace living under /tmp must still be bound on top of the tmpfs,
    // otherwise its writes vanish into the throwaway tmpfs
    expect(binds).toContain("/tmp/sub")
  })

  test("unshares the PID namespace so /proc escape vectors are closed", () => {
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: "allow" })).toContain("--unshare-pid")
  })

  test("masks host credential files with an empty device", () => {
    const file = path.join(os.tmpdir(), `openscience-sandbox-secret-${process.pid}`)
    fs.writeFileSync(file, "secret")
    try {
      const args = Sandbox.bubblewrapArgs({
        writable: ["/work/project"],
        unreadable: [file],
        network: "allow",
      })
      const mask = args.findIndex((value, index) => value === "--ro-bind-try" && args[index + 1] === "/dev/null")
      expect(args.slice(mask, mask + 3)).toEqual(["--ro-bind-try", "/dev/null", file])
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  test("does not ask bubblewrap to create a missing credential mask under the read-only root", () => {
    const file = path.join(os.tmpdir(), `openscience-sandbox-missing-${process.pid}`)
    fs.rmSync(file, { force: true })
    const args = Sandbox.bubblewrapArgs({
      writable: ["/work/project"],
      unreadable: [file],
      network: "allow",
    })
    expect(args).not.toContain(file)
  })

  test.skipIf(Sandbox.backend() !== "bubblewrap")("produces an argv bwrap actually accepts", async () => {
    await using tmp = await tmpdir()
    const present = path.join(tmp.path, "auth.json")
    await Bun.write(present, "{}")

    // The missing mask target has to sit on the read-only bind, the way a real
    // ~/.local/share credential file does — a path under the sandbox's own
    // tmpfs would be creatable and hide the failure.
    const missing = path.join(os.homedir(), `.openscience-absent-${process.pid}.json`)
    const args = Sandbox.bubblewrapArgs({
      writable: [tmp.path],
      unreadable: [present, missing],
      network: "deny",
    })
    const proc = Bun.spawn(["bwrap", ...args, "--", "/bin/echo", "ok"], { stdout: "pipe", stderr: "pipe" })
    const [out, error, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(exit, error).toBe(0)
    expect(out.trim()).toBe("ok")
  })
})

describe("Sandbox.backend/describe", () => {
  test("describe() is internally consistent with backend()", () => {
    const d = Sandbox.describe()
    expect(d.backend).toBe(Sandbox.backend())
    expect(d.available).toBe(Sandbox.available())
    expect(d.platform).toBe(process.platform)
    if (d.available) expect(d.tool).toBeTruthy()
    else expect(d.reason).toBeTruthy()
  })
})

describe("Sandbox.plan", () => {
  const base = { command: "echo hi", shell, cwd: "/work/project", workspace: ["/work/project"] }

  test("disabled → runs the raw command unchanged", () => {
    const p = Sandbox.plan({ ...base, options: { enabled: false } })
    expect(p.sandboxed).toBe(false)
    expect(p.file).toBe("echo hi")
    expect(p.useShell).toBe(shell)
    expect(p.args).toBeUndefined()
  })

  test("no options → runs the raw command unchanged", () => {
    const p = Sandbox.plan(base)
    expect(p.sandboxed).toBe(false)
  })

  test("enabled → sandboxed when a backend exists, else degrades", () => {
    // network is orthogonal to what this test checks; pin it to "allow" so the
    // assertions below aren't coupled to the "allowlist" default's egress requirement
    const p = Sandbox.plan({ ...base, options: { enabled: true, network: "allow" } })
    if (Sandbox.available()) {
      expect(p.sandboxed).toBe(true)
      expect(["sandbox-exec", "bwrap"]).toContain(p.file)
      expect(p.useShell).toBe(false)
      // the actual shell command lives at the tail of the argv
      expect(p.args).toContain("echo hi")
      expect(p.args).toContain(shell)
    } else {
      expect(p.sandboxed).toBe(false)
    }
  })

  test("onUnavailable:error throws when no backend is available", () => {
    if (Sandbox.available()) return // only meaningful without a backend
    expect(() => Sandbox.plan({ ...base, options: { enabled: true, onUnavailable: "error" } })).toThrow()
  })

  test("makes the workspace writable but not an out-of-workspace cwd", () => {
    if (!Sandbox.available()) return
    const p = Sandbox.plan({
      command: "true",
      shell,
      cwd: "/work/elsewhere",
      workspace: ["/work/project"],
      options: { enabled: true, network: "allow" },
    })
    const argv = (p.args ?? []).join(" ")
    expect(argv).toContain("/work/project")
    // an approved external cwd is a permission decision, not a reason to widen
    // the sandbox's write boundary to the escape target
    expect(argv).not.toContain("/work/elsewhere")
  })

  test("drops over-broad writable roots (worktree='/', $HOME) from the policy", () => {
    if (!Sandbox.available()) return
    const p = Sandbox.plan({
      command: "true",
      shell,
      cwd: "/work/project",
      workspace: ["/work/project", "/"],
      options: { enabled: true, network: "allow", allowWrite: [os.homedir()] },
    })
    const argv = (p.args ?? []).join(" ")
    expect(argv).toContain("/work/project")
    // "/" must never become a writable root (seatbelt subpath / bwrap bind)
    expect(argv).not.toContain('(subpath "/")')
    expect(argv).not.toContain("--bind-try / /")
    // nor $HOME itself
    expect(argv).not.toContain(`(subpath "${os.homedir()}")`)
  })
})

describe("Sandbox network policy", () => {
  test("deny unshares the network and binds no socket", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/w"], network: "deny" })
    expect(args).toContain("--unshare-net")
    expect(args.join(" ")).not.toContain(".sock")
  })

  test("allow neither unshares nor binds", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/w"], network: "allow" })
    expect(args).not.toContain("--unshare-net")
  })

  // The namespace must stay severed — the socket is the ONLY route out. If
  // --unshare-net were dropped here the proxy would become advisory.
  test("allowlist unshares the network AND binds the socket", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/w"], network: "allowlist", egress: "/run/os/e.sock" })
    expect(args).toContain("--unshare-net")
    const at = args.indexOf("/run/os/e.sock")
    expect(at).toBeGreaterThan(0)
    expect(args[at - 1]).toBe("--bind")
  })

  test("allowlist without a socket path is refused rather than silently opened", () => {
    expect(() => Sandbox.bubblewrapArgs({ writable: ["/w"], network: "allowlist" })).toThrow()
  })

  // buildPolicy filters `egress` through the same tooBroadToConfine gate as
  // `writable`/`unreadable`. An over-broad egress (e.g. $HOME, or "/") must never
  // reach argv as a read-write --bind: that would defeat write containment
  // entirely, not just widen network access. Proven previously by calling
  // bubblewrapArgs directly with an unfiltered `egress: $HOME`, which emitted
  // "--bind $HOME $HOME" and let a sandboxed write escape to the real $HOME.
  // Going through the public plan() (which runs buildPolicy) instead: the
  // over-broad path is dropped, so "allowlist" is left without an egress socket
  // and refuses to run — it fails closed rather than silently binding it.
  test("an over-broad egress path ($HOME) is dropped, not bound as a read-write escape hatch", () => {
    if (!Sandbox.available()) return
    expect(() =>
      Sandbox.plan({
        command: "true",
        shell,
        cwd: "/work/project",
        workspace: ["/work/project"],
        options: { enabled: true, network: "allowlist", egress: os.homedir() },
      }),
    ).toThrow()
  })

  // Seatbelt has no namespace, so the enforcement argument does not transfer.
  // Falling back to deny is safe; falling back to allow would silently grant
  // unrestricted egress to a user who asked for a bounded one.
  test("seatbelt treats allowlist as deny, never as allow", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/w"], network: "allowlist", egress: "/run/os/e.sock" })
    expect(profile).toContain("(deny network*)")
  })
})
