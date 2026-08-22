import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ModalPlan } from "../../src/compute/modal/plan"
import { ModalUpload } from "../../src/compute/modal/upload"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function project() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openscience-modal-plan-")))
  roots.push(root)
  await fs.mkdir(path.join(root, "src"), { recursive: true })
  await fs.writeFile(path.join(root, "src", "train.py"), "print('ready')\n")
  return root
}

function input(root: string) {
  return {
    purpose: "Fit the approved model and save evaluation metrics.",
    command: "python src/train.py",
    cwd: root,
    image: "python:3.12-slim",
    packages: ["scikit-learn==1.7.1", "numpy==2.3.2"],
    gpu: "T4",
    timeoutMinutes: 10,
    uploads: ["src/**/*.py"],
    outputs: ["outputs/**/*.csv"],
    context: { app: "openscience", network: "none" as const },
  }
}

describe("ModalPlan", () => {
  test("binds the exact files and governed run settings into one approval digest", async () => {
    const root = await project()
    const first = await ModalPlan.prepare(input(root))
    const second = await ModalPlan.prepare(input(root))

    expect(first.plan.digest).toBe(second.plan.digest)
    expect(first.plan.uploads).toEqual([
      {
        path: "src/train.py",
        size: 15,
        sha256: new Bun.CryptoHasher("sha256").update("print('ready')\n").digest("hex"),
      },
    ])
    expect(first.plan.network).toBe("none")
    expect(first.plan.purpose).toBe("Fit the approved model and save evaluation metrics.")
    expect(first.plan.packages).toEqual(["numpy==2.3.2", "scikit-learn==1.7.1"])
    expect(first.plan.warning).toContain("may incur charges")

    await fs.writeFile(path.join(root, "src", "train.py"), "print('changed')\n")
    expect((await ModalPlan.prepare(input(root))).plan.digest).not.toBe(first.plan.digest)
    expect((await ModalPlan.prepare({ ...input(root), packages: ["numpy==2.3.3"] })).plan.digest).not.toBe(
      first.plan.digest,
    )
    expect((await ModalPlan.prepare({ ...input(root), purpose: "Run a different experiment." })).plan.digest).not.toBe(
      first.plan.digest,
    )
  })

  test("accepts a project root reached through a symlink", async () => {
    const root = await project()
    const alias = `${root}-alias`
    roots.push(alias)
    await fs.symlink(root, alias)

    const prepared = await ModalPlan.prepare(input(alias))

    expect(prepared.plan.uploads.map((file) => file.path)).toEqual(["src/train.py"])
  })

  test("keeps exact approval stable across isolated conversation scratch roots", async () => {
    const firstRoot = await project()
    const secondRoot = await project()

    const first = await ModalPlan.prepare(input(firstRoot))
    const second = await ModalPlan.prepare(input(secondRoot))

    expect(first.plan.cwd).not.toBe(second.plan.cwd)
    expect(first.plan.workspace_cwd).toBe(".")
    expect(second.plan.workspace_cwd).toBe(".")
    expect(first.plan.digest).toBe(second.plan.digest)
  })

  test("denies secrets, control directories, and paths outside the project", async () => {
    const root = await project()
    await fs.writeFile(path.join(root, ".env"), "MODAL_TOKEN_SECRET=secret\n")
    await fs.writeFile(path.join(root, ".modal.toml"), "token_secret = 'secret'\n")

    await expect(ModalPlan.prepare({ ...input(root), uploads: [".env"] })).rejects.toThrow("Modal upload policy denied")
    await expect(ModalPlan.prepare({ ...input(root), uploads: [".modal.toml"] })).rejects.toThrow(
      "Modal upload policy denied",
    )
    await expect(ModalPlan.prepare({ ...input(root), uploads: ["../*"] })).rejects.toThrow(
      "must stay inside the project",
    )
  })

  test("a symlink alias cannot disguise a denied credential file", async () => {
    const root = await project()
    await fs.writeFile(path.join(root, ".env"), "PRIVATE_TOKEN=secret\n")
    await fs.symlink(path.join(root, ".env"), path.join(root, "src", "settings.py"))

    await expect(ModalPlan.prepare({ ...input(root), uploads: ["src/**/*.py"] })).rejects.toThrow(
      "Modal upload policy denied",
    )
  })

  test("does not upload files excluded by the project's gitignore", async () => {
    const root = await project()
    await fs.writeFile(path.join(root, ".gitignore"), "src/private.py\n")
    await fs.writeFile(path.join(root, "src", "private.py"), "TOKEN = 'private'\n")

    const prepared = await ModalPlan.prepare({ ...input(root), uploads: ["src/**/*.py"] })

    expect(prepared.plan.uploads.map((file) => file.path)).toEqual(["src/train.py"])
  })

  test("honors nested gitignore files", async () => {
    const root = await project()
    const git = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "pipe" })
    if ((await git.exited) !== 0) throw new Error(await new Response(git.stderr).text())
    await fs.writeFile(path.join(root, "src", ".gitignore"), "private.py\n")
    await fs.writeFile(path.join(root, "src", "private.py"), "TOKEN = 'private'\n")

    const prepared = await ModalPlan.prepare({ ...input(root), uploads: ["src/**/*.py"] })

    expect(prepared.plan.uploads.map((file) => file.path)).toEqual(["src/train.py"])
  })

  test("rejects an oversized sparse input before reading its contents", async () => {
    const root = await project()
    const large = path.join(root, "src", "large.bin")
    await fs.writeFile(large, "")
    await fs.truncate(large, ModalUpload.LIMIT + 1)
    const reads: string[] = []
    using guard = ModalUpload.testing({
      read(file) {
        reads.push(file)
      },
    })

    await expect(ModalPlan.prepare({ ...input(root), uploads: ["src/large.bin"] })).rejects.toThrow(
      "input exceeds the 100 MiB approval limit",
    )
    expect(reads).toEqual([])
  })

  test("rejects an oversized aggregate before hashing any sparse input", async () => {
    const root = await project()
    const size = 60 * 1024 * 1024
    await Promise.all([
      fs.writeFile(path.join(root, "src", "first.bin"), ""),
      fs.writeFile(path.join(root, "src", "second.bin"), ""),
    ])
    await Promise.all([
      fs.truncate(path.join(root, "src", "first.bin"), size),
      fs.truncate(path.join(root, "src", "second.bin"), size),
    ])
    const reads: string[] = []
    using guard = ModalUpload.testing({
      read(file) {
        reads.push(file)
      },
    })

    await expect(ModalPlan.prepare({ ...input(root), uploads: ["src/*.bin"] })).rejects.toThrow(
      "uploads exceed the 100 MiB approval limit",
    )
    expect(reads).toEqual([])
  })

  test("deduplicates overlapping patterns and canonical symlink aliases", async () => {
    const root = await project()
    await fs.symlink(path.join(root, "src", "train.py"), path.join(root, "src", "alias.py"))
    const reads: string[] = []
    using guard = ModalUpload.testing({
      read(file) {
        reads.push(file)
      },
    })

    const prepared = await ModalPlan.prepare({
      ...input(root),
      uploads: ["src/train.py", "src/**/*.py", "src/alias.py"],
    })

    expect(prepared.plan.uploads.map((file) => file.path)).toEqual(["src/train.py"])
    expect(prepared.plan.upload_bytes).toBe(15)
    expect(reads).toEqual([path.join(root, "src", "train.py")])
  })
})
