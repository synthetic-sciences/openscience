import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ModalAdapter } from "../../src/compute/modal/adapter"

describe("ModalAdapter image", () => {
  test("installs approved Python packages in the Modal image layer", () => {
    expect(ModalAdapter.layers([])).toEqual([])
    expect(ModalAdapter.layers(["numpy==2.3.2", "scikit-learn==1.7.1"])).toEqual([
      "RUN python -m pip install --disable-pip-version-check --no-cache-dir 'numpy==2.3.2' 'scikit-learn==1.7.1'",
    ])
  })

  test("quotes package requirements as data instead of Docker shell syntax", () => {
    expect(ModalAdapter.layers(["project; echo unsafe", "name's-extra"])[0]).toContain(
      `'project; echo unsafe' 'name'\"'\"'s-extra'`,
    )
  })
})

describe("ModalAdapter sandbox lifecycle", () => {
  test("assigns each governed job durable storage without exposing its project path", () => {
    const first = ModalAdapter.volume("/work/research/private-project", "job-one")
    const repeat = ModalAdapter.volume("/work/research/private-project", "job-one")
    const second = ModalAdapter.volume("/work/research/private-project", "job-two")

    expect(first).toBe(repeat)
    expect(first).not.toBe(second)
    expect(first).toMatch(/^openscience-job-[a-f0-9]{32}$/)
    expect(first).not.toContain("private-project")
  })

  test("exits immediately after recording the durable result", async () => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "openscience-modal-"))
    const child = Bun.spawn(
      ["bash", "-lc", ModalAdapter.script("printf 'completed\\n'; printf artifact > result.txt", root)],
      { stdout: "ignore", stderr: "ignore", cwd: root },
    )
    await Bun.write(path.join(root, ".openscience-ready"), "approved\n")
    const result = path.join(root, ".openscience-exit-code")
    const timeout = setTimeout(() => child.kill(), 10_000)
    const code = await child.exited.finally(() => clearTimeout(timeout))
    expect(code).toBe(0)
    expect(await Bun.file(result).text()).toBe("0\n")
    expect(await Bun.file(path.join(root, "result.txt")).text()).toBe("artifact")
    expect(await Bun.file(path.join(root, ".openscience-run.log")).text()).toBe("completed\n")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("uses the sandbox timeout result when the terminated command records a different code", () => {
    expect(ModalAdapter.reconcile(124, { code: 120, outputs: [] })).toEqual({
      code: 124,
      outputs: [],
      timedOut: true,
    })
  })
})
