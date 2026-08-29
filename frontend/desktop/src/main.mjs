import { randomBytes } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { app, BrowserWindow, dialog, Menu, shell } from "electron"
import {
  apply as applyUpdate,
  current as currentUpdate,
  destination as updateDestination,
  discard as discardUpdate,
  portable as portableUpdate,
  reconcileTransactions as reconcileUpdateTransactions,
  recover as recoverUpdate,
  launch as launchUpdate,
  stage as stageUpdate,
  stageCurrent,
  verify as verifyUpdate,
} from "./updater.mjs"

const execute = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const windows = new Set()
const state = {
  service: undefined,
  serviceExecutable: undefined,
  address: undefined,
  exiting: false,
  updateServer: undefined,
  updateAddress: undefined,
  updateToken: undefined,
  update: undefined,
  updateTask: undefined,
  updateAbort: undefined,
  updateCache: undefined,
  updateInstall: undefined,
  updateRestart: false,
  updateNoRuntime: false,
  updateRuntimeDisposed: false,
  updateMigrationRequired: false,
  runtimeLifecycle: "never_started",
  updateHelperLaunched: false,
  desktopParentToken: randomBytes(24).toString("hex"),
  updateTrusted: false,
  updateResult: undefined,
  updateRelaunch: undefined,
  updateStartupFailure: undefined,
  stopTask: undefined,
}

function external(value) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") return
  void shell.openExternal(url.toString())
}

function localNavigation(value) {
  if (!state.address || !URL.canParse(value)) return false
  return new URL(value).origin === new URL(state.address).origin
}

function html(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function guiEnvironment() {
  const env = { ...process.env }
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "OPENSCIENCE_UPDATE_SKIP_LAUNCH",
    "OPENSCIENCE_UPDATE_TEST_SKIP_FALLBACK",
    "OPENSCIENCE_UPDATE_TEST_HEALTH_FAILURE",
    "OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE",
  ]) {
    delete env[key]
  }
  return env
}

function relaunchAfterExit(bundle) {
  if (!path.isAbsolute(bundle) || path.basename(bundle) !== "OpenScience.app") {
    throw new Error("The recovered OpenScience application path is invalid")
  }
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      'while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 0.1; done; exec /usr/bin/open -n "$2"',
      "openscience-update-recovery",
      String(process.pid),
      bundle,
    ],
    { detached: true, env: guiEnvironment(), stdio: "ignore" },
  )
  child.unref()
}

function binary() {
  if (process.env.OPENSCIENCE_DESKTOP_SIDECAR) return path.resolve(process.env.OPENSCIENCE_DESKTOP_SIDECAR)
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "sidecar", process.platform === "win32" ? "openscience.exe" : "openscience")
  }
  const platform = process.platform === "win32" ? "windows" : process.platform
  const suffix = process.platform === "win32" ? ".exe" : ""
  return path.join(
    root,
    "backend",
    "cli",
    "dist",
    "@synsci",
    `openscience-${platform}-${process.arch}`,
    "bin",
    `openscience${suffix}`,
  )
}

async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const result = server.address()
      const selected = typeof result === "object" && result ? result.port : 0
      server.close(() => resolve(selected))
    })
  })
}

