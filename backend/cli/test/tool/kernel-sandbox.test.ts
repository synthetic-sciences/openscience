import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { Sandbox } from "../../src/sandbox/sandbox"

function run(file: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(file, args, { cwd, stdio: "ignore" })
    p.once("exit", (code) => resolve(code ?? 1))
    p.once("error", () => resolve(1))
  })
}

// The notebook (Python) and R kernels spawn an interpreter on a generated script
// that lives under os.tmpdir() (=/tmp on Linux). Under bwrap /tmp is a fresh
// tmpfs, so the script must be bound back via extraWritable or the interpreter
// can't even read it. This exercises that exact wrapArgv path the kernels use.
describe("Sandbox.wrapArgv — kernel confinement", () => {
  test("wrapped interpreter reads its /tmp script and writes inside, but not outside, the workspace", async () => {
    if (!Sandbox.available()) return // no OS backend — nothing to enforce

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-kernel-test-"))
    const script = path.join(os.tmpdir(), `openscience-kernel-probe-${process.pid}.sh`)
    const outside = path.join(os.homedir(), `.openscience-kernel-escape-${process.pid}`)
    fs.writeFileSync(script, `printf hi > "${work}/inside" && printf x > "${outside}"\n`)
    fs.rmSync(outside, { force: true })

    try {
      const wrapped = Sandbox.wrapArgv({
        file: "/bin/sh",
        args: [script],
        workspace: [work],
        extraWritable: [script],
        options: { enabled: true, network: "deny" },
      })
      expect(wrapped.sandboxed).toBe(true)

      await run(wrapped.file, wrapped.args, work)

      // the script (under /tmp) was bound back and ran → the inside write landed
      expect(fs.existsSync(path.join(work, "inside"))).toBe(true)
      // ...but the write outside the workspace was contained
      expect(fs.existsSync(outside)).toBe(false)
    } finally {
      fs.rmSync(script, { force: true })
      fs.rmSync(outside, { force: true })
      fs.rmSync(work, { recursive: true, force: true })
    }
  })

  test("returns the argv unchanged when the sandbox is disabled", () => {
    const wrapped = Sandbox.wrapArgv({
      file: "python3",
      args: ["-u", "/tmp/kernel.py"],
      workspace: ["/work"],
      options: { enabled: false },
    })
    expect(wrapped.sandboxed).toBe(false)
    expect(wrapped.file).toBe("python3")
    expect(wrapped.args).toEqual(["-u", "/tmp/kernel.py"])
  })
})
