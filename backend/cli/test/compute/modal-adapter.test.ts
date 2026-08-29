import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ModalAdapter } from "../../src/compute/modal/adapter"
import { ModalUpload } from "../../src/compute/modal/upload"

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

  test("installs scientific packs only from a sha256 wheel lock", () => {
    const requirements = "numpy==2.5.2 --hash=sha256:" + "a".repeat(64) + "\n"
    const layer = ModalAdapter.layers(["numpy==2.5.2"], { digest: "b".repeat(64), requirements })[0]!
    expect(layer).toContain("--only-binary=:all:")
    expect(layer).toContain("--require-hashes")
    expect(layer).not.toContain(requirements)
    expect(layer).toContain(Buffer.from(requirements).toString("base64"))
  })
})

describe("ModalAdapter client lifecycle", () => {
  test("reuses one client for repeated operations under the same credential identity", () => {
    const created: string[] = []
    const closed: string[] = []
    const pool = new ModalAdapter.ClientPool((context) => {
      const id = `${context.tokenId}:${context.environment ?? "default"}`
      created.push(id)
      return { close: () => closed.push(id) }
    })
    const context = { tokenId: "token", tokenSecret: "secret", environment: "main" }

    const first = pool.acquire(context)
    const second = pool.acquire({ ...context })

    expect(second).toBe(first)
    expect(created).toEqual(["token:main"])
    expect(pool.size).toBe(1)
    pool.dispose()
    expect(closed).toEqual(["token:main"])
    expect(pool.size).toBe(0)
    expect(() => pool.acquire(context)).toThrow("Modal client pool is disposed")
    pool.dispose()
    expect(closed).toEqual(["token:main"])
  })

  test("bounds transports across repeated credential or environment changes", () => {
    const pool = new ModalAdapter.ClientPool(() => ({ close() {} }), 2)
    pool.acquire({ tokenId: "first", tokenSecret: "secret", environment: "main" })
    pool.acquire({ tokenId: "first", tokenSecret: "secret", environment: "staging" })

    expect(() => pool.acquire({ tokenId: "second", tokenSecret: "other", environment: "main" })).toThrow(
      "Restart OpenScience before using Modal again",
    )
    expect(pool.size).toBe(2)
  })
})

describe("ModalAdapter sandbox lifecycle", () => {
  test("streams incremental stdout chunks without rereading the full remote log", async () => {
    const chunks: Array<{ value: string; mode: string | undefined }> = []
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("first\n")
        controller.enqueue("second\n")
        controller.close()
      },
    })

    await ModalAdapter.consumeOutput(
      stream,
      async (value, mode) => {
        chunks.push({ value, mode })
      },
      "replace",
    )

    expect(chunks).toEqual([
      { value: "first\n", mode: "replace" },
      { value: "second\n", mode: "append" },
    ])
  })

  test("clears a stale recovered snapshot when the durable log is empty", async () => {
    const chunks: Array<{ value: string; mode: string | undefined }> = []
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.close()
      },
    })

    await ModalAdapter.consumeOutput(
      stream,
      async (value, mode) => {
        chunks.push({ value, mode })
      },
      "replace",
    )

    expect(chunks).toEqual([{ value: "", mode: "replace" }])
  })

  test("holds partial lines so redaction cannot be bypassed across stream chunks", async () => {
    const chunks: string[] = []
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("token=secret-")
        controller.enqueue("value\nnext")
        controller.enqueue(" line\n")
        controller.close()
      },
    })

    await ModalAdapter.consumeOutput(stream, async (value) => {
      chunks.push(value)
    })
    expect(chunks).toEqual(["token=secret-value\n", "next line\n"])
  })

  test("bounds a pathological line without exposing a partial secret or retaining the full log", async () => {
    const chunks: string[] = []
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("x".repeat(700_000))
        controller.enqueue(`${"y".repeat(700_000)}\nnext\n`)
        controller.close()
      },
    })

    await ModalAdapter.consumeOutput(stream, async (value) => {
      chunks.push(value)
    })

    expect(chunks).toEqual(["[OpenScience omitted an output line larger than 1048576 characters]\n", "next\n"])
  })

  test("classifies permanent recovery failures without treating transient control errors as terminal", () => {
    expect(ModalAdapter.recoveryFailure(Object.assign(new Error("invalid token"), { code: 16 }))).toEqual({
      retryable: false,
      kind: "unauthorized",
    })
    expect(ModalAdapter.recoveryFailure(Object.assign(new Error("missing"), { status: 404 }))).toEqual({
      retryable: false,
      kind: "not_found",
    })
    expect(ModalAdapter.recoveryFailure(new ModalAdapter.OwnershipError("wrong owner"))).toEqual({
      retryable: false,
      kind: "ownership_mismatch",
    })
    expect(ModalAdapter.recoveryFailure(Object.assign(new Error("resource exhausted"), { code: 8 }))).toEqual({
      retryable: true,
    })
    expect(ModalAdapter.recoveryFailure(Object.assign(new Error("rate limited"), { status: 429 }))).toEqual({
      retryable: true,
    })
    expect(ModalAdapter.recoveryFailure(new Error("temporary control-plane disconnect"))).toEqual({
      retryable: true,
    })
  })

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

