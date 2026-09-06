import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildOptions, headlessAssets } from "../../script/build-options"
import { nativePackageName } from "../../script/native-targets"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("headless build distribution", () => {
  test("selects an explicit Linux baseline without changing the combined default", () => {
    const combined = buildOptions([])
    expect(combined.headless).toBe(false)
    expect(combined.output).toBe("dist")
    expect(combined.targets.length).toBeGreaterThan(1)
    const result = buildOptions(["--headless", "--target", "linux-x64-baseline"], { os: "darwin", arch: "arm64" })
    expect(result.headless).toBe(true)
    expect(result.output).toBe("dist/headless")
    expect(result.targets.map((target) => nativePackageName("", target))).toEqual(["linux-x64-baseline"])
    expect(() => buildOptions(["--target", "unknown"])).toThrow("Unsupported native target")
    expect(() => buildOptions(["--target"])).toThrow("requires a native target")
    expect(() => buildOptions(["--target=linux-x64", "--single"])).toThrow("not both")
  })

  for (const stale of [false, true]) {
    test(`builds without a frontend directory even with ${stale ? "a stale" : "no"} embedded manifest`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-headless-build-"))
      roots.push(root)
      const web = path.join(root, "src/web")
      await fs.mkdir(web, { recursive: true })
      await fs.copyFile(path.resolve(import.meta.dir, "../../src/web/assets.ts"), path.join(web, "assets.ts"))
      if (stale) {
        await Bun.write(
          path.join(web, "assets.generated.ts"),
          'import missing from "./frontend-was-removed.html" with { type: "file" }; export const WEB_ASSETS = { "/index.html": missing }; export const WEB_INDEX = missing;',
        )
      }
      const entry = path.join(root, "entry.ts")
      await Bun.write(
        entry,
        'import { WEB_ASSETS, WEB_INDEX, webVersion } from "./src/web/assets"; console.log(JSON.stringify({ assets: WEB_ASSETS, index: WEB_INDEX ?? null, version: await webVersion() ?? null }));',
      )
      const build = await Bun.build({
        entrypoints: [entry],
        outdir: path.join(root, "out"),
        target: "bun",
        plugins: [headlessAssets(root)],
      })
      expect(build.success, build.logs.join("\n")).toBe(true)
      const child = Bun.spawn([process.execPath, path.join(root, "out/entry.js")], { stdout: "pipe", stderr: "pipe" })
      const output = await new Response(child.stdout).text()
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
      expect(JSON.parse(output)).toEqual({ assets: {}, index: null, version: null })
    })
  }

  test("combined bundling still preserves its generated UI assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-combined-build-"))
    roots.push(root)
    const web = path.join(root, "src/web")
    await fs.mkdir(web, { recursive: true })
    await fs.copyFile(path.resolve(import.meta.dir, "../../src/web/assets.ts"), path.join(web, "assets.ts"))
    await Bun.write(
      path.join(web, "assets.generated.ts"),
      'export const WEB_ASSETS = { "/index.html": "workspace" }; export const WEB_INDEX = "workspace";',
    )
    const entry = path.join(root, "entry.ts")
    await Bun.write(entry, 'import { WEB_ASSETS } from "./src/web/assets"; console.log(JSON.stringify(WEB_ASSETS));')
    const build = await Bun.build({ entrypoints: [entry], outdir: path.join(root, "out"), target: "bun" })
    expect(build.success).toBe(true)
    const child = Bun.spawn([process.execPath, path.join(root, "out/entry.js")], { stdout: "pipe", stderr: "pipe" })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output)).toEqual({ "/index.html": "workspace" })
  })
})
