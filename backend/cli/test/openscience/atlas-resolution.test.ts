import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { resolveAtlasPackageDir } from "../../src/openscience/atlas-package"

async function installAtlas(root: string, marker: string) {
  const dir = path.join(root, "node_modules", "@synsci", "atlas")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@synsci/atlas", marker }))
  return dir
}

test("compiled-binary Atlas resolution starts from process.execPath's install tree", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-atlas-resolution-"))
  try {
    const executableInstall = path.join(temp, "executable-install")
    const cwdInstall = path.join(temp, "cwd-install")
    const executableAtlas = await installAtlas(executableInstall, "executable")
    await installAtlas(cwdInstall, "cwd")

    const execPath = path.join(
      executableInstall,
      "node_modules",
      "@synsci",
      "openscience-darwin-arm64",
      "bin",
      "openscience",
    )
    const modulePath = path.join(temp, "compiled-module", "bundle.js")
    const cwd = path.join(cwdInstall, "project")
    await fs.mkdir(path.dirname(execPath), { recursive: true })
    await fs.mkdir(path.dirname(modulePath), { recursive: true })
    await fs.mkdir(cwd, { recursive: true })

    expect(
      resolveAtlasPackageDir({
        execPath,
        moduleUrl: pathToFileURL(modulePath).href,
        cwd,
        resolvePackageJson: () => {
          throw new Error("compiled bundle cannot resolve node_modules directly")
        },
      }),
    ).toBe(executableAtlas)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})
