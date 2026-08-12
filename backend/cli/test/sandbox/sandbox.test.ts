import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Sandbox } from "../../src/sandbox/sandbox"
import { tmpdir } from "../fixture/fixture"

const shell = "/bin/sh"

async function execute(plan: Sandbox.Plan, cwd: string) {
  try {
    return await executeWithoutCleanup(plan, cwd)
  } finally {
    Sandbox.cleanup(plan)
  }
}

async function executeWithoutCleanup(plan: Sandbox.Plan, cwd: string) {
  const proc = Bun.spawn([plan.file, ...(plan.args ?? [])], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exit, stdout, stderr }
}

describe("Sandbox.seatbeltProfile", () => {
  test("denies writes by default and re-allows the workspace", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/work/project"], network: true })
    expect(profile).toContain("(version 1)")
    expect(profile).toContain("(deny default)")
    expect(profile).toContain('(import "system.sb")')
    expect(profile).not.toContain("(allow default)")
    expect(profile).toContain('(subpath "/work/project")')
  })

  test("both policy modes deny all sockets because SBPL cannot filter private CIDR ranges", () => {
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: false })).not.toContain("(allow network*)")
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: true })).not.toContain("(allow network*)")
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: true })).not.toContain("(system-network)")
  })

  test("a path outside the allowlist is not granted write access", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/work/project"], network: true })
    expect(profile).not.toContain('(subpath "/etc/passwd")')
    expect(profile).not.toContain(process.env.HOME + "/.ssh")
  })

  test("adds the macOS /private firmlink alias for /tmp", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/tmp"], network: true })
    expect(profile).toContain(`(subpath "${fs.realpathSync.native("/tmp")}")`)
  })

  test("escapes quotes in paths so the profile cannot be broken out of", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ['/weird/pa"th'], network: true })
    expect(profile).toContain('/weird/pa\\"th')
  })

  test("denies reads of host credential files", () => {
    const profile = Sandbox.seatbeltProfile({
      writable: ["/work/project"],
      unreadable: ["/home/user/.config/atlas-cli/config.json"],
      network: true,
    })
    expect(profile).toContain(
      `(deny file-read* (literal "${fs.realpathSync.native("/home")}/user/.config/atlas-cli/config.json"))`,
    )
  })

  test("allows resolver traversal only on exact ancestors", () => {
    const profile = Sandbox.seatbeltProfile({
      writable: ["/work/project"],
      readable: ["/work/project/packages/server"],
      readableExact: ["/work/project/packages", "/work/project"],
      network: false,
    })
    expect(profile).toContain('(literal "/work/project/packages")')
    expect(profile).toContain('(literal "/work/project")')
    expect(profile).not.toContain('(subpath "/work/project/packages")')
  })
})

