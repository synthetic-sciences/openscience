import { describe, expect, test } from "bun:test"
import os from "os"
import { Sandbox } from "../../src/sandbox/sandbox"

const shell = "/bin/sh"

describe("Sandbox.seatbeltProfile", () => {
  test("denies writes by default and re-allows the workspace", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/work/project"], network: true })
    expect(profile).toContain("(version 1)")
    expect(profile).toContain("(allow default)")
    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain('(subpath "/work/project")')
  })

  test("network:false adds a network deny; network:true does not", () => {
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: false })).toContain("(deny network*)")
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: true })).not.toContain("(deny network*)")
  })

  test("a path outside the allowlist is not granted write access", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/work/project"], network: true })
    expect(profile).not.toContain('(subpath "/etc/passwd")')
    expect(profile).not.toContain(process.env.HOME + "/.ssh")
  })

  test("adds the macOS /private firmlink alias for /tmp", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/tmp"], network: true })
    expect(profile).toContain('(subpath "/tmp")')
    expect(profile).toContain('(subpath "/private/tmp")')
  })

  test("escapes quotes in paths so the profile cannot be broken out of", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ['/weird/pa"th'], network: true })
    expect(profile).toContain('/weird/pa\\"th')
  })
})

describe("Sandbox.bubblewrapArgs", () => {
  test("mounts the fs read-only then re-binds the workspace writable", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/work/project"], network: true })
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]) // whole fs read-only first
    expect(args).toContain("--die-with-parent")
    const i = args.indexOf("--bind-try")
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe("/work/project")
    expect(args[i + 2]).toBe("/work/project")
  })

  test("network:false unshares the network namespace", () => {
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: false })).toContain("--unshare-net")
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: true })).not.toContain("--unshare-net")
  })

  test("skips the /tmp tmpfs root but binds workspace paths under it", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/tmp", "/tmp/sub"], network: true })
    expect(args).toContain("--tmpfs")
    const binds = args.flatMap((a, n) => (a === "--bind-try" ? [args[n + 1]!] : []))
    // the /tmp mount root itself is never bound from the host (the tmpfs provides it)
    expect(binds).not.toContain("/tmp")
    // ...but a workspace living under /tmp must still be bound on top of the tmpfs,
    // otherwise its writes vanish into the throwaway tmpfs
    expect(binds).toContain("/tmp/sub")
  })

  test("unshares the PID namespace so /proc escape vectors are closed", () => {
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: true })).toContain("--unshare-pid")
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
    const p = Sandbox.plan({ ...base, options: { enabled: true } })
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
      options: { enabled: true },
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
      options: { enabled: true, allowWrite: [os.homedir()] },
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
