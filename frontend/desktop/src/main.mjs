import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, Menu, shell } from "electron"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const windows = new Set()
const state = { service: undefined, address: undefined, exiting: false }

function external(value) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") return
  void shell.openExternal(url.toString())
}

function html(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
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
  state.service = spawn(executable, ["serve", "--port", String(selected), "--print-logs"], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
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

function stop() {
  if (state.exiting) return
  state.exiting = true
  state.service?.kill()
  for (const window of windows) window.destroy()
  setTimeout(() => app.exit(0), 0)
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
              { label: `Quit ${app.name}`, accelerator: "CmdOrCtrl+Q", click: stop },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => void createWindow() },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { label: "Quit", accelerator: "CmdOrCtrl+Q", click: stop },
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
    if (url.startsWith(state.address)) return
    event.preventDefault()
    external(url)
  })
  await window.loadURL(`${state.address}/?desktop=1`)
  dock()
}

const lock = app.requestSingleInstanceLock()
if (!lock) app.exit(0)

app.on("second-instance", () => {
  void createWindow()
})

app.whenReady().then(async () => {
  app.name = "OpenScience"
  applicationMenu()
  const splash = new BrowserWindow({
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
  try {
    await start()
    splash.destroy()
    await createWindow()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await splash.loadURL(
      `data:text/html,${encodeURIComponent(`<main style="font:16px system-ui;padding:48px"><h1>OpenScience could not start</h1><p>${html(message)}</p></main>`)}`,
    )
  }
})

app.on("activate", () => {
  if (!windows.size) void createWindow()
})

app.on("before-quit", (event) => {
  if (state.exiting) return
  event.preventDefault()
  stop()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