describe("Sandbox.bubblewrapArgs", () => {
  test("starts from an empty root and mounts only runtimes plus explicit grants", () => {
    const args = Sandbox.bubblewrapArgs({
      writable: ["/work/project"],
      readable: ["/work/reference"],
      network: true,
    })
    const hostRoot = args.findIndex(
      (value, index) => value === "--ro-bind" && args[index + 1] === "/" && args[index + 2] === "/",
    )
    expect(hostRoot).toBe(-1)
    expect(args).toContain("/usr")
    const readable = args.findIndex(
      (value, index) => value === "--ro-bind-try" && args[index + 1] === "/work/reference",
    )
    expect(args.slice(readable, readable + 3)).toEqual(["--ro-bind-try", "/work/reference", "/work/reference"])
    expect(args).toContain("--die-with-parent")
    expect(args).toContain("--new-session")
    const i = args.indexOf("--bind-try")
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe("/work/project")
    expect(args[i + 2]).toBe("/work/project")
  })

  test("fails closed to an isolated network namespace in both policy modes", () => {
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: false })).toContain("--unshare-net")
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: true })).toContain("--unshare-net")
  })

  test("skips the /tmp tmpfs root but binds workspace paths under it", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/tmp", "/tmp/sub"], network: true })
    expect(args).toContain("--tmpfs")
    const binds = args.flatMap((a, n) => (a === "--bind-try" ? [args[n + 1]!] : []))
    // the /tmp mount root itself is never bound from the host (the tmpfs provides it)
    const tmp = fs.realpathSync.native("/tmp")
    expect(binds).not.toContain(tmp)
    // ...but a workspace living under /tmp must still be bound on top of the tmpfs,
    // otherwise its writes vanish into the throwaway tmpfs
    expect(binds).toContain(path.join(tmp, "sub"))
  })

  test("unshares the PID namespace so /proc escape vectors are closed", () => {
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: true })).toContain("--unshare-pid")
  })

  test("does not implicitly expose Linux user-data roots", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/work/project"], network: false })
    const sources = args.flatMap((value, index) =>
      value === "--ro-bind" || value === "--ro-bind-try" || value === "--bind" || value === "--bind-try"
        ? [args[index + 1]!]
        : [],
    )
    expect(sources).not.toContain("/")
    expect(sources).not.toContain("/home")
    expect(sources).not.toContain("/root")
    expect(sources).not.toContain("/var")
  })

  test("masks host credential files with an empty device", () => {
    const file = path.join(os.tmpdir(), `openscience-sandbox-secret-${process.pid}`)
    fs.writeFileSync(file, "secret")
    try {
      const args = Sandbox.bubblewrapArgs({
        writable: ["/work/project"],
        unreadable: [file],
        network: true,
      })
      const mask = args.findIndex((value, index) => value === "--ro-bind-try" && args[index + 1] === "/dev/null")
      expect(args.slice(mask, mask + 3)).toEqual(["--ro-bind-try", "/dev/null", fs.realpathSync.native(file)])
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
      network: true,
    })
    expect(args).not.toContain(file)
  })

  test("covers an existing credential directory with an empty tmpfs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `openscience-sandbox-credentials-${process.pid}-`))
    try {
      const args = Sandbox.bubblewrapArgs({ writable: ["/work/project"], unreadable: [directory], network: true })
      const mask = args.findIndex(
        (value, index) => value === "--tmpfs" && args[index + 1] === fs.realpathSync.native(directory),
      )
      expect(mask).toBeGreaterThan(-1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
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
      network: false,
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

  test.skipIf(Sandbox.backend() !== "bubblewrap")(
    "keeps a setsid double-fork inside the PID namespace and kills it with the wrapper",
    async () => {
      if (!Bun.which("python3")) return
      await using tmp = await tmpdir()
      const marker = path.join(tmp.path, "double-fork.pid")
      const script = [
        "import os,time",
        "os.fork() and os._exit(0)",
        "os.setsid()",
        "os.fork() and os._exit(0)",
        `open(${JSON.stringify(marker)}, 'w').write('ready')`,
        "time.sleep(3600)",
      ].join(";")
      const plan = Sandbox.plan({
        command: `python3 -c ${JSON.stringify(script)}`,
        shell,
        cwd: tmp.path,
        workspace: [tmp.path],
        options: { enabled: true, network: "deny", onUnavailable: "error" },
      })
      const proc = Bun.spawn([plan.file, ...(plan.args ?? [])], {
        cwd: tmp.path,
        stdout: "ignore",
        stderr: "pipe",
      })
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      const hostPID = () =>
        fs
          .readdirSync("/proc")
          .filter((value) => /^\d+$/.test(value))
          .map(Number)
          .find((pid) => {
            try {
              const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
              return path.basename(argv[0] ?? "").startsWith("python") && argv.some((value) => value.includes(marker))
            } catch {
              return false
            }
          })
      const escaped = { pid: 0 }
      try {
        for (let attempt = 0; attempt < 300 && !fs.existsSync(marker); attempt++) await Bun.sleep(10)
        expect(fs.existsSync(marker)).toBe(true)
        escaped.pid = hostPID() ?? 0
        expect(escaped.pid).toBeGreaterThan(0)
        expect(alive(escaped.pid)).toBe(true)

        // The initial Python process has exited twice, but bwrap's namespace
        // reaper still owns the daemon and therefore has not reported exit.
        expect(proc.exitCode).toBeNull()
        proc.kill("SIGKILL")
        await proc.exited
        for (let attempt = 0; attempt < 300 && alive(escaped.pid); attempt++) await Bun.sleep(10)
        expect(alive(escaped.pid)).toBe(false)
      } finally {
        if (proc.exitCode === null) {
          proc.kill("SIGKILL")
          await proc.exited
        }
        if (escaped.pid && alive(escaped.pid)) process.kill(escaped.pid, "SIGKILL")
        Sandbox.cleanup(plan)
      }
    },
  )
})

describe("Sandbox.backend/describe", () => {
  test("describe() is internally consistent with backend()", () => {
    const d = Sandbox.describe()
    expect(d.backend).toBe(Sandbox.backend())
    expect(d.available).toBe(Sandbox.available())
    expect(d.platform).toBe(process.platform)
    if (d.available) expect(d.tool).toBeTruthy()
    else expect(d.reason).toBeTruthy()
    if (d.available) expect(d.networkIsolation).toBe("deny_all")
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
      expect(p.temporary).toBeTruthy()
      expect(p.args).toContain(`TMPDIR=${p.temporary}`)
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

  test("does not expose the user's home when PATH itself contains that broad root", () => {
    if (!Sandbox.available()) return
    const before = process.env.PATH
    process.env.PATH = `${os.homedir()}${path.delimiter}/usr/bin`
    try {
      const plan = Sandbox.plan({
        ...base,
        options: { enabled: true, network: "deny" },
      })
      try {
        const argv = plan.args ?? []
        expect(argv).not.toContain(os.homedir())
        expect(argv.join(" ")).not.toContain(`(subpath "${os.homedir()}")`)
      } finally {
        Sandbox.cleanup(plan)
      }
    } finally {
      if (before === undefined) delete process.env.PATH
      else process.env.PATH = before
    }
  })

  test("rejects relative, broken-symlink, and over-broad writable grants", () => {
    expect(Sandbox.writableGrant("relative/path")).toBeUndefined()
    expect(Sandbox.writableGrant("/")).toBeUndefined()
    expect(Sandbox.writableGrant(os.homedir())).toBeUndefined()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-policy-path-"))
    try {
      expect(Sandbox.writableGrant(path.join(root, "future", "results"))).toBe(
        path.join(fs.realpathSync.native(root), "future", "results"),
      )
      if (process.platform !== "win32") {
        const broken = path.join(root, "broken")
        fs.symlinkSync(path.join(root, "missing"), broken)
        expect(Sandbox.writableGrant(broken)).toBeUndefined()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("Sandbox native isolation", () => {
  test.skipIf(!Sandbox.available())(
    "enforces separate canonical read and write grants and blocks symlink escapes",
    async () => {
      const root = fs.mkdtempSync(path.join(os.homedir(), ".openscience-read-grants-"))
      const work = path.join(root, "work")
      const readonly = path.join(root, "readonly")
      const secret = path.join(root, "secret.txt")
      fs.mkdirSync(work)
      fs.mkdirSync(readonly)
      fs.writeFileSync(path.join(readonly, "data.txt"), "granted")
      fs.writeFileSync(secret, "secret")
      fs.symlinkSync(secret, path.join(work, "escape"))
      const options = { enabled: true, network: "deny" as const, onUnavailable: "error" as const }

      try {
        const granted = Sandbox.plan({
          command: `cat "${path.join(readonly, "data.txt")}"`,
          shell,
          cwd: work,
          workspace: [work],
          readable: [readonly],
          options,
        })
        expect(await execute(granted, work)).toMatchObject({ exit: 0, stdout: "granted" })

        const masked = Sandbox.plan({
          command: `cat "${path.join(readonly, "data.txt")}"`,
          shell,
          cwd: work,
          workspace: [work],
          readable: [readonly],
          unreadable: [path.join(readonly, "data.txt")],
          options,
        })
        expect((await execute(masked, work)).exit).not.toBe(0)

        const mutate = Sandbox.plan({
          command: `printf changed > "${path.join(readonly, "data.txt")}"`,
          shell,
          cwd: work,
          workspace: [work],
          readable: [readonly],
          options,
        })
        expect((await execute(mutate, work)).exit).not.toBe(0)
        expect(fs.readFileSync(path.join(readonly, "data.txt"), "utf8")).toBe("granted")

        const ungranted = Sandbox.plan({
          command: `cat "${secret}"`,
          shell,
          cwd: work,
          workspace: [work],
          readable: [readonly],
          options,
        })
        expect((await execute(ungranted, work)).exit).not.toBe(0)

        const escaped = Sandbox.plan({
          command: `cat "${path.join(work, "escape")}"`,
          shell,
          cwd: work,
          workspace: [work],
          options,
        })
        expect((await execute(escaped, work)).exit).not.toBe(0)

        const broken = path.join(root, "broken")
        fs.symlinkSync(path.join(root, "missing"), broken)
        const ambiguous = Sandbox.plan({
          command: "true",
          shell,
          cwd: work,
          workspace: [work],
          readable: [broken],
          options,
        })
        expect((ambiguous.args ?? []).join(" ")).not.toContain(broken)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(!Sandbox.available())("does not expose sibling files in the user's temp directory", async () => {
    await using tmp = await tmpdir()
    const sibling = path.join(os.tmpdir(), `.openscience-sandbox-sibling-${process.pid}`)
    fs.writeFileSync(sibling, "private sibling", { mode: 0o600 })
    try {
      const plan = Sandbox.plan({
        command: `cat "${sibling}"`,
        shell,
        cwd: tmp.path,
        workspace: [tmp.path],
        options: { enabled: true, network: "deny", onUnavailable: "error" },
      })
      expect((await execute(plan, tmp.path)).exit).not.toBe(0)
      const argv = (plan.args ?? []).join(" ")
      expect(plan.temporary).toBeTruthy()
      expect(argv).toContain(plan.temporary!)
      expect(argv).not.toContain(`(subpath "${fs.realpathSync.native(os.tmpdir())}")`)
    } finally {
      fs.rmSync(sibling, { force: true })
    }
  })

  test.skipIf(!Sandbox.available())(
    "isolates unique temp roots between parallel sandbox plans and cleans them",
    async () => {
      await using firstWorkspace = await tmpdir()
      await using secondWorkspace = await tmpdir()
      const options = { enabled: true, network: "deny", onUnavailable: "error" } as const
      const first = Sandbox.plan({
        command: 'sleep 0.2; cat "$TMPDIR/owned"',
        shell,
        cwd: firstWorkspace.path,
        workspace: [firstWorkspace.path],
        options,
      })
      expect(first.temporary).toBeTruthy()
      fs.writeFileSync(path.join(first.temporary!, "owned"), "first-only", { mode: 0o600 })
      const second = Sandbox.plan({
        command: `cat "${path.join(first.temporary!, "owned")}"`,
        shell,
        cwd: secondWorkspace.path,
        workspace: [secondWorkspace.path],
        options,
      })
      expect(second.temporary).toBeTruthy()
      expect(second.temporary).not.toBe(first.temporary)
      try {
        const [own, sibling] = await Promise.all([
          executeWithoutCleanup(first, firstWorkspace.path),
          executeWithoutCleanup(second, secondWorkspace.path),
        ])
        expect(own.exit, own.stderr).toBe(0)
        expect(own.stdout.trim()).toBe("first-only")
        expect(sibling.exit).not.toBe(0)
      } finally {
        const firstTemp = first.temporary!
        const secondTemp = second.temporary!
        Sandbox.cleanup(first)
        Sandbox.cleanup(second)
        expect(fs.existsSync(firstTemp)).toBe(false)
        expect(fs.existsSync(secondTemp)).toBe(false)
      }
    },
  )

  test.skipIf(!Sandbox.available())("hides sibling host processes", async () => {
    await using tmp = await tmpdir()
    const sibling = Bun.spawn(["/bin/sleep", "10"], { stdout: "ignore", stderr: "ignore" })
    try {
      const control = Bun.spawn(["/bin/ps", "-p", String(sibling.pid), "-o", "pid="], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect((await new Response(control.stdout).text()).trim()).toBe(String(sibling.pid))
      expect(await control.exited).toBe(0)

      const plan = Sandbox.plan({
        command: `/bin/ps -p ${sibling.pid} -o pid=`,
        shell,
        cwd: tmp.path,
        workspace: [tmp.path],
        options: { enabled: true, network: "deny", onUnavailable: "error" },
      })
      const isolated = await execute(plan, tmp.path)
      expect(isolated.exit).not.toBe(0)
      expect(isolated.stdout.trim()).toBe("")
    } finally {
      sibling.kill()
      await sibling.exited
    }
  })

  test.skipIf(!Sandbox.available())("blocks loopback and the host LAN interface in both policy modes", async () => {
    if (!Bun.which("curl")) return
    await using tmp = await tmpdir()
    const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("local endpoint") })
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((address) => address?.family === "IPv4" && !address.internal)?.address
    const targets = [`http://127.0.0.1:${server.port}`, ...(lan ? [`http://${lan}:${server.port}`] : [])]
    try {
      for (const target of targets) {
        expect(await fetch(target).then((response) => response.text())).toBe("local endpoint")
      }
      for (const network of ["allow", "deny"] as const) {
        for (const target of targets) {
          const plan = Sandbox.plan({
            command: `curl -m 2 -sS "${target}"`,
            shell,
            cwd: tmp.path,
            workspace: [tmp.path],
            options: { enabled: true, network, onUnavailable: "error" },
          })
          expect((await execute(plan, tmp.path)).exit).not.toBe(0)
        }
      }
    } finally {
      server.stop(true)
    }
  })
})
