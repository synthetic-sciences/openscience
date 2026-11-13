import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"

const root = fileURLToPath(new URL("../", import.meta.url))
const base = "/docs/"

test("docs assets honor the production base path", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-docs-assets-"))

  try {
    await build({
      root,
      logLevel: "silent",
      build: { outDir: output, emptyOutDir: true },
    })

    const html = await Bun.file(path.join(output, "index.html")).text()
    const urls = Array.from(html.matchAll(/(?:href|src)="([^"]+)"/g), (match) => match[1]).filter(
      (url) => !/^(?:https?:)?\/\//.test(url),
    )
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((url) => url.startsWith(base))).toBe(true)

    const favicon = html.match(/<link[^>]+rel="icon"[^>]+href="([^"]+)"/)?.[1]
    const stylesheets = Array.from(
      html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g),
      (match) => match[1],
    ).filter((url) => !/^(?:https?:)?\/\//.test(url))
    if (!favicon || !stylesheets.length) throw new Error("Production HTML is missing its favicon or stylesheet")
    expect(await Bun.file(path.join(output, favicon.slice(base.length))).exists()).toBe(true)

    const fonts = new Set<string>()
    for (const stylesheet of stylesheets) {
      expect(await Bun.file(path.join(output, stylesheet.slice(base.length))).exists()).toBe(true)
      const css = await Bun.file(path.join(output, stylesheet.slice(base.length))).text()
      for (const match of css.matchAll(/url\((?:"|')?([^)"']+\.woff2)(?:"|')?\)/g)) {
        const pathname = new URL(match[1], `https://openscience.sh${stylesheet}`).pathname
        fonts.add(pathname)
        expect(pathname.startsWith(base)).toBe(true)
        expect(await Bun.file(path.join(output, pathname.slice(base.length))).exists()).toBe(true)
      }
    }
    expect(fonts.size).toBe(2)
  } finally {
    await fs.rm(output, { recursive: true, force: true })
  }
}, 30_000)