async function ready(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/global/health`).catch(() => undefined)
    if (response?.ok) return
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error("The local OpenScience service did not start within 30 seconds.")
}

function updateHealthRequest() {
  const prefix = "--openscience-update-health="
  const encoded = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
  if (!encoded) return
  if (encoded.length > 4_096) throw new Error("The desktop update health request is too large")
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
}

function validateUpdateHealthRequest() {
  const request = updateHealthRequest()
  if (!request || !state.updateCache) return
  if (
    typeof request.receipt !== "string" ||
    !path.isAbsolute(request.receipt) ||
    typeof request.runtime !== "string" ||
    !path.isAbsolute(request.runtime) ||
    !/^[0-9a-f]{48}$/.test(request.token ?? "") ||
    request.version !== app.getVersion()
  ) {
    throw new Error("The desktop update health request is invalid")
  }
  const relative = path.relative(state.updateCache, request.receipt)
  const runtimeRelative = path.relative(state.updateCache, request.runtime)
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== "." ||
    path.basename(request.receipt) !== `health-${request.token}.json` ||
    !runtimeRelative ||
    runtimeRelative.startsWith("..") ||
    path.isAbsolute(runtimeRelative) ||
    path.dirname(runtimeRelative) !== "." ||
    path.basename(request.runtime) !== `runtime-${request.token}.json`
  ) {
    throw new Error("The desktop update health receipt escaped the update cache")
  }
  return request
}

async function processIdentity(pid, executable) {
  const [started, command] = await Promise.all([
    execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], { timeout: 2_000 }),
    execute("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { timeout: 2_000 }),
  ])
  const exact = path.resolve(executable)
  const observedCommand = command.stdout.trim()
  if (!started.stdout.trim() || (observedCommand !== exact && !observedCommand.startsWith(`${exact} `))) {
    throw new Error(`OpenScience could not bind startup health to process ${pid}`)
  }
  return { pid, started: started.stdout.trim(), executable: exact, command: observedCommand }
}

async function proveServiceHealth() {
  const service = state.service
  if (
    !service ||
    !service.pid ||
    !state.serviceExecutable ||
    service.exitCode !== null ||
    service.signalCode !== null ||
    !state.address
  ) {
    throw new Error("The local OpenScience runtime exited before desktop startup completed")
  }
  const response = await fetch(`${state.address}/global/health`, { signal: AbortSignal.timeout(3_000) }).catch(
    () => undefined,
  )
  const health = await response
    ?.json()
    .then((value) => value)
    .catch(() => undefined)
  if (
    !response?.ok ||
    health?.healthy !== true ||
    health?.version !== app.getVersion() ||
    typeof health?.runId !== "string" ||
    !health.runId ||
    service.exitCode !== null ||
    service.signalCode !== null
  ) {
    throw new Error("The local OpenScience runtime failed its final desktop health check")
  }
  return {
    identity: await processIdentity(service.pid, state.serviceExecutable),
    health: { version: health.version, run_id: health.runId },
  }
}

async function writeUpdateHealth(value) {
  const request = validateUpdateHealthRequest()
  if (!request) return
  const identity = await processIdentity(process.pid, process.execPath)
  const temporary = `${request.receipt}.tmp-${process.pid}`
  await writeFile(
    temporary,
    `${JSON.stringify({
      ...value,
      token: request.token,
      version: request.version,
      process_identity: identity,
    })}\n`,
    { mode: 0o600 },
  )
  await rename(temporary, request.receipt)
  return request
}

async function acknowledgeUpdateHealth() {
  const service = await proveServiceHealth()
  const request = await writeUpdateHealth({
    healthy: true,
    pid: process.pid,
    service_identity: service.identity,
    service_health: service.health,
  })
  if (!request) return
  state.updateResult = {
    phase: "succeeded",
    version: request.version,
    completed_at: new Date().toISOString(),
  }
}

async function acknowledgeUpdatePending() {
  return writeUpdateHealth({ status: "pending", pid: process.pid })
}

async function acknowledgeUpdateFailure(error, safeToTerminate = false) {
  return writeUpdateHealth({
    healthy: false,
    safe_to_terminate: safeToTerminate,
    pid: process.pid,
    error: error instanceof Error ? error.message : String(error),
  })
}

async function start() {
  const executable = binary()
  if (!existsSync(executable)) throw new Error(`OpenScience runtime is missing: ${executable}`)
  const selected = await port()
  const workspace = path.join(app.getPath("userData"), "workspace")
  const logs = app.getPath("logs")
  const output = path.join(logs, "openscience-sidecar.log")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(logs, { recursive: true })
  writeFileSync(output, "", { mode: 0o600 })
  state.address = `http://127.0.0.1:${selected}`
  state.serviceExecutable = path.resolve(executable)
  const healthRequest = validateUpdateHealthRequest()
  state.runtimeLifecycle = "spawning"
  try {
    state.service = spawn(executable, ["serve", "--port", String(selected), "--print-logs"], {
      cwd: workspace,
      env: {
        ...process.env,
        ...(state.updateAddress && state.updateToken
          ? {
              OPENSCIENCE_DESKTOP_UPDATE_URL: `${state.updateAddress}/update`,
              OPENSCIENCE_DESKTOP_UPDATE_TOKEN: state.updateToken,
            }
          : {}),
        OPENSCIENCE_DESKTOP_PARENT_PID: String(process.pid),
        OPENSCIENCE_DESKTOP_PARENT_TOKEN: state.desktopParentToken,
        ...(healthRequest
          ? {
              OPENSCIENCE_DESKTOP_PARENT_RUNTIME_RECEIPT: healthRequest.runtime,
              OPENSCIENCE_DESKTOP_PARENT_UPDATE_TOKEN: healthRequest.token,
              OPENSCIENCE_DESKTOP_PARENT_UPDATE_VERSION: healthRequest.version,
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  } catch (error) {
    state.runtimeLifecycle = "never_started"
    throw error
  }
  state.runtimeLifecycle = "running"
  state.service.stdout?.on("data", (value) => {
    appendFileSync(output, value)
    if (!app.isPackaged) process.stdout.write(`[openscience] ${value}`)
  })
  state.service.stderr?.on("data", (value) => {
    appendFileSync(output, value)
    if (!app.isPackaged) process.stderr.write(`[openscience] ${value}`)
  })
  state.service.on("exit", (code) => {
    if (state.exiting) return
    for (const window of windows) {
      window.webContents.send("openscience:service-exit", code)
    }
  })
  await ready(state.address)
}

function respond(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  response.end(JSON.stringify(value))
}

function updateView() {
  if (!state.update) {
    return state.updateResult ?? { phase: "idle" }
  }
  const { phase, version, transferred, total, error } = state.update
  return {
    phase,
    version,
    transferred,
    total,
    progress: total && transferred !== undefined ? Math.min(1, transferred / total) : undefined,
    error,
    migration_required: state.updateMigrationRequired,
  }
}

function storedUpdateResult(value) {
  if (!value || (value.status !== "succeeded" && value.status !== "failed")) return
  if (!/^\d+\.\d+\.\d+$/.test(value.version ?? "")) return
  if (typeof value.completed_at !== "string" || !Number.isFinite(Date.parse(value.completed_at))) return
  return {
    phase: value.status,
    version: value.version,
    completed_at: value.completed_at,
    error: value.status === "failed" && typeof value.error === "string" ? value.error.slice(0, 4_096) : undefined,
  }
}

function prepareUpdate(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("The desktop update version is invalid")
  if (state.updateRestart) throw new Error("OpenScience is already committed to restarting for this update")
  if (state.update && state.update.version !== version && state.update.phase !== "failed") {
    throw new Error(`OpenScience ${state.update.version} is already staged or downloading`)
  }
  if (state.update?.phase === "ready" || state.updateTask) return
  state.updateResult = undefined
  const controller = new AbortController()
  state.updateAbort = controller
  state.update = { phase: "downloading", version, transferred: 0, total: undefined }
  const current = currentUpdate()
  const task = stageUpdate(version, {
    cache: state.updateCache,
    current,
    currentVersion: app.getVersion(),
    trusted: true,
    signal: controller.signal,
    onProgress(progress) {
      if (state.update?.version !== version) return
      Object.assign(state.update, progress)
    },
  })
    .then((prepared) => {
      if (controller.signal.aborted) return discardUpdate(prepared)
      state.update = { phase: "ready", version, prepared }
    })
    .catch((error) => {
      state.update = controller.signal.aborted
        ? undefined
        : { phase: "failed", version, error: error instanceof Error ? error.message : String(error) }
    })
    .finally(() => {
      if (state.updateTask === task) state.updateTask = undefined
      if (state.updateAbort === controller) state.updateAbort = undefined
    })
  state.updateTask = task
}

async function updateRequest(request, response) {
  if (request.url !== "/update" || !["GET", "POST", "DELETE"].includes(request.method)) {
    respond(response, 404, { error: "Not found" })
    return
  }
  if (request.headers.authorization !== `Bearer ${state.updateToken}`) {
    respond(response, 401, { error: "Unauthorized" })
    return
  }
  if (request.method === "GET") {
    respond(response, 200, updateView())
    return
  }
  if (request.method === "DELETE") {
    if (state.updateRestart) {
      respond(response, 409, { error: "OpenScience is already finishing this update restart" })
      return
    }
    state.updateAbort?.abort()
    await state.updateTask?.catch(() => undefined)
    if (state.update?.phase === "ready") await discardUpdate(state.update.prepared)
    state.update = undefined
    state.updateResult = undefined
    respond(response, 200, { phase: "idle" })
    return
  }
  const chunks = []
  for await (const chunk of request) {
    chunks.push(chunk)
    if (chunks.reduce((size, value) => size + value.length, 0) > 16_384) {
      respond(response, 413, { error: "Update request is too large" })
      return
    }
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (typeof input.version !== "string") throw new Error("The desktop update version is missing")
  if (input.action === "stage") {
    if (state.updateRestart) {
      respond(response, 409, { error: "OpenScience is already finishing this update restart" })
      return
    }
    prepareUpdate(input.version)
    respond(response, 202, updateView())
    return
  }
  if (input.action !== "apply") throw new Error("The desktop update action is invalid")
  if (state.update?.phase === "restart_blocked" && state.update.version === input.version) {
    if (!state.updateRestart || !state.updateInstall || state.updateHelperLaunched) {
      respond(response, 409, { error: "The prepared update restart can no longer be retried safely" })
      return
    }
    state.update = { ...state.update, phase: "restarting", error: undefined }
    respond(response, 202, updateView())
    const timer = setTimeout(() => void stop(), 0)
    timer.unref?.()
    return
  }
  if (state.update?.phase !== "ready" || state.update.version !== input.version) {
    respond(response, 409, { error: `OpenScience ${input.version} is not verified and ready to restart` })
    return
  }
  if (state.updateRestart) {
    respond(response, 409, { error: "OpenScience is already preparing this update restart" })
    return
  }
  const update = state.update.prepared
  state.updateRestart = true
  try {
    state.updateInstall = await applyUpdate(update, {
      current: currentUpdate(),
      trusted: true,
      allowUserMigration: state.updateMigrationRequired,
    })
  } catch (error) {
    state.updateRestart = false
    throw error
  }
  state.update = { phase: "restarting", version: update.version, prepared: update }
  respond(response, 202, updateView())
  const timer = setTimeout(() => {
    void stop()
  }, 750)
  timer.unref?.()
}

async function updates() {
  if (!app.isPackaged || process.platform !== "darwin") return
  state.updateCache = path.join(app.getPath("userData"), "updates")
  state.updateTrusted = await verifyUpdate(currentUpdate(), app.getVersion(), { trusted: true })
    .then(() => true)
    .catch((error) => {
      console.warn(
        `Automatic updates are unavailable because this app is not a notarized Developer ID build: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return false
    })
  if (!state.updateTrusted) return
  const active = currentUpdate()
  state.updateMigrationRequired =
    !portableUpdate(active) &&
    (await updateDestination(active, { allowUserMigration: true }).then((target) => target !== active))
  const interrupted = await reconcileCurrentUpdate()
  if (interrupted.inProgress) {
    throw new Error(
      "A verified OpenScience update is already being installed. Wait for it to finish and reopen the app.",
    )
  }
  if (interrupted.relaunch) {
    state.updateRelaunch = interrupted.relaunch
    throw new Error("OpenScience restored the previous app after an interrupted update")
  }
  const resultFile = path.join(state.updateCache, "last-result.json")
  const stored = await readFile(resultFile, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => undefined)
  if (stored) await rm(resultFile, { force: true })
  state.updateResult = storedUpdateResult(stored)
  const recovered = updateHealthRequest()
    ? undefined
    : await recoverUpdate(state.updateCache, {
        current: currentUpdate(),
        currentVersion: app.getVersion(),
        trusted: true,
      })
  if (recovered && state.updateResult?.phase === "failed") await discardUpdate(recovered)
  else if (recovered) state.update = { phase: "ready", version: recovered.version, prepared: recovered }
  state.updateToken = randomBytes(32).toString("hex")
  state.updateServer = createServer((request, response) => {
    void updateRequest(request, response).catch((error) => {
      respond(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
  state.updateServer.unref()
  await new Promise((resolve, reject) => {
    state.updateServer.once("error", reject)
    state.updateServer.listen(0, "127.0.0.1", resolve)
  })
  const address = state.updateServer.address()
  if (typeof address !== "object" || !address) throw new Error("The desktop update service did not start")
  state.updateAddress = `http://127.0.0.1:${address.port}`
}

async function reconcileCurrentUpdate(healthyCurrent) {
  if (!app.isPackaged || process.platform !== "darwin" || !state.updateCache) return {}
  const supervised = validateUpdateHealthRequest()
  return reconcileUpdateTransactions(state.updateCache, {
    current: currentUpdate(),
    currentVersion: app.getVersion(),
    trusted: true,
    swapExecutable: binary(),
    ...(supervised ? { supervised } : {}),
    ...(typeof healthyCurrent === "boolean" ? { healthyCurrent } : {}),
  })
}

async function bootstrap(splash) {
  if (!app.isPackaged || process.platform !== "darwin") return false
  const bundle = currentUpdate()
  if (!portableUpdate(bundle)) return false
  if (!state.updateTrusted) {
    const prompt = await dialog.showMessageBox(splash, {
      type: "warning",
      buttons: ["Download verified installer", "Run from Disk Image"],
      defaultId: 0,
      cancelId: 1,
      message: "This copy cannot install automatic updates",
      detail:
        "Automatic installation requires the signed and notarized OpenScience release. Download the verified installer, or continue without installing this copy.",
    })
    if (prompt.response === 0) {
      await shell.openExternal("https://github.com/synthetic-sciences/openscience/releases/latest")
    }
    return false
  }
  const prompt = await dialog.showMessageBox(splash, {
    type: "info",
    buttons: ["Install OpenScience", "Run from Disk Image"],
    defaultId: 0,
    cancelId: 1,
    message: "Finish installing OpenScience",
    detail:
      "OpenScience is running from the downloaded disk image. Install it in Applications now so future updates work automatically.",
  })
  if (prompt.response !== 0) return false
  await splash.loadURL(
    `data:text/html,${encodeURIComponent('<main style="background:#11110f;color:#e8e5dc;display:grid;font:14px system-ui;height:100vh;margin:0;place-items:center"><div><h1 style="font-size:20px;margin:0 0 8px">OpenScience</h1><p style="color:#9d998f;margin:0">Installing in Applications…</p></div></main>')}`,
  )
  let staged
  try {
    staged = await stageCurrent({
      cache: path.join(app.getPath("userData"), "updates"),
      current: bundle,
      trusted: true,
    })
    const prepared = await applyUpdate(staged, { current: bundle, trusted: true })
    state.updateInstall = prepared
    state.updateRestart = true
    // Bootstrap runs before the backend sidecar has ever started. That
    // absence is the runtime-disposal proof for this first installation.
    state.updateNoRuntime = true
    state.update = { phase: "restarting", version: prepared.version }
  } catch (error) {
    if (staged) await discardUpdate(staged).catch(() => undefined)
    state.updateInstall = undefined
    state.updateRestart = false
    state.updateNoRuntime = false
    state.updateRuntimeDisposed = false
    state.update = undefined
    await dialog.showMessageBox(splash, {
      type: "error",
      buttons: ["Continue from Disk Image"],
      message: "OpenScience could not finish installing",
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  }
  splash.destroy()
  const timer = setTimeout(() => void stop(), 250)
  timer.unref?.()
  return true
}

function dock() {
  if (process.platform !== "darwin" || !app.dock) return
  const entries = [...windows].map((window, index) => ({
    label: window.getTitle() || `OpenScience ${index + 1}`,
    click: () => {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    },
  }))
  app.dock.setMenu(
    Menu.buildFromTemplate([
      ...(entries.length ? [...entries, { type: "separator" }] : []),
      { label: "New Window", click: () => void createWindow() },
    ]),
  )
}

function waitForExit(child, timeout) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeout)
    const finish = (exited) => {
      clearTimeout(timer)
      child.off("exit", onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once("exit", onExit)
  })
}

async function closeUpdateServer() {
  const server = state.updateServer
  state.updateServer = undefined
  if (!server) return
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error)
      else resolve()
    })
    server.closeAllConnections?.()
  })
}

async function drainService() {
  const service = state.service
  const updateRestart = state.updateRestart || Boolean(updateHealthRequest())
  if (updateRestart && state.updateRuntimeDisposed) return
  if (!service || service.exitCode !== null || service.signalCode !== null) {
    if (updateRestart && !service && (state.updateNoRuntime || state.runtimeLifecycle === "never_started")) {
      state.updateRuntimeDisposed = true
      state.runtimeLifecycle = "disposed"
      return
    }
    if (updateRestart) {
      throw new Error("OpenScience could not prove that the local runtime exited without leaving active work behind")
    }
    return
  }
  if (updateRestart && (!state.address || !state.updateToken)) {
    throw new Error("OpenScience could not prove that the local runtime was safely disposed before updating")
  }
  if (state.address && state.updateToken) {
    const disposed = await fetch(`${state.address}/settings/updates/dispose`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.updateToken}` },
      signal: AbortSignal.timeout(5_000),
    })
      .then((response) => response.status === 204)
      .catch((error) => {
        console.warn(error instanceof Error ? error.message : String(error))
        return false
      })
    if (!disposed && updateRestart) {
      throw new Error(
        "OpenScience could not safely finish the active runtime before updating. Try again after it settles.",
      )
    }
  }
  service.kill("SIGTERM")
  if (await waitForExit(service, 5_000)) {
    if (updateRestart) {
      state.updateRuntimeDisposed = true
      state.runtimeLifecycle = "disposed"
    }
    return
  }
  service.kill("SIGKILL")
  if (!(await waitForExit(service, 2_000))) {
    throw new Error("The local OpenScience service did not stop safely")
  }
  if (updateRestart) {
    state.updateRuntimeDisposed = true
    state.runtimeLifecycle = "disposed"
  }
}

function stop() {
  if (state.stopTask) return state.stopTask
  state.exiting = true
  state.stopTask = (async () => {
    await drainService()
    if (state.updateStartupFailure) {
      await acknowledgeUpdateFailure(state.updateStartupFailure, true)
    }
    if (state.updateRestart && state.updateInstall && !state.updateHelperLaunched) {
      await launchUpdate(state.updateInstall)
      state.updateHelperLaunched = true
      // The helper is now armed with a durable proof that the old runtime was
      // disposed. From this point forward Electron must exit; a close error on
      // the already-unreferenced loopback server cannot reopen admission.
      await closeUpdateServer().catch((error) => console.warn(error instanceof Error ? error.message : String(error)))
    } else {
      await closeUpdateServer()
    }
    for (const window of windows) window.destroy()
    app.exit(0)
  })().catch((error) => {
    state.exiting = false
    state.stopTask = undefined
    if (state.updateRestart && !state.updateHelperLaunched && state.update?.phase === "restarting") {
      state.update = {
        ...state.update,
        phase: "restart_blocked",
        error: error instanceof Error ? error.message : String(error),
      }
    }
    dialog.showErrorBox("OpenScience could not quit safely", error instanceof Error ? error.message : String(error))
  })
  return state.stopTask
}

function applicationMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: `Quit ${app.name}`, accelerator: "CmdOrCtrl+Q", click: () => void stop() },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => void createWindow() },
        { type: "separator" },
        process.platform === "darwin"
          ? { role: "close" }
          : { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => void stop() },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
  if (!state.address) return
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "OpenScience",
    backgroundColor: "#11110f",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  windows.add(window)
  window.once("ready-to-show", () => window.show())
  window.on("page-title-updated", dock)
  window.on("focus", dock)
  window.on("closed", () => {
    windows.delete(window)
    if (!state.exiting) dock()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (localNavigation(url)) return
    event.preventDefault()
    external(url)
  })
  await window.loadURL(`${state.address}/?desktop=1${state.updateAddress ? "&desktop-update=1" : ""}`)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const mounted = await window.webContents
      .executeJavaScript('document.documentElement.dataset.openscienceReady === "true"')
      .catch(() => false)
    if (mounted) {
      dock()
      return window
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("The OpenScience workspace did not finish mounting within 30 seconds.")
}

const lock = app.requestSingleInstanceLock()
if (!lock) app.exit(0)

app.on("second-instance", () => {
  void createWindow()
})

app
  .whenReady()
  .then(async () => {
    let splash
    try {
      app.name = "OpenScience"
      if (app.isPackaged && process.platform === "darwin") {
        state.updateCache = path.join(app.getPath("userData"), "updates")
        mkdirSync(state.updateCache, { recursive: true, mode: 0o700 })
        // The helper can now identify and stop this exact process even if
        // startup fails before the sidecar or update service is ready.
        await acknowledgeUpdatePending()
      }
      applicationMenu()
      await updates()
      splash = new BrowserWindow({
        width: 520,
        height: 300,
        resizable: false,
        show: false,
        title: "OpenScience",
        backgroundColor: "#11110f",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      await splash.loadURL(
        `data:text/html,${encodeURIComponent('<main style="background:#11110f;color:#e8e5dc;display:grid;font:14px system-ui;height:100vh;margin:0;place-items:center"><div><h1 style="font-size:20px;margin:0 0 8px">OpenScience</h1><p style="color:#9d998f;margin:0">Starting your local workspace…</p></div></main>')}`,
      )
      splash.show()
      if (await bootstrap(splash)) return
      if (process.platform === "win32") {
        app.setUserTasks([
          {
            program: process.execPath,
            arguments: "--new-window",
            iconPath: process.execPath,
            iconIndex: 0,
            title: "New Window",
            description: "Open another OpenScience workspace window",
          },
        ])
      }
      await start()
      await createWindow()
      await acknowledgeUpdateHealth()
      await reconcileCurrentUpdate(true)
      splash.destroy()
    } catch (error) {
      if (state.updateRelaunch) {
        relaunchAfterExit(state.updateRelaunch)
        const timer = setTimeout(() => void stop(), 0)
        timer.unref?.()
        return
      }
      const safeBeforeRuntime =
        state.updateNoRuntime || state.updateRuntimeDisposed || state.runtimeLifecycle === "never_started"
      if (safeBeforeRuntime) {
        state.updateRuntimeDisposed = true
        state.runtimeLifecycle = "disposed"
      }
      const updateFailure = await acknowledgeUpdateFailure(error, safeBeforeRuntime).catch(() => undefined)
      if (updateFailure) {
        state.updateStartupFailure = error
        const recovered = await reconcileCurrentUpdate(false).catch(() => undefined)
        if (recovered?.relaunch) {
          state.updateRelaunch = recovered.relaunch
          relaunchAfterExit(recovered.relaunch)
        }
        // The helper waits for this exact PID, which remains alive until the
        // sidecar has fully drained, before it restores the previous bundle.
        const timer = setTimeout(() => void stop(), 0)
        timer.unref?.()
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      if (!splash || splash.isDestroyed()) {
        dialog.showErrorBox("OpenScience could not start", message)
        app.exit(1)
        return
      }
      await splash.loadURL(
        `data:text/html,${encodeURIComponent(`<main style="font:16px system-ui;padding:48px"><h1>OpenScience could not start</h1><p>${html(message)}</p></main>`)}`,
      )
    }
  })
  .catch((error) => {
    dialog.showErrorBox("OpenScience could not start", error instanceof Error ? error.message : String(error))
    app.exit(1)
  })

app.on("activate", () => {
  if (!windows.size) void createWindow()
})

app.on("before-quit", (event) => {
  if (state.exiting) return
  event.preventDefault()
  void stop()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
