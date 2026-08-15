import { describe, expect, test } from "bun:test"
import fs from "fs"
import { builtinModules } from "module"
import os from "os"
import path from "path"
import { ProcessIdentity } from "../../src/process/process-identity"
import { Sandbox } from "../../src/sandbox/sandbox"
import { SHIM_READY_MARKER } from "../../src/sandbox/egress-shim-marker"
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
    const profile = Sandbox.seatbeltProfile({ writable: ["/work/project"], network: "allow" })
    expect(profile).toContain("(version 1)")
    expect(profile).toContain("(deny default)")
    expect(profile).toContain('(import "system.sb")')
    expect(profile).not.toContain("(allow default)")
    expect(profile).toContain('(subpath "/work/project")')
  })

  test("both policy modes deny all sockets because SBPL cannot filter private CIDR ranges", () => {
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: "deny" })).not.toContain("(allow network*)")
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: "allow" })).not.toContain("(allow network*)")
    expect(Sandbox.seatbeltProfile({ writable: ["/w"], network: "allow" })).not.toContain("(system-network)")
  })

  test("a path outside the allowlist is not granted write access", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/work/project"], network: "allow" })
    expect(profile).not.toContain('(subpath "/etc/passwd")')
    expect(profile).not.toContain(process.env.HOME + "/.ssh")
  })

  test("adds the macOS /private firmlink alias for /tmp", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/tmp"], network: "allow" })
    expect(profile).toContain(`(subpath "${fs.realpathSync.native("/tmp")}")`)
  })

  test("escapes quotes in paths so the profile cannot be broken out of", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ['/weird/pa"th'], network: "allow" })
    expect(profile).toContain('/weird/pa\\"th')
  })

  test("denies reads and writes of host-managed sensitive paths", () => {
    const profile = Sandbox.seatbeltProfile({
      writable: ["/work/project"],
      unreadable: ["/home/user/.config/atlas-cli/config.json"],
      network: "allow",
    })
    expect(profile).toContain(
      `(deny file-read* (literal "${fs.realpathSync.native("/home")}/user/.config/atlas-cli/config.json"))`,
    )
    expect(profile).toContain(
      `(deny file-write* (literal "${fs.realpathSync.native("/home")}/user/.config/atlas-cli/config.json"))`,
    )
  })

  test("allows resolver traversal only on exact ancestors", () => {
    const profile = Sandbox.seatbeltProfile({
      writable: ["/work/project"],
      readable: ["/work/project/packages/server"],
      readableExact: ["/work/project/packages", "/work/project"],
      network: "deny",
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
      network: "allow",
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

  test("mounts canonical sources at normalized stable alias destinations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-bwrap-alias-"))
    const source = path.join(root, "physical")
    const destination = path.join(root, "config", "data-root")
    fs.mkdirSync(source)
    try {
      const canonicalSource = fs.realpathSync.native(source)
      const args = Sandbox.bubblewrapArgs({
        writable: [source],
        writableAliases: [{ source, destination: path.join(destination, "nested", "..") }],
        network: "deny",
      })
      const alias = args.findIndex(
        (value, index) =>
          value === "--bind-try" && args[index + 1] === canonicalSource && args[index + 2] !== canonicalSource,
      )
      expect(args.slice(alias, alias + 3)).toEqual(["--bind-try", canonicalSource, destination])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not reintroduce a filtered broad source through a narrow readable alias", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-bwrap-broad-alias-"))
    const alias = path.join(root, "narrow")
    fs.symlinkSync("/", alias, "dir")
    try {
      const args = Sandbox.bubblewrapArgs({
        writable: [path.join(root, "workspace")],
        readableAliases: [{ source: alias, destination: alias }],
        network: "deny",
      })
      expect(
        args.some((value, index) => value === "--ro-bind-try" && args[index + 1] === "/" && args[index + 2] === alias),
      ).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("masks both canonical and stable alias spellings without following the alias source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-bwrap-mask-alias-"))
    const source = path.join(root, "physical-secret")
    const destination = path.join(root, "config", "data-root", "secret")
    fs.writeFileSync(source, "secret")
    try {
      const canonicalSource = fs.realpathSync.native(source)
      const args = Sandbox.bubblewrapArgs({
        writable: [path.join(root, "workspace")],
        unreadable: [source],
        unreadableAliases: [{ source, destination }],
        network: "deny",
      })
      const masks = args.flatMap((value, index) =>
        value === "--ro-bind-try" && args[index + 1] === "/dev/null" ? [args[index + 2]!] : [],
      )
      expect(masks).toContain(canonicalSource)
      expect(masks).toContain(destination)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed to an isolated network namespace in both policy modes", () => {
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: "deny" })).toContain("--unshare-net")
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: "allow" })).toContain("--unshare-net")
  })

  test("skips the /tmp tmpfs root but binds workspace paths under it", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/tmp", "/tmp/sub"], network: "allow" })
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
    expect(Sandbox.bubblewrapArgs({ writable: ["/w"], network: "allow" })).toContain("--unshare-pid")
  })

  test("does not implicitly expose Linux user-data roots", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/work/project"], network: "deny" })
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

  test("freezes empty-root mount scaffolding after explicit mounts are assembled", () => {
    const args = Sandbox.bubblewrapArgs({
      writable: ["/work/project"],
      readable: ["/home/user/.bun"],
      network: "deny",
    })
    const rootRemount = args.findIndex((value, index) => value === "--remount-ro" && args[index + 1] === "/")
    const filesystemOptions = new Set([
      "--proc",
      "--dev",
      "--tmpfs",
      "--dir",
      "--file",
      "--symlink",
      "--bind",
      "--bind-try",
      "--ro-bind",
      "--ro-bind-try",
    ])
    const lastMount = args.reduce((last, value, index) => (filesystemOptions.has(value) ? index : last), -1)
    expect(rootRemount).toBeGreaterThan(lastMount)
  })

  test.skipIf(Sandbox.backend() !== "bubblewrap")(
    "keeps mount-parent scaffolding read-only while explicit workspace binds remain writable",
    async () => {
      const readable = fs.mkdtempSync(path.join(os.homedir(), `.openscience-bwrap-readable-${process.pid}-`))
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `.openscience-bwrap-workspace-${process.pid}-`))
      const outside = path.join(os.homedir(), `.openscience-bwrap-sibling-${process.pid}`)
      const inside = path.join(workspace, "inside")
      fs.rmSync(outside, { force: true })
      try {
        const args = Sandbox.bubblewrapArgs({ writable: [workspace], readable: [readable], network: "deny" })
        const script = [
          `touch ${JSON.stringify(outside)} 2>/dev/null`,
          "outside_status=$?",
          `touch ${JSON.stringify(inside)}`,
          "inside_status=$?",
          '[ "$outside_status" -ne 0 ] && [ "$inside_status" -eq 0 ]',
        ].join("; ")
        const proc = Bun.spawn(["bwrap", ...args, "--", "/bin/sh", "-c", script], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])

        expect(exit, stderr).toBe(0)
        expect(fs.existsSync(outside)).toBe(false)
        expect(fs.existsSync(inside)).toBe(true)
      } finally {
        fs.rmSync(outside, { force: true })
        fs.rmSync(readable, { recursive: true, force: true })
        fs.rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

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
      network: "allow",
    })
    expect(args).not.toContain(file)
  })

  test("covers an existing credential directory with an empty tmpfs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `openscience-sandbox-credentials-${process.pid}-`))
    try {
      const args = Sandbox.bubblewrapArgs({ writable: ["/work/project"], unreadable: [directory], network: "allow" })
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

  test.skipIf(Sandbox.backend() !== "bubblewrap")(
    "keeps a setsid double-fork inside the PID namespace and kills it with the wrapper",
    async () => {
      const python = Bun.which("python3")
      if (!python) return
      await using tmp = await tmpdir()
      const marker = path.join(tmp.path, "double-fork.pid")
      const script = [
        "import os,time",
        "child = os.fork()",
        "if child == 0:",
        "    os.setsid()",
        "    os.fork() and os._exit(0)",
        `    open(${JSON.stringify(marker)}, 'w').write(str(os.getpid()))`,
        "    time.sleep(3600)",
        // Keep bwrap's monitored command alive after the daemon forks. If the
        // initial command exits first, --die-with-parent correctly tears down
        // the namespace before the daemon can publish its marker.
        "time.sleep(3600)",
      ].join("\n")
      const plan = Sandbox.wrapArgv({
        file: python,
        args: ["-c", script],
        workspace: [tmp.path],
        options: { enabled: true, network: "deny", onUnavailable: "error" },
      })
      const proc = Bun.spawn([plan.file, ...(plan.args ?? [])], {
        cwd: tmp.path,
        stdout: "ignore",
        stderr: "pipe",
      })
      const hostPID = (leaderPID: number, namespacePID: number) => {
        const rows = fs
          .readdirSync("/proc")
          .filter((value) => /^\d+$/.test(value))
          .flatMap((value) => {
            const pid = Number(value)
            try {
              const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
              const fields = stat
                .slice(stat.lastIndexOf(")") + 2)
                .trim()
                .split(/\s+/)
              return [{ pid, ppid: Number(fields[1]) }]
            } catch {
              return []
            }
          })
        const descendants = new Set([leaderPID])
        let changed = true
        while (changed) {
          changed = false
          for (const row of rows) {
            if (descendants.has(row.pid) || !descendants.has(row.ppid)) continue
            descendants.add(row.pid)
            changed = true
          }
        }
        const matches = [...descendants].filter((pid) => {
          try {
            const value = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^NSpid:\s+(.+)$/m)?.[1]
            return Number(value?.trim().split(/\s+/).at(-1)) === namespacePID
          } catch {
            return false
          }
        })
        return matches.length === 1 ? matches[0] : undefined
      }
      const escaped: { pid: number; identity?: string } = { pid: 0 }
      try {
        for (let attempt = 0; attempt < 300 && !fs.existsSync(marker); attempt++) await Bun.sleep(10)
        if (!fs.existsSync(marker)) {
          if (proc.exitCode === null) proc.kill("SIGKILL")
          await proc.exited
          const stderr = await new Response(proc.stderr).text()
          throw new Error(`double-fork sandbox marker was not created: ${stderr.trim() || "no stderr"}`)
        }
        const namespacePID = Number(fs.readFileSync(marker, "utf8"))
        // The daemon can publish its marker while the intermediate fork is
        // concurrently exiting and reparenting it to the namespace init. A
        // single host /proc snapshot can therefore see a temporarily broken
        // ancestry chain. Retry the complete PPID/NSpid proof; do not accept a
        // PID until one stable snapshot authenticates it below the wrapper.
        for (let attempt = 0; attempt < 300 && !escaped.pid; attempt++) {
          escaped.pid = hostPID(proc.pid, namespacePID) ?? 0
          if (!escaped.pid) await Bun.sleep(10)
        }
        expect(escaped.pid).toBeGreaterThan(0)
        escaped.identity = await ProcessIdentity.capture(escaped.pid)
        expect(escaped.identity).toMatch(/^[a-f0-9]{64}$/)
        expect(await ProcessIdentity.owns(escaped.pid, escaped.identity)).toBe(true)

        // The intermediate daemon parent has exited, but the monitored Python
        // process keeps bwrap alive while the setsid grandchild runs.
        expect(proc.exitCode).toBeNull()
        proc.kill("SIGKILL")
        await proc.exited
        for (let attempt = 0; attempt < 300 && (await ProcessIdentity.owns(escaped.pid, escaped.identity)); attempt++) {
          await Bun.sleep(10)
        }
        expect(await ProcessIdentity.owns(escaped.pid, escaped.identity)).toBe(false)
      } finally {
        if (proc.exitCode === null) {
          proc.kill("SIGKILL")
          await proc.exited
        }
        if (escaped.pid && (await ProcessIdentity.owns(escaped.pid, escaped.identity))) {
          process.kill(escaped.pid, "SIGKILL")
        }
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
      expect(p.temporary).toBeTruthy()
      expect(p.args).toContain(`TMPDIR=${p.temporary}`)
    } else {
      expect(p.sandboxed).toBe(false)
    }
  })

  test("sandboxed Python can initialize the standard MIME database", async () => {
    if (!Sandbox.available()) return
    await using tmp = await tmpdir()
    const python = Bun.which("python3")
    if (!python) return
    const p = Sandbox.plan({
      command: `${JSON.stringify(python)} -c ${JSON.stringify(
        "import mimetypes; mimetypes.init(); print(mimetypes.guess_type('table.xlsx')[0])",
      )}`,
      shell,
      cwd: tmp.path,
      workspace: [tmp.path],
      options: { enabled: true },
    })
    const result = await execute(p, tmp.path)
    expect(result.exit).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout.trim()).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
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
  test.skipIf(Sandbox.backend() !== "bubblewrap")(
    "keeps a managed symlink spelling usable while mounting only its canonical source",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-bwrap-managed-root-"))
      const physical = path.join(root, "physical")
      const config = path.join(root, "config")
      const stable = path.join(config, "data-root")
      const workspace = path.join(stable, "workspace")
      const output = path.join(workspace, "result.txt")
      fs.mkdirSync(path.join(physical, "workspace"), { recursive: true })
      fs.mkdirSync(config)
      fs.symlinkSync(physical, stable, "dir")
      const plan = Sandbox.plan({
        command: `printf stable-ok > ${JSON.stringify(output)}`,
        shell,
        cwd: workspace,
        workspace: [workspace],
        options: { enabled: true, network: "deny", onUnavailable: "error" },
      })
      try {
        const canonicalWorkspace = fs.realpathSync.native(workspace)
        const alias = (plan.args ?? []).findIndex(
          (value, index, args) =>
            value === "--bind-try" && args[index + 1] === canonicalWorkspace && args[index + 2] === workspace,
        )
        expect(alias).toBeGreaterThan(-1)
        expect(await executeWithoutCleanup(plan, workspace)).toMatchObject({ exit: 0 })
        expect(fs.readFileSync(path.join(physical, "workspace", "result.txt"), "utf8")).toBe("stable-ok")
      } finally {
        Sandbox.cleanup(plan)
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

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
          workspace: [work, readonly],
          readable: [readonly],
          unreadable: [path.join(readonly, "data.txt")],
          options,
        })
        expect((await execute(masked, work)).exit).not.toBe(0)
        const maskedWrite = Sandbox.plan({
          command: `printf exposed > "${path.join(readonly, "data.txt")}"`,
          shell,
          cwd: work,
          workspace: [work, readonly],
          unreadable: [path.join(readonly, "data.txt")],
          options,
        })
        expect((await execute(maskedWrite, work)).exit).not.toBe(0)
        expect(fs.readFileSync(path.join(readonly, "data.txt"), "utf8")).toBe("granted")

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
  test("allowlist unshares the network AND binds the socket read-only", () => {
    const args = Sandbox.bubblewrapArgs({ writable: ["/w"], network: "allowlist", egress: "/run/os/e.sock" })
    expect(args).toContain("--unshare-net")
    const at = args.indexOf("/run/os/e.sock")
    expect(at).toBeGreaterThan(0)
    // --ro-bind, not --bind: the bind shares the host inode, so a read-write
    // bind would let a sandboxed process `chmod 000` the socket and disable
    // egress host-wide (persists past this process, shared by every
    // kernel/terminal/job). Read-only blocks chmod while still permitting
    // connect() — verified live in the fix-round report.
    expect(args[at - 1]).toBe("--ro-bind")
  })

  test("allowlist without a socket path is refused rather than silently opened", () => {
    expect(() => Sandbox.bubblewrapArgs({ writable: ["/w"], network: "allowlist" })).toThrow()
  })

  // buildPolicy filters `egress` through the same tooBroadToConfine gate as
  // `writable`/`unreadable`, normalized the same way (dedupe()'s path.resolve())
  // before the gate sees it — so a lexical variant of an over-broad path (a
  // trailing slash, a double slash, an unresolved "..") can't slip past the
  // gate's string checks the way the raw string comparison once did. An
  // over-broad egress must never reach argv as a --bind at all — even
  // read-only, that would expose the whole subtree's contents, not just
  // widen network access. Proven previously by calling bubblewrapArgs
  // directly with an unfiltered
  // `egress: $HOME`, which emitted "--bind $HOME $HOME" and let a sandboxed
  // write escape to the real $HOME — and, before normalization was added, the
  // exact same escape via `egress: $HOME + "/"` (a trailing slash was enough
  // to dodge the raw string check). Going through the public plan() (which
  // runs buildPolicy) instead: the over-broad path is dropped, so "allowlist"
  // is left without an egress socket and refuses to run — it fails closed
  // rather than silently binding it, for the whole class of lexical variants,
  // not just the one literal string.
  test.each([
    ["exact", os.homedir()],
    ["trailing slash", os.homedir() + "/"],
    ["double slash", os.homedir() + "//"],
    ["unresolved ..", os.homedir() + "/foo/.."],
    ["root", "/"],
  ])("an over-broad egress path (%s) is dropped, not bound as a read-write escape hatch", (_label, egress) => {
    // platform "linux", not the ambient one: this asserts bubblewrap argv,
    // and on a darwin runner the same call reaches `seatbeltProfile` and
    // throws for an entirely different reason ("requires an egress port"),
    // which a bare .toThrow() would have accepted as a pass. Asserting the
    // message closes that hole for good.
    expect(() =>
      Sandbox.plan({
        command: "true",
        shell,
        cwd: "/work/project",
        workspace: ["/work/project"],
        options: { enabled: true, network: "allowlist", egress },
        platform: "linux",
      }),
    ).toThrow("requires an egress socket path")
  })

  test("a legitimate, non-broad egress socket is still bound, read-only", () => {
    const p = Sandbox.plan({
      command: "true",
      shell,
      cwd: "/work/project",
      workspace: ["/work/project"],
      options: { enabled: true, network: "allowlist", egress: "/run/os/e.sock" },
      platform: "linux",
    })
    expect(p.args).toContain("/run/os/e.sock")
    const at = (p.args ?? []).indexOf("/run/os/e.sock")
    expect((p.args ?? [])[at - 1]).toBe("--ro-bind")
  })

  // Live regression for the read-only bind's actual purpose: the egress
  // socket is one-per-CLI-process, shared by every kernel/terminal/job, so a
  // sandboxed process that could `chmod 000` it would disable egress
  // host-wide until restart (the bind shares the host inode, so the mode
  // change persists on the host — even the host proxy can no longer
  // connect()). Runs a real bwrap with the exact args bubblewrapArgs()
  // produces (not the full shim/proxy plan() composes, which is exercised
  // elsewhere) to prove both properties of --ro-bind at once: chmod fails
  // closed inside the sandbox, and a plain client can still connect()
  // through the same bind.
  const python = Bun.which("python3") ?? Bun.which("python")
  test.skipIf(Sandbox.backend() !== "bubblewrap" || !python)(
    "the sandboxed process can connect through the egress bind but cannot chmod it",
    async () => {
      await using tmp = await tmpdir()
      const sockPath = path.join(tmp.path, "e.sock")
      const received: string[] = []
      const server = Bun.listen<undefined>({
        unix: sockPath,
        socket: {
          data(sock, chunk) {
            received.push(chunk.toString())
            sock.write(`ACK:${chunk.toString()}`)
          },
        },
      })
      try {
        const args = Sandbox.bubblewrapArgs({ writable: [tmp.path], network: "allowlist", egress: sockPath })

        const chmod = Bun.spawnSync({
          cmd: ["bwrap", ...args, "--", "chmod", "000", sockPath],
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(chmod.exitCode).not.toBe(0)
        expect(chmod.stderr.toString()).toContain("Read-only file system")
        // Mode must be unchanged on the host — the whole point of --ro-bind.
        expect(fs.statSync(sockPath).mode & 0o777).toBeGreaterThan(0)

        // Bun.spawn, not spawnSync: the server above replies from a Bun.listen
        // "data" callback on this same event loop, so a *synchronous* spawn
        // would block that loop for as long as the child runs — the child
        // blocks on recv() waiting for a reply the loop can't yet deliver,
        // deadlocking both sides until the test times out (reproduced while
        // writing this test).
        const clientSource = [
          "import socket",
          "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
          `s.connect(${JSON.stringify(sockPath)})`,
          "s.send(b'hi')",
          "print(s.recv(1024).decode(), end='')",
        ].join("\n")
        const connectProc = Bun.spawn({
          cmd: ["bwrap", ...args, "--", python!, "-c", clientSource],
          stdout: "pipe",
          stderr: "pipe",
        })
        const [connectOut, connectErr] = await Promise.all([
          new Response(connectProc.stdout).text(),
          new Response(connectProc.stderr).text(),
        ])
        await connectProc.exited
        expect(connectOut, connectErr).toBe("ACK:hi")
        expect(received).toContain("hi")
      } finally {
        server.stop(true)
      }
    },
  )

  // Seatbelt has no namespace, so bwrap's --unshare-net has no equivalent
  // here: the profile text itself is the only boundary. "allowlist" is
  // therefore carried by Policy.port, not Policy.egress (that field stays
  // bubblewrap's unix socket path — see Policy's doc comment).
  //
  // Task 7 fix round 1, I3: this used to emit only network-outbound, spelled
  // (remote ip ...). docs/adr/0002-sandbox-network-policy.md:56-59 records
  // the reference implementation as permitting network-bind/network-inbound/
  // network-outbound, all narrowed to the proxy's loopback port, spelled tcp
  // — a narrower, unmeasured guess on the one platform this project cannot
  // execute against is exactly the failure mode that makes "allowlist"
  // silently unreachable on every real Mac. See seatbeltProfile's own doc
  // comment for why network-bind/network-inbound are included even though
  // this sandboxed process is only ever a TCP client, never a listener.
  test("allowlist with a port emits deny before all three narrow allows, spelled tcp", () => {
    const profile = Sandbox.seatbeltProfile({ writable: ["/w"], network: "allowlist", port: 54321 })
    const deny = profile.indexOf("(deny network*)")
    expect(deny).toBeGreaterThan(-1)
    for (const line of [
      '(allow network-bind (local tcp "localhost:54321"))',
      '(allow network-inbound (local tcp "localhost:54321"))',
      '(allow network-outbound (remote tcp "localhost:54321"))',
    ]) {
      const at = profile.indexOf(line)
      expect(at).toBeGreaterThan(deny)
    }
  })

  // The safety rule from the task brief: a missing/invalid port must never
  // silently downgrade to a plain deny (which would look identical to a user
  // asking for network:"deny", not what "allowlist" means) or, worse, to an
  // unfiltered allow. Same fail-closed contract bubblewrapArgs already
  // applies to a missing egress socket.
  test("allowlist with no port throws rather than silently degrading to deny", () => {
    expect(() => Sandbox.seatbeltProfile({ writable: ["/w"], network: "allowlist" })).toThrow(
      "sandbox network 'allowlist' requires an egress port",
    )
  })

  // Task 7 fix round 1, M5: 65536 and above are not valid TCP ports at all;
  // an unbounded check let them through and would have composed a profile
  // narrowing egress to a port number that can never exist.
  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 3.5],
    ["one past the max valid port", 65536],
    ["absurdly large", 1e21],
  ])("allowlist with an invalid port (%s) throws", (_label, port) => {
    expect(() => Sandbox.seatbeltProfile({ writable: ["/w"], network: "allowlist", port })).toThrow(
      "sandbox network 'allowlist' requires an egress port",
    )
  })

  test("allowlist accepts the maximum valid port, 65535", () => {
    expect(() => Sandbox.seatbeltProfile({ writable: ["/w"], network: "allowlist", port: 65535 })).not.toThrow()
  })

  // The dangerous direction named in the brief: a malformed or over-broad
  // allow is the only failure mode that makes a macOS user worse off than
  // today's plain deny. Pin the exact shapes seatbeltProfile can produce —
  // never a bare, unfiltered allow of any of the three network operations.
  test("never emits an unfiltered network-bind/network-inbound/network-outbound allow in any mode", () => {
    for (const network of ["deny", "allow"] as const) {
      const profile = Sandbox.seatbeltProfile({ writable: ["/w"], network })
      expect(profile).not.toContain("(allow network-bind")
      expect(profile).not.toContain("(allow network-inbound")
      expect(profile).not.toContain("(allow network-outbound")
    }
    const profile = Sandbox.seatbeltProfile({ writable: ["/w"], network: "allowlist", port: 4000 })
    const lines = profile.split("\n").filter((line) => /network-(bind|inbound|outbound)/.test(line))
    expect(lines).toEqual([
      '(allow network-bind (local tcp "localhost:4000"))',
      '(allow network-inbound (local tcp "localhost:4000"))',
      '(allow network-outbound (remote tcp "localhost:4000"))',
    ])
  })

  // Pins the deny/allow branches byte-for-byte: Policy.port only ever
  // affects the "allowlist" branch, so these two must come out exactly as
  // they did before this field existed.
  test("deny and allow profiles are unaffected by the allowlist port machinery", () => {
    const deny = Sandbox.seatbeltProfile({ writable: ["/w"], network: "deny" })
    expect(deny.split("\n")).toEqual([
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      "(deny file-write*)",
      '(allow file-write* (subpath "/w"))',
      '(allow file-write* (subpath "/dev"))',
    ])
    const allow = Sandbox.seatbeltProfile({ writable: ["/w"], network: "allow" })
    expect(allow.split("\n")).toEqual([
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      '(allow file-write* (subpath "/w"))',
      '(allow file-write* (subpath "/dev"))',
    ])
  })
})

