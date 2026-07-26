import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { Hono } from "hono"
import os from "os"
import path from "path"
import { serveWebAsset, wantsJson, type WebAssetSource } from "../../src/web/serve"

describe("wantsJson", () => {
  test("content-type application/json → true", () => {
    expect(wantsJson(null, "application/json")).toBe(true)
  })

  test("accept includes application/json, no text/html → true", () => {
    expect(wantsJson("application/json, text/plain", null)).toBe(true)
  })

  test("browser navigation accept header → false", () => {
    expect(wantsJson("text/html,application/xhtml+xml,*/*", null)).toBe(false)
  })

  test("text/html present alongside application/json → treated as navigation, false", () => {
    expect(wantsJson("text/html,application/json", null)).toBe(false)
  })

  test("wildcard accept → false", () => {
    expect(wantsJson("*/*", null)).toBe(false)
  })

  test("both null → false", () => {
    expect(wantsJson(null, null)).toBe(false)
  })
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-web-assets-"))
  const files = {
    index: path.join(root, "index.html"),
    hashedScript: path.join(root, "app-Ab12_cd3.js"),
    hashedWorker: path.join(root, "rdkit.worker-BC5_dxFH.js"),
    unhashedAsset: path.join(root, "bootstrap.js"),
    bootstrap: path.join(root, "openscience-theme-preload.js"),
  }
  await Promise.all([
    fs.writeFile(files.index, "<html>OpenScience</html>"),
    fs.writeFile(files.hashedScript, "export const app = true"),
    fs.writeFile(files.hashedWorker, "self.onmessage = () => {}"),
    fs.writeFile(files.unhashedAsset, "export const bootstrap = true"),
    fs.writeFile(files.bootstrap, "document.documentElement.dataset.theme = 'dark'"),
  ])

  const source: WebAssetSource = {
    index: files.index,
    assets: {
      "/index.html": files.index,
      "/assets/app-Ab12_cd3.js": files.hashedScript,
      "/assets/rdkit.worker-BC5_dxFH.js": files.hashedWorker,
      "/assets/bootstrap.js": files.unhashedAsset,
      "/openscience-theme-preload.js": files.bootstrap,
    },
  }
  const app = new Hono()
  app.get("*", async (c) => (await serveWebAsset(c, source)) ?? c.notFound())

  return {
    request: (pathname: string) => app.request(`http://localhost${pathname}`),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

test("serveWebAsset caches content-hashed /assets files immutably", async () => {
  const web = await fixture()
  try {
    for (const pathname of ["/assets/app-Ab12_cd3.js", "/assets/rdkit.worker-BC5_dxFH.js"]) {
      const response = await web.request(pathname)
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    }
  } finally {
    await web.cleanup()
  }
})

test("serveWebAsset keeps non-hashed assets and bootstrap files revalidated", async () => {
  const web = await fixture()
  try {
    for (const pathname of ["/assets/bootstrap.js", "/openscience-theme-preload.js"]) {
      const response = await web.request(pathname)
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-cache")
    }
  } finally {
    await web.cleanup()
  }
})

test("serveWebAsset keeps index.html and SPA fallbacks revalidated", async () => {
  const web = await fixture()
  try {
    for (const pathname of ["/", "/index.html", "/session/local-session"]) {
      const response = await web.request(pathname)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(response.headers.get("cache-control")).toBe("no-cache")
      expect(await response.text()).toBe("<html>OpenScience</html>")
    }
  } finally {
    await web.cleanup()
  }
})
