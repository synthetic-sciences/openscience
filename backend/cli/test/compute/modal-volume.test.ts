import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ModalVolume } from "../../src/compute/modal/volume"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "openscience-modal-volume-"))
  roots.push(root)
  const volume = path.join(root, "volume")
  const staging = path.join(root, "staging")
  await fs.mkdir(path.join(volume, "outputs"), { recursive: true })
  await Bun.write(path.join(volume, ".openscience-exit-code"), "0\n")
  await Bun.write(path.join(volume, ".openscience-run.log"), "training complete\n")
  await Bun.write(path.join(volume, "outputs", "model.bin"), "weights")
  await Bun.write(
    path.join(root, "modal.py"),
    [
      "import os",
      "from types import SimpleNamespace",
      "__version__ = 'test-control-plane'",
      "class Handle:",
      "    def __init__(self, root): self.root = root",
      "    def listdir(self, requested, recursive=False):",
      "        base = os.path.join(self.root, requested.lstrip('/'))",
      "        found = []",
      "        scan = os.walk(base) if recursive else [(base, next(os.walk(base))[1], next(os.walk(base))[2])]",
      "        for current, folders, files in scan:",
      "            for name in folders + files:",
      "                target = os.path.join(current, name)",
      "                relative = os.path.relpath(target, self.root).replace(os.sep, '/')",
      "                kind = 'DIRECTORY' if os.path.isdir(target) else 'FILE'",
      "                size = 0 if kind == 'DIRECTORY' else os.path.getsize(target)",
      "                found.append(SimpleNamespace(path=relative, type=SimpleNamespace(name=kind), size=size, mtime=1))",
      "        return found",
      "    def read_file(self, requested):",
      "        with open(os.path.join(self.root, requested.lstrip('/')), 'rb') as source:",
      "            while chunk := source.read(3): yield chunk",
      "class Objects:",
      "    def list(self, environment_name=None):",
      "        assert environment_name == 'main'",
      "        return [SimpleNamespace(name='job-volume')]",
      "class Volume:",
      "    objects = Objects()",
      "    @classmethod",
      "    def from_name(cls, name, environment_name=None, create_if_missing=False):",
      "        assert os.environ.get('MODAL_TOKEN_ID') == 'ak-test'",
      "        assert os.environ.get('MODAL_TOKEN_SECRET') == 'as-test'",
      "        assert name == 'job-volume'",
      "        assert environment_name == 'main'",
      "        return Handle(os.environ['FAKE_MODAL_ROOT'])",
      "",
    ].join("\n"),
  )
  const python = Bun.which("python3") ?? Bun.which("python")
  if (!python) throw new Error("Python is required for the Modal Volume driver test")
  const run = "import runpy,sys; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[2],run_name='__main__')"
  const context = {
    tokenId: "ak-test",
    tokenSecret: "as-test",
    environment: "main",
    command: [python, "-I", "-c", run, root, await ModalVolume.driverPath()],
    env: { ...process.env, FAKE_MODAL_ROOT: volume },
  }
  return { context, staging }
}

describe("ModalVolume", () => {
  test("accepts a system Python only when the pinned SDK is available in isolated mode", async () => {
    const python = Bun.which("python3") ?? Bun.which("python")
    if (!python) throw new Error("Python is required for the Modal Volume driver test")
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "openscience-modal-poison-"))
    roots.push(root)
    await Bun.write(path.join(root, "modal.py"), "raise RuntimeError('ambient modal module loaded')\n")

    const selected = await ModalVolume.command({
      tokenId: "ak-test",
      tokenSecret: "as-test",
      env: { ...process.env, PYTHONPATH: root },
      python,
      uv: "/test/uv",
    })

    expect(selected).toEqual([
      "/test/uv",
      "run",
      "--no-project",
      "--python",
      "3.12",
      "--with",
      `modal==${ModalVolume.VERSION}`,
      "python",
      "-I",
      await ModalVolume.driverPath(),
    ])
  })

  test("uses control-plane list and download operations without a sandbox", async () => {
    const item = await fixture()

    expect(await ModalVolume.check(item.context)).toBe("test-control-plane")
    expect(await ModalVolume.volumes(item.context)).toEqual([{ name: "job-volume" }])
    const entries = await ModalVolume.list(item.context, "job-volume", "/", true)
    expect(entries).toContainEqual({ path: "outputs/model.bin", type: "file", size: 7, mtime: 1 })

    const downloaded = await ModalVolume.download(
      item.context,
      "job-volume",
      [".openscience-exit-code", ".openscience-run.log", "outputs/model.bin"],
      item.staging,
    )
    expect(downloaded.map((entry) => entry.path)).toEqual([
      ".openscience-exit-code",
      ".openscience-run.log",
      "outputs/model.bin",
    ])
    expect(downloaded.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true)
    expect(await Bun.file(path.join(item.staging, "outputs", "model.bin")).text()).toBe("weights")
  })

  test("rejects requested paths outside its staging directory", async () => {
    const item = await fixture()
    await expect(ModalVolume.download(item.context, "job-volume", ["../secret"], item.staging)).rejects.toThrow(
      /unsafe path/,
    )
  })
})