describe("Sandbox.backend(platform)", () => {
  // The injectable seam every darwin-only assertion in this branch depends
  // on: nobody on this project can install sandbox-exec, so exercising the
  // seatbelt code paths in plan()/wrapArgv()/EgressRuntime from Linux is
  // only possible if `platform` overrides the real, probed detection below.
  test("darwin resolves to seatbelt regardless of the machine actually running the test", () => {
    expect(Sandbox.backend("darwin")).toBe("seatbelt")
  })

  test("linux resolves to bubblewrap regardless of the machine actually running the test", () => {
    expect(Sandbox.backend("linux")).toBe("bubblewrap")
  })

  test("an unsupported platform resolves to none", () => {
    // win32 is no longer one — it maps to appcontainer when injected. freebsd
    // has no backend and is not planned to get one, so it still exercises the
    // fallthrough this test exists for.
    expect(Sandbox.backend("freebsd")).toBe("none")
  })

  test("an injected win32 resolves to appcontainer, so the Windows paths are reachable", () => {
    // The same seam that let the seatbelt paths be built from Linux. It is
    // deliberately NOT the live probe: `detected()` still answers "none" on a
    // real Windows machine until a launcher exists, because claiming a sandbox
    // the product cannot apply is worse than refusing to run kernels there.
    expect(Sandbox.backend("win32")).toBe("appcontainer")
  })

  // The doc comment's exact claim: an explicit platform that matches the
  // real one is the same code path as the zero-arg call, not a parallel
  // implementation that could drift from the probed one.
  test("an explicitly-matching platform is identical to the zero-arg call", () => {
    expect(Sandbox.backend(process.platform)).toBe(Sandbox.backend())
  })
})

