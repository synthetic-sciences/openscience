import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { findPython } from "../../src/tool/notebook"
import { Installer } from "../../src/package/installer"

/**
 * A managed environment's interpreter has to RUN, not merely exist.
 *
 * On Windows a venv's `Scripts\python.exe` is a redirector that resolves its
 * base interpreter from `pyvenv.cfg` at startup. When that resolution fails the
 * file is still there, so an existence check hands the kernel a binary that
 * cannot start. Measured on a real machine as the redirector's own message —
 * `No Python at '...'`, a string that appears nowhere in this repo — arriving
 * inside a kernel-startup failure with nothing tying it to the environment that
 * produced it.
 */

async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-findpy-"))
  await fs.mkdir(path.dirname(Installer.interpreter(dir)), { recursive: true })
  return dir
}

test("an environment interpreter that cannot run is not returned", async () => {
  const dir = await scratch()
  try {
    // Present, non-empty, and not executable — the shape of a broken redirector.
    await fs.writeFile(Installer.interpreter(dir), "not an interpreter\n")
    const found = (await findPython(undefined, dir)).binary
    expect(found).not.toBe(Installer.interpreter(dir))
    // It falls through to a host interpreter rather than failing outright.
    expect(["python3", "python"]).toContain(path.basename(found))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("an environment interpreter that runs is preferred over the host", async () => {
  // The positive case matters just as much: the check must not have become a
  // blanket rejection of managed environments, which would silently un-manage
  // every install.
  const dir = await scratch()
  try {
    const real = await Installer.select()
    if (!real.binary) return
    const target = Installer.interpreter(dir)
    await fs.symlink(real.binary, target).catch(async () => {
      await fs.copyFile(real.binary!, target)
      await fs.chmod(target, 0o755)
    })
    expect((await findPython(undefined, dir)).binary).toBe(target)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 60_000)
