import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ModalVolume } from "../../src/compute/modal/volume"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"

const roots: string[] = []

type LedgerEntry = {
  id: string
  kind: string
  pid: number
  identity: string
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function ledger(): Promise<LedgerEntry[]> {
  return Bun.file(CredentialProcessLedger.pathForTests())
    .json()
    .catch(() => []) as Promise<LedgerEntry[]>
}

async function waitText(file: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = await Bun.file(file)
      .text()
      .catch(() => undefined)
    if (value?.trim()) return value.trim()
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

async function waitEntry(previous: Set<string>) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const entry = (await ledger()).find((item) => item.kind === "modal-volume" && !previous.has(item.id))
    if (entry) return entry
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for the Modal Volume bridge ledger entry")
}

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

  test("request abort revokes a blocked durable download bridge before rejecting", async () => {
    const item = await fixture()
    const python = Bun.which("python3") ?? Bun.which("python")
    if (!python) throw new Error("Python is required for the Modal Volume driver test")
    const blocker = path.join(item.root, "blocked-download.py")
    const marker = path.join(item.staging, "started")
    await Bun.write(
      blocker,
      [
        "import json, os, sys, time",
        "request = json.load(sys.stdin)",
        "marker = os.path.join(request['staging'], 'started')",
        "with open(marker, 'w') as handle:",
        "    handle.write(str(os.getpid()))",
        "    handle.flush()",
        "    os.fsync(handle.fileno())",
        "time.sleep(600)",
      ].join("\n"),
    )
    const previous = new Set((await ledger()).map((entry) => entry.id))
    const controller = new AbortController()
    const reason = new DOMException("browser disconnected", "AbortError")
    const running = ModalVolume.download(
      { ...item.context, command: [python, "-I", blocker] },
      "job-volume",
      ["outputs/model.bin"],
      item.staging,
      { signal: controller.signal },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let entry: LedgerEntry | undefined

    try {
      const active = await Promise.all([waitText(marker), waitEntry(previous)]).then(([, value]) => value)
      entry = active
      expect(await CredentialProcessLedger.owns(active.pid, active.identity)).toBe(true)
      controller.abort(reason)
      const result = await running
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("The blocked Modal Volume download unexpectedly completed")
      expect(result.error).toBe(reason)
      expect(await CredentialProcessLedger.owns(active.pid, active.identity)).toBe(false)
      expect((await ledger()).some((item) => item.id === active.id)).toBe(false)
    } finally {
      controller.abort(reason)
      await running
      if (entry) {
        await CredentialProcessLedger.revoke({ id: entry.id, kind: "modal-volume" }).catch(() => undefined)
      }
    }
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

  test("rejects a declared aggregate above live safe capacity before launching the provider bridge", async () => {
    const item = await fixture()
    const launched = path.join(item.root, "provider-launched")
    const python = Bun.which("python3") ?? Bun.which("python")
    if (!python) throw new Error("Python is required for the Modal Volume driver test")
    const statfs = spyOn(fs, "statfs").mockResolvedValue({
      bavail: ModalVolume.DOWNLOAD_DISK_RESERVE_BYTES + 6,
      bsize: 1,
    } as Awaited<ReturnType<typeof fs.statfs>>)

    try {
      const error = await ModalVolume.download(
        {
          ...item.context,
          command: [
            python,
            "-I",
            "-c",
            `from pathlib import Path; Path(${JSON.stringify(launched)}).write_text('launched')`,
          ],
        },
        "job-volume",
        ["outputs/model.bin"],
        item.staging,
        { declaredBytes: 7 },
      ).catch((value) => value)

      expect(error).toBeInstanceOf(ModalVolume.DownloadCapacityError)
      expect((error as ModalVolume.DownloadCapacityError).safeCapacityBytes).toBe(6)
      expect((error as ModalVolume.DownloadCapacityError).responseBytes).toBe(7)
      expect((error as Error).message).toContain("512 MiB")
      expect(await Bun.file(launched).exists()).toBe(false)
      expect(await Bun.file(item.staging).exists()).toBe(false)
    } finally {
      statfs.mockRestore()
    }
  })

  test("bounds understated provider bytes and removes partial staging", async () => {
    const item = await fixture()
    const statfs = spyOn(fs, "statfs").mockResolvedValue({
      bavail: ModalVolume.DOWNLOAD_DISK_RESERVE_BYTES + 6,
      bsize: 1,
    } as Awaited<ReturnType<typeof fs.statfs>>)

    try {
      const error = await ModalVolume.download(item.context, "job-volume", ["outputs/model.bin"], item.staging, {
        declaredBytes: 1,
      }).catch((value) => value)

      expect(error).toBeInstanceOf(ModalVolume.DownloadCapacityError)
      expect((error as ModalVolume.DownloadCapacityError).safeCapacityBytes).toBe(6)
      expect((error as ModalVolume.DownloadCapacityError).responseBytes).toBe(7)
      expect(await Bun.file(item.staging).exists()).toBe(false)
    } finally {
      statfs.mockRestore()
    }
  }, 30_000)

  test("classifies an ENOSPC staging write and removes the partial tree", async () => {
    const item = await fixture()
    const python = Bun.which("python3") ?? Bun.which("python")
    if (!python) throw new Error("Python is required for the Modal Volume driver test")
    const wrapper = path.join(item.root, "enospc-download.py")
    await Bun.write(
      wrapper,
      [
        "import builtins, errno, os, runpy, sys",
        "real_open = builtins.open",
        `staging = os.path.realpath(${JSON.stringify(item.staging)})`,
        "def guarded_open(file, mode='r', *args, **kwargs):",
        "    target = os.path.realpath(os.fspath(file))",
        "    if 'w' in mode and (target == staging or target.startswith(staging + os.sep)):",
        "        raise OSError(errno.ENOSPC, 'injected staging exhaustion')",
        "    return real_open(file, mode, *args, **kwargs)",
        "builtins.open = guarded_open",
        "sys.path.insert(0, sys.argv[1])",
        "runpy.run_path(sys.argv[2], run_name='__main__')",
      ].join("\n"),
    )
    const statfs = spyOn(fs, "statfs").mockResolvedValue({
      bavail: ModalVolume.DOWNLOAD_DISK_RESERVE_BYTES + 64,
      bsize: 1,
    } as Awaited<ReturnType<typeof fs.statfs>>)

    try {
      const error = await ModalVolume.download(
        { ...item.context, command: [python, "-I", wrapper, item.root, await ModalVolume.driverPath()] },
        "job-volume",
        ["outputs/model.bin"],
        item.staging,
        { declaredBytes: 7 },
      ).catch((value) => value)

      expect(error).toBeInstanceOf(ModalVolume.DownloadCapacityError)
      expect((error as ModalVolume.DownloadCapacityError).storageCode).toBe("ENOSPC")
      expect((error as Error).message).toContain("staging storage returned ENOSPC")
      expect(await Bun.file(item.staging).exists()).toBe(false)
    } finally {
      statfs.mockRestore()
    }
  }, 30_000)

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