describe("Sandbox.plan/wrapArgv on darwin (seatbelt)", () => {
  // "<port>:<secret>" — the shape EgressRuntime.egressFor() produces for
  // seatbelt (see egress-runtime.ts); buildPolicy splits it back into
  // Policy.port/Policy.secret.
  const port = "54321"
  const secret = "topsecret123"
  const egress = `${port}:${secret}`

  test("plan composes no shim and dials the proxy port directly, with the secret in the proxy URL", () => {
    const p = Sandbox.plan({
      command: "echo hi",
      shell,
      cwd: "/work/project",
      workspace: ["/work/project"],
      options: { enabled: true, network: "allowlist", egress },
      platform: "darwin",
    })
    expect(p.sandboxed).toBe(true)
    expect(p.backend).toBe("seatbelt")
    expect(p.file).toBe("sandbox-exec")
    const argv = (p.args ?? []).join(" ")
    // No unix-socket shim exists on darwin: no launcher, no bundle, no
    // __egress-shim marker — the real command runs directly under sandbox-exec.
    expect(argv).not.toContain("__egress-shim")
    expect(argv).toContain("echo hi")
    // A loopback TCP port carries no filesystem permissions of its own (a
    // unix socket does), so the URL embeds the per-start secret as userinfo
    // — pip/curl/requests all parse this into Proxy-Authorization.
    expect(p.env?.HTTP_PROXY).toBe(`http://os:${secret}@127.0.0.1:${port}`)
    expect(p.env?.http_proxy).toBe(p.env?.HTTP_PROXY)
  })

  test("wrapArgv composes no shim and dials the proxy port directly, with the secret in the proxy URL", () => {
    const w = Sandbox.wrapArgv({
      file: "python3",
      args: ["-u", "/tmp/k.py"],
      workspace: ["/work/project"],
      options: { enabled: true, network: "allowlist", egress },
      platform: "darwin",
    })
    expect(w.sandboxed).toBe(true)
    expect(w.backend).toBe("seatbelt")
    const argv = w.args.join(" ")
    expect(argv).not.toContain("__egress-shim")
    expect(argv).toContain("python3")
    expect(w.env?.HTTP_PROXY).toBe(`http://os:${secret}@127.0.0.1:${port}`)
  })

  test("allowlist with no egress port throws rather than silently degrading to deny", () => {
    expect(() =>
      Sandbox.wrapArgv({
        file: "python3",
        args: ["-u", "/tmp/k.py"],
        workspace: ["/work/project"],
        options: { enabled: true, network: "allowlist" },
        platform: "darwin",
      }),
    ).toThrow()
  })

  // A port with no secret is exactly as fail-closed as no port at all — see
  // buildPolicy's doc comment: the two are validated and dropped together,
  // so a malformed "port with no secret" pairing can never compose a proxy
  // URL missing the credential the darwin listener requires.
  test("allowlist with a port but no secret (malformed egress) throws, not an unauthenticated proxy URL", () => {
    expect(() =>
      Sandbox.wrapArgv({
        file: "python3",
        args: ["-u", "/tmp/k.py"],
        workspace: ["/work/project"],
        options: { enabled: true, network: "allowlist", egress: `${port}:` },
        platform: "darwin",
      }),
    ).toThrow()
  })

  test("deny and allow never compose a shim or set a proxy env on darwin", () => {
    const deny = Sandbox.wrapArgv({
      file: "python3",
      args: ["-u", "/tmp/k.py"],
      workspace: ["/work/project"],
      options: { enabled: true, network: "deny" },
      platform: "darwin",
    })
    expect(deny.args.join(" ")).not.toContain("__egress-shim")
    expect(deny.env).toBeUndefined()

    const allow = Sandbox.wrapArgv({
      file: "python3",
      args: ["-u", "/tmp/k.py"],
      workspace: ["/work/project"],
      options: { enabled: true, network: "allow" },
      platform: "darwin",
    })
    expect(allow.args.join(" ")).not.toContain("__egress-shim")
    expect(allow.env).toBeUndefined()
  })

  // Regression guard for the real-platform paths: an explicit platform that
  // matches this machine's own must not diverge from the zero-arg call —
  // "allow" keeps this cheap (no shim/proxy machinery) while still routing
  // through decide()/buildPolicy() with a platform argument threaded in.
  test("an explicitly-matching platform reproduces the zero-arg plan on this machine", () => {
    const base = {
      command: "echo hi",
      shell,
      cwd: "/work/project",
      workspace: ["/work/project"],
      options: { enabled: true, network: "allow" as const },
    }
    expect(Sandbox.plan({ ...base, platform: process.platform })).toEqual(Sandbox.plan(base))
  })
})