describe("ModalAdapter input guard", () => {
  const file = {
    path: "src/train.py",
    canonical: path.resolve("/project/src/train.py"),
    size: 15,
    sha256: "0".repeat(64),
  }

  test("rejects forged size and aggregate manifests before dispatch", () => {
    expect(() => ModalAdapter.validateUploads([{ ...file, size: ModalUpload.LIMIT + 1 }])).toThrow(
      "input exceeds the 100 MiB approval limit",
    )
    expect(() =>
      ModalAdapter.validateUploads([
        { ...file, size: 60 * 1024 * 1024 },
        {
          ...file,
          path: "src/eval.py",
          canonical: path.resolve("/project/src/eval.py"),
          size: 60 * 1024 * 1024,
        },
      ]),
    ).toThrow("uploads exceed the 100 MiB approval limit")
    expect(() =>
      ModalAdapter.validateUploads(
        Array.from({ length: ModalUpload.COUNT_LIMIT + 1 }, (_, index) => ({
          ...file,
          path: `empty/${index}`,
          canonical: path.resolve(`/project/empty/${index}`),
          size: 0,
        })),
      ),
    ).toThrow(`${ModalUpload.COUNT_LIMIT}-file approval limit`)
  })

  test("rejects duplicate, aliased, and escaping remote paths", () => {
    expect(() =>
      ModalAdapter.validateUploads([file, { ...file, canonical: path.resolve("/project/src/other.py") }]),
    ).toThrow("upload path is duplicated")
    expect(() => ModalAdapter.validateUploads([file, { ...file, path: "src/other.py" }])).toThrow(
      "upload source is duplicated",
    )
    expect(() => ModalAdapter.validateUploads([{ ...file, path: "../train.py" }])).toThrow(
      "must stay inside the remote workspace",
    )
    expect(() => ModalAdapter.validateUploads([{ ...file, path: "src\\train.py" }])).toThrow(
      "must stay inside the remote workspace",
    )
    expect(() => ModalAdapter.validateUploads([{ ...file, canonical: "src/train.py" }])).toThrow(
      "upload source must be absolute",
    )
    expect(() => ModalAdapter.validateUploads([{ ...file, sha256: "not-a-checksum" }])).toThrow(
      "input has an invalid checksum",
    )
  })

  test("stages only the content bound by the approved size and checksum", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "openscience-modal-input-")),
    )
    const source = path.join(root, "source.bin")
    const target = path.join(root, "staged.bin")
    await fs.writeFile(source, "approved")
    const approved = await ModalUpload.hash(source)
    await fs.writeFile(source, "replaced")

    await expect(ModalUpload.stage(source, target, approved)).rejects.toThrow("changed after approval")
    expect(await fs.stat(target).catch(() => undefined)).toBeUndefined()
    await fs.rm(root, { recursive: true, force: true })
  })

  test("rejects a post-approval sparse growth before staging reads any content", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "openscience-modal-input-")),
    )
    const source = path.join(root, "source.bin")
    await fs.writeFile(source, "approved")
    const approved = await ModalUpload.hash(source)
    await fs.truncate(source, ModalUpload.LIMIT + 1)
    const reads: string[] = []
    using guard = ModalUpload.testing({
      read(file) {
        reads.push(file)
      },
    })

    await expect(
      ModalAdapter.preflightUploads(root, [
        { path: "source.bin", canonical: source, size: approved.size, sha256: approved.sha256 },
      ]),
    ).rejects.toThrow("input exceeds the 100 MiB approval limit")
    expect(reads).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
  })

  test("stages approved bytes through a bounded stream", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "openscience-modal-input-")),
    )
    const source = path.join(root, "source.bin")
    const target = path.join(root, "staged.bin")
    await fs.writeFile(source, "approved")
    const approved = await ModalUpload.hash(source)

    expect(await ModalUpload.stage(source, target, approved)).toEqual(approved)
    expect(await fs.readFile(target, "utf8")).toBe("approved")
    await fs.rm(root, { recursive: true, force: true })
  })
})
