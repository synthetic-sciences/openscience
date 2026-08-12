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
      `        return Handle(${JSON.stringify(volume)})`,
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
  }
  return { context, root, staging }
}

describe("ModalVolume", () => {
  test("passes only runtime fields to the token-bearing bridge", () => {
    const env = ModalVolume.environment({
      PATH: "/usr/bin:/bin",
      HOME: "/home/researcher",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "provider-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      MODAL_TOKEN_SECRET: "old-control-plane-secret",
      OPENSCIENCE_CONFIG_CONTENT: "control-plane-state",
      DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
      PYTHONSTARTUP: "/tmp/startup.py",
    })

    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env.HOME).toBe("/home/researcher")
    expect(env.LANG).toBe("en_US.UTF-8")
    expect(env.PYTHONNOUSERSITE).toBe("1")
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.MODAL_TOKEN_SECRET).toBeUndefined()
    expect(env.OPENSCIENCE_CONFIG_CONTENT).toBeUndefined()
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(env.PYTHONSTARTUP).toBeUndefined()
  })

  test("redacts the exact Modal token pair from bounded bridge failures", async () => {
    const python = Bun.which("python3") ?? Bun.which("python")
    if (!python) throw new Error("Python is required for the Modal Volume driver test")
    const error = await ModalVolume.check({
      tokenId: "ak-never-log-this-id",
      tokenSecret: "as-never-log-this-secret",
      command: [
        python,
        "-I",
        "-c",
        "import os,sys; sys.stderr.write(os.environ['MODAL_TOKEN_ID'] + ':' + os.environ['MODAL_TOKEN_SECRET']); sys.exit(3)",
      ],
    }).catch((value) => value)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("[REDACTED]:[REDACTED]")
    expect((error as Error).message).not.toContain("ak-never-log-this-id")
    expect((error as Error).message).not.toContain("as-never-log-this-secret")
  })

  test("shares one complete driver path across concurrent callers", async () => {
    const paths = await Promise.all(Array.from({ length: 20 }, () => ModalVolume.driverPath()))
    expect(new Set(paths).size).toBe(1)
    expect((await fs.stat(paths[0]!)).isFile()).toBe(true)
  })

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

  // This is four independent control-plane calls. Each call deliberately
  // completes durable helper ownership and descendant reaping before the next
  // one starts, so their combined deadline must not inherit Bun's 5s default.
  test("uses the governed control-plane bridge for list and download operations", async () => {
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
  }, 30_000)

  test("waits for a durable marker inside one driver process", async () => {
    const item = await fixture()
    const marker = path.join(item.root, "volume", ".openscience-exit-code")
    await fs.rm(marker)
    const write = Bun.sleep(100).then(() => Bun.write(marker, "0\n"))

    const entries = await ModalVolume.wait(item.context, "job-volume", ".openscience-exit-code", 20, 20)
    await write

    expect(entries.some((entry) => entry.path === ".openscience-exit-code")).toBe(true)
  })

  test("rejects requested paths outside its staging directory", async () => {
    const item = await fixture()
    await expect(ModalVolume.download(item.context, "job-volume", ["../secret"], item.staging)).rejects.toThrow(
      /unsafe path/,
    )
  })

  test("accepts downloads when a staging parent is reached through a symlink", async () => {
    const item = await fixture()
    const real = path.join(item.root, "real")
    const alias = path.join(item.root, "alias")
    await fs.mkdir(real)
    await fs.symlink(real, alias)

    const downloaded = await ModalVolume.download(
      item.context,
      "job-volume",
      ["outputs/model.bin"],
      path.join(alias, "staging"),
    )

    expect(downloaded[0]?.staging).toBe(await fs.realpath(path.join(real, "staging", "outputs", "model.bin")))
    expect(await Bun.file(downloaded[0]!.staging).text()).toBe("weights")
  })
})