describe("Sandbox.shimScript", () => {
  test("backgrounds the shim and execs the real command", () => {
    const script = Sandbox.shimScript({
      binary: "/usr/bin/openscience",
      port: 3128,
      socket: "/run/os/e.sock",
      file: "python3",
      args: ["-u", "/tmp/k.py"],
    })
    expect(script).toContain("__egress-shim")
    expect(script).toContain("&")
    expect(script).toContain("exec ")
  })

  test("quotes every interpolated value so a path with a space cannot split", () => {
    const script = Sandbox.shimScript({
      binary: "/opt/my apps/openscience",
      port: 3128,
      socket: "/run/my dir/e.sock",
      file: "python3",
      args: ["-c", "print('hi there')"],
    })
    expect(script).toContain("'/opt/my apps/openscience'")
    expect(script).toContain("'/run/my dir/e.sock'")
    expect(script).not.toMatch(/[^']\/opt\/my apps/)
  })

  test("a single quote in an argument cannot break out of the quoting", () => {
    const script = Sandbox.shimScript({
      binary: "/usr/bin/openscience",
      port: 3128,
      socket: "/run/os/e.sock",
      file: "python3",
      args: ["-c", "x = 'a'; print(x)"],
    })
    expect(script).toContain(`'"'"'`)
  })
})

// The readiness wait is the whole per-spawn cost of network "allowlist", and
// it is paid by every sandboxed command whether or not it touches the network.
// These run the composed script through a real /bin/sh — the only place its
// behaviour actually lives — with a stand-in for the shim binary, so they need
// no bubblewrap and no proxy.
describe("Sandbox.shimScript readiness wait", () => {
  const posix = process.platform !== "win32"

  /** Runs the composed script and reports how long it took, plus whatever the
   *  wait leaked to the real command's stderr (it runs in the foreground, so
   *  anything it prints lands in the command's own output). */
  async function run(script: string, prefixPath?: string) {
    const started = Date.now()
    const proc = Bun.spawn(["/bin/sh", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: prefixPath ? { ...process.env, PATH: `${prefixPath}:${process.env["PATH"]}` } : process.env,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    return { ms: Date.now() - started, stdout, stderr }
  }

  /** A `sleep` that rejects fractional intervals the way some busybox builds
   *  do, so the fallback branch is exercised on a host whose real coreutils
   *  accepts them. */
  function busyboxishSleep(dir: string) {
    const real = Bun.which("sleep") ?? "/bin/sleep"
    const file = path.join(dir, "sleep")
    fs.writeFileSync(
      file,
      `#!/bin/sh\ncase "$1" in\n  *.*) echo "sleep: invalid number '$1'" >&2; exit 1 ;;\nesac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    )
    return dir
  }

  /** A `sleep` whose cost is dominated by process creation rather than by the
   *  interval asked for. A macOS CI runner measured ~114ms per iteration of
   *  the 0.02s poll — ~94ms of fork/exec — which stretched the nominal 3s cap
   *  to 17.1s and is what put the wall-clock deadline in `shimScript`. This
   *  reproduces that condition on any host. */
  function expensiveSleep(dir: string) {
    const real = Bun.which("sleep") ?? "/bin/sleep"
    const file = path.join(dir, "sleep")
    fs.writeFileSync(file, `#!/bin/sh\nexec ${real} 0.12\n`, { mode: 0o755 })
    return dir
  }

  test.skipIf(!posix)(
    "waits for the shim, and only for as long as the shim takes",
    async () => {
      await using dir = await tmpdir()
      // Stands in for the shim: ignores its arguments, becomes ready quickly.
      const fake = path.join(dir.path, "shim")
      fs.writeFileSync(fake, `#!/bin/sh\nsleep 0.15\n: > ${JSON.stringify(SHIM_READY_MARKER)}\n`, { mode: 0o755 })
      fs.rmSync(SHIM_READY_MARKER, { force: true })

      try {
        const { ms, stdout } = await run(
          Sandbox.shimScript({ binary: fake, port: 3128, socket: "/run/os/e.sock", file: "/bin/echo", args: ["ran"] }),
        )
        expect(stdout.trim()).toBe("ran")
        // It really waited: the marker only lands at ~150ms.
        expect(ms).toBeGreaterThanOrEqual(140)
        // And it did not round that up to a whole second. Before the poll
        // interval was chosen at run time this was a flat ~1.0s for a shim that
        // is ready in ~12ms — measured 1006ms against 3ms for network "deny".
        expect(ms).toBeLessThan(600)
      } finally {
        fs.rmSync(SHIM_READY_MARKER, { force: true })
      }
    },
    30_000,
  )

  test.skipIf(!posix)(
    "a sleep that rejects fractions still waits, and says nothing about it",
    async () => {
      await using dir = await tmpdir()
      fs.rmSync(SHIM_READY_MARKER, { force: true })
      // /bin/true ignores the shim arguments and never signals readiness, so the
      // wait runs to its cap — which is the point: a fractional `sleep` that
      // errors out returns instantly, so a loop that ignored the failure would
      // spin through all its iterations in microseconds and skip the wait
      // entirely, silently, while printing one error line per iteration.
      const { ms, stderr } = await run(
        Sandbox.shimScript({
          binary: "/bin/true",
          port: 3128,
          socket: "/run/os/e.sock",
          file: "/bin/echo",
          args: ["ran"],
        }),
        busyboxishSleep(dir.path),
      )
      expect(stderr).toBe("")
      expect(ms).toBeGreaterThanOrEqual(2_500)
      expect(ms).toBeLessThan(6_000)
    },
    30_000,
  )

  test.skipIf(!posix)(
    "the cap is the same 3s whichever granularity the shell supports",
    async () => {
      fs.rmSync(SHIM_READY_MARKER, { force: true })
      const { ms } = await run(
        Sandbox.shimScript({
          binary: "/bin/true",
          port: 3128,
          socket: "/run/os/e.sock",
          file: "/bin/echo",
          args: ["ran"],
        }),
      )
      expect(ms).toBeGreaterThanOrEqual(2_500)
      expect(ms).toBeLessThan(6_000)
    },
    30_000,
  )

  // The regression this file's macOS run found: the cap used to be an
  // iteration count, so it only equalled 3s where forking `sleep` was nearly
  // free. Without the deadline, 150 iterations at 0.12s each run for 18s.
  test.skipIf(!posix)(
    "a `sleep` whose real cost is fork/exec cannot stretch the cap",
    async () => {
      await using dir = await tmpdir()
      fs.rmSync(SHIM_READY_MARKER, { force: true })
      const { ms, stderr } = await run(
        Sandbox.shimScript({
          binary: "/bin/true",
          port: 3128,
          socket: "/run/os/e.sock",
          file: "/bin/echo",
          args: ["ran"],
        }),
        expensiveSleep(dir.path),
      )
      // Still silent: the deadline probe's own diagnostics are discarded the
      // same way the fractional-sleep probe's are.
      expect(stderr).toBe("")
      expect(ms).toBeGreaterThanOrEqual(2_500)
      expect(ms).toBeLessThan(6_000)
    },
    30_000,
  )
})

describe("Sandbox.wrapArgv egress shim", () => {
  test.skipIf(Sandbox.backend() !== "bubblewrap")(
    "allowlist composes the shim into the argv and returns proxy env",
    () => {
      const wrapped = Sandbox.wrapArgv({
        file: "python3",
        args: ["-u", "/tmp/k.py"],
        workspace: ["/work/project"],
        options: { enabled: true, network: "allowlist", egress: "/run/os/e.sock" },
      })
      expect(wrapped.sandboxed).toBe(true)
      const argv = wrapped.args.join(" ")
      expect(argv).toContain("__egress-shim")
      expect(argv).toContain("/run/os/e.sock")
      expect(argv).toContain("exec 'python3'")
      expect(wrapped.env?.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(wrapped.env?.http_proxy).toBe(wrapped.env?.HTTP_PROXY)
    },
  )

  test.skipIf(Sandbox.backend() !== "bubblewrap")("deny and allow never compose the shim", () => {
    const deny = Sandbox.wrapArgv({
      file: "python3",
      args: ["-u", "/tmp/k.py"],
      workspace: ["/work/project"],
      options: { enabled: true, network: "deny" },
    })
    expect(deny.args.join(" ")).not.toContain("__egress-shim")
    expect(deny.env).toBeUndefined()

    const allow = Sandbox.wrapArgv({
      file: "python3",
      args: ["-u", "/tmp/k.py"],
      workspace: ["/work/project"],
      options: { enabled: true, network: "allow" },
    })
    expect(allow.args.join(" ")).not.toContain("__egress-shim")
    expect(allow.env).toBeUndefined()
  })

  // Everything above asserts on the composed argv string without ever running
  // it — which is exactly what let the shim silently die inside the real
  // sandbox (EROFS from the CLI's logging middleware) go undetected. This
  // spawns the actual `wrapArgv` output — real bwrap, the real composed
  // `sh -c` script, and (in dev, which this test runs as) the real on-disk
  // launcher `shimPlan()` writes — and proves a TCP client inside the
  // namespace gets a connection accepted and bridged to the unix socket, not
  // a refused one. Resolved once, from the same gate the skip condition uses
  // — bash lives at /bin/bash on Alpine and non-usrmerge Debian, not
  // /usr/bin/bash, and a hardcoded path there would fail instead of skip.
  const bash = Bun.which("bash")
  test.skipIf(Sandbox.backend() !== "bubblewrap" || !bash || !Bun.which("timeout") || !Bun.which("head"))(
    "the composed script actually starts the shim inside a real sandbox and bridges a connection",
    async () => {
      await using tmp = await tmpdir()
      const socket = path.join(tmp.path, "e.sock")
      const received: string[] = []
      const server = Bun.listen<undefined>({
        unix: socket,
        socket: {
          data(sock, chunk) {
            received.push(chunk.toString())
            sock.write(`ACK:${chunk.toString()}`)
          },
        },
      })
      try {
        const wrapped = Sandbox.wrapArgv({
          file: bash!,
          args: ["-c", "exec 3<>/dev/tcp/127.0.0.1/3128; printf hello >&3; timeout 3 head -c 9 <&3"],
          workspace: [tmp.path],
          options: { enabled: true, network: "allowlist", egress: socket },
        })
        const proc = Bun.spawn([wrapped.file, ...wrapped.args], { stdout: "pipe", stderr: "pipe" })
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        await proc.exited
        expect(out, `stdout=${out} stderr=${err}`).toContain("ACK:hello")
        expect(received).toContain("hello")
      } finally {
        server.stop(true)
      }
    },
    15000,
  )

  // Regression guard for the bug that survived two consecutive rounds: the
  // interpreter the launcher execs (`process.execPath`) can itself live
  // under /tmp — a portable bun install, `$HOME` under /tmp — independent of
  // where the checkout or Global.Path.bin happen to be. `shimPlan()` reads
  // `process.execPath` from the *current* process, so the only way to
  // actually exercise this is to run under a /tmp-staged bun. Stages a real
  // copy (a symlink wouldn't reproduce — Bun resolves it) and drives a small
  // standalone script through it, since `bun:test` itself isn't the thing
  // under test here.
  test.skipIf(Sandbox.backend() !== "bubblewrap" || !bash || !Bun.which("timeout") || !Bun.which("head"))(
    "the composed script still starts the shim when the interpreter itself is staged under /tmp",
    async () => {
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), "staged-bun-"))
      const stagedBun = path.join(stage, "bun")
      const driver = path.join(stage, "driver.ts")
      try {
        fs.copyFileSync(process.execPath, stagedBun)
        fs.chmodSync(stagedBun, 0o755)
        const sandboxPath = path.resolve(import.meta.dir, "..", "..", "src", "sandbox", "sandbox.ts")
        fs.writeFileSync(
          driver,
          [
            `import path from "path"`,
            `import fs from "fs"`,
            `import os from "os"`,
            `import { Sandbox } from ${JSON.stringify(sandboxPath)}`,
            `const work = fs.mkdtempSync(path.join(os.tmpdir(), "staged-bun-driver-"))`,
            `const socket = path.join(work, "e.sock")`,
            `const server = Bun.listen({ unix: socket, socket: { data(sock, chunk) { sock.write("ACK:" + chunk) } } })`,
            `try {`,
            `  const wrapped = Sandbox.wrapArgv({`,
            `    file: ${JSON.stringify(bash)},`,
            `    args: ["-c", "exec 3<>/dev/tcp/127.0.0.1/3128; printf hello >&3; timeout 3 head -c 9 <&3"],`,
            `    workspace: [work],`,
            `    options: { enabled: true, network: "allowlist", egress: socket },`,
            `  })`,
            `  const proc = Bun.spawn([wrapped.file, ...wrapped.args], { stdout: "pipe", stderr: "pipe" })`,
            `  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])`,
            `  await proc.exited`,
            `  console.log(out.includes("ACK:hello") ? "STAGED_BUN_PASS" : "STAGED_BUN_FAIL " + JSON.stringify({ out, err }))`,
            `} finally {`,
            `  server.stop(true)`,
            `  fs.rmSync(work, { recursive: true, force: true })`,
            `}`,
          ].join("\n"),
        )
        const proc = Bun.spawn([stagedBun, "run", driver], { stdout: "pipe", stderr: "pipe" })
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        await proc.exited
        expect(out, `stdout=${out} stderr=${err}`).toContain("STAGED_BUN_PASS")
      } finally {
        fs.rmSync(stage, { recursive: true, force: true })
      }
    },
    20000,
  )

  // Regression guard for the fifth variant of "a path the shim needs is
  // masked by --tmpfs /tmp": an npm import in the shim's graph resolves
  // through a node_modules symlink whose target is the monorepo-root store,
  // above the package root, so binding the package root left the target
  // unbound. Reproducing that directly needs a /tmp-relocated checkout with a
  // real hoisted store — a fixture too elaborate to keep honest here. These
  // two tests assert the property that makes the whole class impossible
  // instead: the shim resolves nothing from disk at run time.
  //
  // First, statically, on the artifact `shimPlan()` actually generated: a
  // bundle with no import specifiers left in it cannot resolve anything,
  // whether the import was a sibling file or a package. Builtins are allowed
  // through — they come from inside bun, not the filesystem — so this keeps
  // passing if the shim ever imports node:net, and fails if a future import
  // is left external or the plan goes back to executing source. It does not
  // see a native binding: `dlopen("…so")` in a bundled dependency is not an
  // import specifier (see shimPlan's residual list).
  //
  // Classifying a specifier is the whole guard, so it is done against the
  // real builtin list rather than by prefix. `bun build` *strips* the node:
  // prefix — a bundled `import "node:net"` comes out as `from "net"` — so a
  // prefix test flags a legitimate builtin, and the natural reaction to that
  // false alarm is to loosen the one check standing between here and variant
  // six. In the other direction a bare /^bun/ would quietly excuse any
  // package named bun-something. builtinModules already carries bun's own
  // entries (bun, bun:ffi, …), so stripping node: and asking it is both
  // directions at once.
  test.skipIf(Sandbox.backend() !== "bubblewrap")("the generated dev shim bundle resolves nothing from disk", () => {
    const wrapped = Sandbox.wrapArgv({
      file: "python3",
      args: ["-u", "/tmp/k.py"],
      workspace: ["/work/project"],
      options: { enabled: true, network: "allowlist", egress: "/run/os/e.sock" },
    })
    const bundle = wrapped.args.find((value) => value.endsWith(".mjs"))
    expect(bundle, `argv=${wrapped.args.join(" ")}`).toBeDefined()
    const source = fs.readFileSync(bundle!, "utf8")
    // The three shapes an unbundled dependency can survive as: `from "x"`
    // (covers `import x from` and `export … from`), a call — `require("x")`,
    // `import("x")` — and a bare side-effect `import "x"`.
    const found = [
      ...source.matchAll(/\bfrom\s*"([^"]+)"|\b(?:require|import)\(\s*"([^"]+)"\s*\)|\bimport\s*"([^"]+)"/g),
    ]
    const builtin = new Set(builtinModules)
    const external = found
      .map((match) => match[1] ?? match[2] ?? match[3]!)
      .filter((spec) => !builtin.has(spec.replace(/^node:/, "")))
    expect(external).toEqual([])
  })

  // Second, live: mask the shim's own source entry with /dev/null (the
  // sandbox's existing `unreadable` mechanism) and run the real composed
  // script anyway. If the shim still bridges, nothing it ran came from the
  // source tree — which is what makes where that tree lives, and what it
  // imports, irrelevant. Executing the source instead reads an empty file,
  // starts no listener, and the connection is refused (verified: pointing the
  // launcher back at the entry fails this test in 3s, the readiness cap).
  // The mask only holds because readBind is files: a readBind *directory*
  // over the entry would re-expose it and this test would pass regardless,
  // which is why the static check above is the one that pins the bundle.
  test.skipIf(Sandbox.backend() !== "bubblewrap" || !bash || !Bun.which("timeout") || !Bun.which("head"))(
    "the composed script still starts the shim when its own source entry is masked",
    async () => {
      await using tmp = await tmpdir()
      const socket = path.join(tmp.path, "e.sock")
      const server = Bun.listen<undefined>({
        unix: socket,
        socket: {
          data(sock, chunk) {
            sock.write(`ACK:${chunk.toString()}`)
          },
        },
      })
      try {
        const wrapped = Sandbox.wrapArgv({
          file: bash!,
          args: ["-c", "exec 3<>/dev/tcp/127.0.0.1/3128; printf hello >&3; timeout 3 head -c 9 <&3"],
          workspace: [tmp.path],
          unreadable: [path.resolve(import.meta.dir, "..", "..", "src", "sandbox", "egress-shim-entry.ts")],
          options: { enabled: true, network: "allowlist", egress: socket },
        })
        const proc = Bun.spawn([wrapped.file, ...wrapped.args], { stdout: "pipe", stderr: "pipe" })
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        await proc.exited
        expect(out, `stdout=${out} stderr=${err}`).toContain("ACK:hello")
      } finally {
        server.stop(true)
      }
    },
    15000,
  )

  // End-to-end guard on the property Important B was about: self-hosting —
  // opening OpenScience on its own checkout, the case Task 5 will dogfood —
  // must not lose write access to part of the workspace just because the
  // sandbox also needs some path bound read-only. It caught a real bug when
  // shimPlan's readBind held the package root and bubblewrapArgs emitted it
  // after the writable --bind-try loop. That trigger is gone (readBind is now
  // two generated files plus the interpreter, none inside a checkout), so the
  // test no longer has a failing negative control — it passes by the bind set
  // being small rather than by the overlap exclusion doing anything. Kept as
  // the assertion that the property still holds however the set changes.
  test.skipIf(Sandbox.backend() !== "bubblewrap" || !bash)(
    "a workspace path under the package root stays writable under allowlist",
    async () => {
      await using tmp = await tmpdir()
      const socket = path.join(tmp.path, "e.sock")
      const server = Bun.listen<undefined>({ unix: socket, socket: { data() {} } })
      const packageRoot = path.resolve(import.meta.dir, "..", "..")
      const probe = path.join(packageRoot, "src", "sandbox", `.regression-write-probe-${process.pid}`)
      try {
        const wrapped = Sandbox.wrapArgv({
          file: bash!,
          args: ["-c", `echo probe > '${probe}' && cat '${probe}' && rm '${probe}' && echo WRITE_OK`],
          workspace: [packageRoot],
          options: { enabled: true, network: "allowlist", egress: socket },
        })
        const proc = Bun.spawn([wrapped.file, ...wrapped.args], { stdout: "pipe", stderr: "pipe" })
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        await proc.exited
        expect(out, `stdout=${out} stderr=${err}`).toContain("WRITE_OK")
      } finally {
        server.stop(true)
        fs.rmSync(probe, { force: true })
      }
    },
    15000,
  )
})

describe("Sandbox on win32 (AppContainer composition)", () => {
  const base = {
    file: "python3",
    args: ["-u", "/w/k.py"],
    workspace: ["/w/project"],
    platform: "win32" as const,
  }
  const decode = (args: string[]) =>
    JSON.parse(Buffer.from(args[args.indexOf("__appcontainer-launch") + 1]!, "base64").toString("utf8"))

  test("the profile name is stable for a workspace and distinct between workspaces", () => {
    // The package SID is derived from this name, and filesystem ACEs plus the
    // broker pipe's DACL refer to that SID. A fresh name per launch would
    // strand every ACE the previous one granted; a shared name across projects
    // would let one read another's granted paths.
    expect(Sandbox.appContainerProfile(["/w/project"])).toBe(Sandbox.appContainerProfile(["/w/project"]))
    expect(Sandbox.appContainerProfile(["/w/a"])).not.toBe(Sandbox.appContainerProfile(["/w/b"]))
  })

  test("the profile name is a legal AppContainer name", () => {
    // Windows limits both length and character set, and a workspace path
    // carries separators, drive letters and spaces that are not valid in one.
    const name = Sandbox.appContainerProfile(["C:\\Users\\me\\My Project (v2)"])
    expect(name).toMatch(/^[A-Za-z0-9.-]{1,64}$/)
  })

  test("wrapArgv launches the binary as its own container launcher", () => {
    // There is no wrapper executable on Windows: confinement is applied AT
    // CreateProcess through SECURITY_CAPABILITIES, which cannot be expressed as
    // an argv. The binary becomes the launcher, exactly as __egress-shim does.
    const w = Sandbox.wrapArgv({ ...base, options: { enabled: true, network: "allow" } })
    expect(w.sandboxed).toBe(true)
    expect(w.backend).toBe("appcontainer")
    expect(w.file).toBe(process.execPath)
    // Located, not indexed at 0. Running from source, `process.execPath` is bun
    // and an entry script has to precede the flag — `bun __appcontainer-launch`
    // is not a valid invocation and exits 1 silently, which the self-test reads
    // as a child that produced no output. A release binary needs no entry, so
    // the flag's position differs between the two modes by design.
    expect(w.args).toContain("__appcontainer-launch")
  })

  test("the real argv survives at the tail, after a --", () => {
    const w = Sandbox.wrapArgv({ ...base, options: { enabled: true, network: "allow" } })
    expect(w.args.slice(-3)).toEqual(["python3", "-u", "/w/k.py"])
    expect(w.args[w.args.length - 4]).toBe("--")
  })

  test("the policy travels as one base64 blob, not as flags", () => {
    // Windows re-parses command lines with CommandLineToArgvW rules that differ
    // from every shell, and paths there routinely carry spaces, quotes and
    // backslashes. A blob with no shell-significant characters cannot be mangled.
    const w = Sandbox.wrapArgv({ ...base, options: { enabled: true, network: "allow" } })
    const blob = w.args[w.args.indexOf("__appcontainer-launch") + 1]!
    expect(blob).toMatch(/^[A-Za-z0-9+/=]+$/)
    const spec = decode(w.args)
    expect(spec.profile).toBe(Sandbox.appContainerProfile(["/w/project"]))
    expect(spec.writable).toContain("/w/project")
    expect(spec.network).toBe("allow")
  })

  test("allowlist mints a pipe and carries the host proxy; deny and allow carry neither", () => {
    // `egress` arrives as "port:secret" — the same shape seatbelt gets, because
    // the host-side proxy IS the same TCP listener on loopback. What differs is
    // only how the CONTAINER reaches it, and that is the broker's pipe.
    //
    // The pipe NAME is minted here rather than supplied by the caller: it must
    // be unguessable, since the DACL is the whole access decision and a
    // predictable name is one an unrelated AppContainer could try to open.
    const withPipe = Sandbox.wrapArgv({
      ...base,
      options: { enabled: true, network: "allowlist", egress: "49876:s3cret" },
    })
    const spec = decode(withPipe.args)
    expect(spec.pipe).toMatch(/^openscience-broker-[0-9a-f]{32}$/)
    expect(spec.proxy).toEqual({ port: 49876, secret: "s3cret" })
    // Two runs never share a name.
    const again = Sandbox.wrapArgv({
      ...base,
      options: { enabled: true, network: "allowlist", egress: "49876:s3cret" },
    })
    expect(decode(again.args).pipe).not.toBe(spec.pipe)

    for (const network of ["deny", "allow"] as const) {
      const w = Sandbox.wrapArgv({ ...base, options: { enabled: true, network } })
      expect(decode(w.args).pipe).toBeUndefined()
      expect(decode(w.args).proxy).toBeUndefined()
    }
  })

  test("the shim's own binary is readable, or the proxy is a dead port", () => {
    // The shim IS this binary, re-entered inside the container, and an
    // AppContainer executes nothing whose ACL does not name its package SID.
    // Without this grant the shim never starts and the payload is handed a
    // 127.0.0.1 port with nothing behind it — which presents as a network
    // failure rather than as a missing grant.
    const w = Sandbox.wrapArgv({
      ...base,
      options: { enabled: true, network: "allowlist", egress: "49876:s3cret" },
    })
    expect(decode(w.args).readable).toContain(process.execPath)
    // Only when a shim is actually needed.
    const denied = Sandbox.wrapArgv({ ...base, options: { enabled: true, network: "deny" } })
    expect(decode(denied.args).readable ?? []).not.toContain(process.execPath)
  })

  test("composing without a profile throws rather than launching unconfined", () => {
    // Fail closed, the same rule bubblewrapArgs applies to a missing egress
    // socket: a launch with no profile has no package SID, so nothing is
    // contained and every ACE and DACL downstream refers to nothing.
    expect(() => Sandbox.appContainerArgs({ writable: ["/w"], network: "allow" }, ["cmd"])).toThrow("profile")
  })

  test("the real Windows backend is probed, never assumed", async () => {
    // This test previously asserted the probe never said "appcontainer" at all,
    // which was correct while no launcher existed. Now one does, so the
    // invariant moves rather than disappears: win32 must resolve through
    // AppContainer.usable(), which loads the DLLs and derives a SID, and must
    // fall back to "none" when that fails. Returning "appcontainer" because the
    // platform says win32 is how a product ends up claiming a sandbox it never
    // applies.
    const source = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
    const detected = source.slice(source.indexOf("const detected = lazy"), source.indexOf("export function backend"))
    expect(detected.includes("AppContainer.usable()")).toBe(true)
    expect(detected.includes('AppContainer.usable() ? "appcontainer" : "none"')).toBe(true)
  })

  test("the capability probe is side-effect free and fails closed", async () => {
    // It derives a SID rather than creating a profile, so a probe on a machine
    // we end up not sandboxing leaves nothing behind; and every failure path
    // returns false rather than throwing, because a probe that throws would
    // take down callers that only wanted to know whether a backend exists.
    const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
    const usable = source.slice(
      source.indexOf("export function usable"),
      source.indexOf("export function ensureProfile"),
    )
    expect(usable.includes("CreateAppContainerProfile")).toBe(false)
    expect(usable.includes("catch")).toBe(true)
    expect(usable.includes("return false")).toBe(true)
  })
})

describe("Sandbox.plan on win32", () => {
  // The win32 describe above only ever exercised wrapArgv, so nothing asserted
  // what plan() composes — which is where the shell flag lives, and where the
  // bug that made every Windows command a no-op survived.
  const base = {
    cwd: "C:\\work\\project",
    workspace: ["C:\\work\\project"],
    options: { enabled: true, network: "deny" as const },
    platform: "win32" as const,
  }

  test("a cmd.exe shell is invoked with /c, never -c", () => {
    const p = Sandbox.plan({ ...base, command: "whoami /groups", shell: "C:\\Windows\\system32\\cmd.exe" })
    // The launcher argv is: openscience __appcontainer-launch <spec> -- <shell> /c <cmd>
    const tail = p.args!.slice(p.args!.indexOf("--") + 1)
    // /d /s /c, the shape Node uses: /s makes cmd take the tail verbatim after
    // stripping one quote pair, /d skips AutoRun registry commands so a
    // sandboxed command cannot be prefixed by machine-local configuration.
    expect(tail.slice(1, 4)).toEqual(["/d", "/s", "/c"])
    expect(tail).not.toContain("-c")
    expect(tail[4]).toBe("whoami /groups")
  })

  test("a Git Bash shell still gets -c", () => {
    // Shell.fallback() prefers Git Bash over cmd on Windows, so both shapes are
    // reachable on the same platform and the flag cannot key off the platform.
    const p = Sandbox.plan({ ...base, command: "echo hi", shell: "C:\\Program Files\\Git\\bin\\bash.exe" })
    const tail = p.args!.slice(p.args!.indexOf("--") + 1)
    expect(tail[1]).toBe("-c")
  })

  test("no POSIX temp path reaches the writable spec", () => {
    // "/tmp" resolves to "C:\tmp" on Windows, which does not exist, so icacls
    // failed on it and every sandboxed command carried a grant warning on its
    // stderr — burying the real errors under it.
    const p = Sandbox.plan({ ...base, command: "echo hi", shell: "cmd.exe" })
    const spec = JSON.parse(
      Buffer.from(p.args![p.args!.indexOf("__appcontainer-launch") + 1]!, "base64").toString("utf8"),
    )
    // On a Windows host "/tmp" resolves to "C:\tmp"; asserting the absence of
    // "/tmp" itself would only pass here by accident, because this Linux box's
    // own os.tmpdir() IS "/tmp" and legitimately belongs in the list.
    expect(spec.writable.some((w: string) => /^[A-Za-z]:\\tmp$/i.test(w))).toBe(false)
  })
})

// `tempDirs` is gone. It granted the sandbox the SHARED host temp, which let
// mutually untrusted sessions read and overwrite each other's scratch files, and
// on Windows it also labelled the user's whole %TEMP% Low integrity for the
// duration of every run. main replaced it with `privateTemp()`: one 0700
// directory per spawn, carried on the Plan and reclaimed by the caller. The
// property that mattered here — no POSIX literals on win32 — is now structural,
// because no shared temp is granted on any platform.

test("the one thing Windows cannot deliver is said once, with the remedy", () => {
  // AppContainer loopback is blocked at the firewall layer regardless of
  // capability, and the exemption needs admin — out of scope for this product.
  // So `allow` cannot reach a local Ollama, Jupyter or model server. A doc line
  // is where that goes to die: the user would see `connection refused` and
  // nothing else, which is the shape of every expensive bug in this feature.
  //
  // It rides the SAME one-time `warning` channel as "sandbox requested but
  // unavailable" — the same species of problem, and a second mechanism for it is
  // how two commands end up disagreeing about one state.
  const base = {
    command: "curl https://example.com",
    shell: "cmd.exe",
    cwd: "C:\\w",
    workspace: ["C:\\w"],
    platform: "win32" as const,
  }
  // The win32 block above already planned with network "allow", consuming the
  // one-time flag. Reset rather than depend on source order.
  Sandbox.forgetWarnings()
  const first = Sandbox.plan({ ...base, options: { enabled: true, network: "allow" } })
  expect(first.warning).toContain("127.0.0.1")
  // The remedy, not an apology: allowlist CAN reach localhost, because the
  // broker runs on the host and a host process has no loopback restriction.
  expect(first.warning).toContain("allowlist")
  // Once per process, like warned.unavailable.
  const second = Sandbox.plan({ ...base, options: { enabled: true, network: "allow" } })
  expect(second.warning).toBeUndefined()
})
