import assert from "node:assert/strict"
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as pause } from "node:timers/promises"

const desktop = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(new URL("../package.json", import.meta.url))
const workspace = createRequire(new URL("../../workspace/package.json", import.meta.url))
const playwright = createRequire(workspace.resolve("@playwright/test"))("playwright")
const binary = process.env.OPENSCIENCE_DESKTOP_SIDECAR
if (
  !binary ||
  !(await access(binary).then(
    () => true,
    () => false,
  ))
)
  throw new Error("Build and set OPENSCIENCE_DESKTOP_SIDECAR first")

const root = await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-startup-"))
const packaged = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"))
const source = path.join(root, "app")
const profile = path.join(root, "electron")
await mkdir(profile, { recursive: true })
await cp(path.join(desktop, "src"), path.join(source, "src"), { recursive: true })
await writeFile(
  path.join(source, "package.json"),
  JSON.stringify({ name: "openscience-startup-smoke", version: packaged.version, type: "module", main: "smoke.mjs" }),
)
await writeFile(
  path.join(source, "smoke.mjs"),
  `import { app } from "electron"
app.setPath("userData", ${JSON.stringify(profile)})
app.setPath("logs", ${JSON.stringify(path.join(root, "logs"))})
await import("./src/main.mjs")
`,
)

const env = {
  ...process.env,
  OPENSCIENCE_DESKTOP_SIDECAR: path.resolve(binary),
  OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
  OPENSCIENCE_DATA_DIR: path.join(root, "data"),
  OPENSCIENCE_TEST_HOME: path.join(root, "home"),
  OPENSCIENCE_DISABLE_MODELS_FETCH: "true",
  OPENSCIENCE_DISABLE_LSP_DOWNLOAD: "true",
}
for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"]) delete env[name]
const electron = await playwright._electron.launch({
  executablePath: require("electron"),
  args: [source],
  env,
  timeout: 30_000,
})

try {
  const deadline = Date.now() + 60_000
  while (true) {
    if (Date.now() >= deadline) throw new Error("Desktop startup did not finish within 60 seconds")
    const windows = await electron.evaluate(async ({ BrowserWindow }) =>
      Promise.all(
        BrowserWindow.getAllWindows().map(async (window) => ({
          url: window.webContents.getURL(),
          page: await window.webContents
            .executeJavaScript(
              `({
              ready: document.documentElement.dataset.openscienceReady === "true",
              error: document.querySelector("h1")?.textContent === "OpenScience could not start"
                ? document.body.innerText : undefined
            })`,
            )
            .catch(() => ({})),
        })),
      ),
    )
    const failed = windows.find((window) => window.page.error)
    if (failed) throw new Error(failed.page.error)

    // The workspace can mount before final runtime health fails. Requiring
    // the splash to close exercises the complete startup path from #543.
    if (windows.length === 1 && windows[0].page.ready && windows[0].url.startsWith("http://127.0.0.1:")) {
      const response = await fetch(new URL("/global/health", windows[0].url), { signal: AbortSignal.timeout(3_000) })
      assert.equal(response.status, 200)
      const health = await response.json()
      assert.equal(health.healthy, true)
      assert.equal(health.version, packaged.version)
      assert.equal(typeof health.runId, "string")
      assert.ok(health.runId)
      console.log(`Desktop startup passed on ${process.platform}: workspace mounted, splash closed, runtime healthy`)
      break
    }
    await pause(100)
  }
} finally {
  await electron.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
