import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../../test/vite"
import solid from "vite-plugin-solid"
import type { CommandLineStatus } from "./command-line-tool"

const Response = (await Bun.fetch("data:text/plain,")).constructor as typeof globalThis.Response
const cleanups: Array<() => void> = []
const vite = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const subject = (await vite.ssrLoadModule(
  "/src/components/settings/command-line-tool.tsx",
)) as typeof import("./command-line-tool")
const toast = (await vite.ssrLoadModule("/src/atlas/Toast.tsx")) as typeof import("../../atlas/Toast")
const uiToast = (await vite.ssrLoadModule("@synsci/ui/toast")) as typeof import("@synsci/ui/toast")
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")

afterAll(() => vite.close())
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  uiToast.toaster.clear()
  document.body.replaceChildren()
})

const home = "/Users/ada"
const directory = `${home}/.openscience/bin`
const line = `export PATH=${directory}:$PATH`
const status = (over: Partial<CommandLineStatus> = {}): CommandLineStatus => ({
  home,
  directory,
  path: `${directory}/openscience`,
  exists: false,
  current: false,
  ours: true,
  onPath: false,
  shell: "zsh",
  line,
  config: `${home}/.zshrc`,
  installable: true,
  ...over,
})
const foreign = `~/.openscience/bin/openscience is a file OpenScience did not create (a standalone install, perhaps). Remove it first if the app should own it.`

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

// The row against a real local server: the same JSON the sidecar's
// /settings/cli routes return, with the notification region mounted beside it
// so the toasts it raises are on the page.
function serve(handlers: { get: () => CommandLineStatus; post: () => globalThis.Response }) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/settings/cli/install") return handlers.post()
      if (request.method === "GET" && url.pathname === "/settings/cli") return Response.json(handlers.get())
      return Response.json({ error: "not_found", path: url.pathname }, { status: 404 })
    },
  })
  cleanups.push(() => void server.stop(true))
  const notifications = document.createElement("div")
  const host = document.createElement("div")
  document.body.append(notifications, host)
  cleanups.push(web.render(() => web.createComponent(toast.ToastContainer, {}), notifications))
  const client = subject.createCommandLineClient(server.url.origin, Bun.fetch as unknown as typeof fetch)
  cleanups.push(web.render(() => subject.CommandLineToolRow({ client }), host))
  return {
    description: () => host.querySelector(".text-12-regular")?.textContent ?? "",
    button: () => host.querySelector("button"),
    toasts: () => Array.from(document.querySelectorAll('[data-component="toast"]')).map((el) => el.textContent ?? ""),
  }
}

describe("command line tool row", () => {
  test("says what the server reports and offers only what the app can do", () => {
    expect(subject.commandLineCopy(undefined)).toEqual({ description: "Checking…" })
    expect(subject.commandLineCopy(undefined, new Error("boom")).description).toContain("boom")
    expect(subject.commandLineCopy(status())).toEqual({
      description: "Not installed. Install puts openscience on your PATH, linked to this app.",
      action: "Install",
    })
    expect(
      subject.commandLineCopy(
        status({ installable: false, reason: "The Linux AppImage runs from a temporary mount." }),
      ),
    ).toEqual({ description: "Not installed. The Linux AppImage runs from a temporary mount." })
    expect(subject.commandLineCopy(status({ exists: true, current: true, onPath: true }))).toEqual({
      description: "Installed and on your PATH",
    })
    expect(subject.commandLineCopy(status({ exists: true, current: true, onPath: false }))).toEqual({
      description: `Installed, but ~/.openscience/bin is not on your PATH — add: ${line}`,
      action: "Repair",
    })
    expect(
      subject.commandLineCopy(status({ exists: true, ours: false, onPath: true, installable: false, reason: foreign })),
    ).toEqual({ description: `Installed and on your PATH. ${foreign}` })
    expect(
      subject.commandLineCopy(
        status({ exists: true, target: `${home}/Downloads/OpenScience.app/Contents/Resources/sidecar/openscience` }),
      ),
    ).toEqual({
      description: "Installed, but it points at ~/Downloads/OpenScience.app/Contents/Resources/sidecar/openscience.",
      action: "Repair",
    })
  })

  test("installs from the row, shows the new status and says what to do next", async () => {
    const state = { installed: false, posts: 0 }
    const row = serve({
      get: () => (state.installed ? status({ exists: true, current: true, onPath: true }) : status()),
      post: () => {
        state.posts++
        state.installed = true
        return Response.json(status({ exists: true, current: true, onPath: true }))
      },
    })
    await until(() => row.description().startsWith("Not installed"))
    expect(row.button()?.textContent).toBe("Install")

    row.button()!.click()
    await until(() => row.description() === "Installed and on your PATH")
    expect(state.posts).toBe(1)
    expect(row.button()).toBeNull()
    await until(() => row.toasts().length === 1)
    expect(row.toasts()[0]).toContain("Command line tool installed")
    expect(row.toasts()[0]).toContain("Open a new terminal and run openscience.")
  })

  test("tells the person the line to add when no startup file could take it", async () => {
    const after = status({ exists: true, current: true, onPath: false, config: undefined })
    const row = serve({ get: () => status(), post: () => Response.json(after) })
    await until(() => row.button()?.textContent === "Install")

    row.button()!.click()
    await until(() => row.description().startsWith("Installed, but"))
    expect(row.description()).toBe(`Installed, but ~/.openscience/bin is not on your PATH — add: ${line}`)
    expect(row.button()?.textContent).toBe("Repair")
    await until(() => row.toasts().length === 1)
    expect(row.toasts()[0]).toContain(`Add this line to your shell startup file: ${line}`)
  })

  test("a refused install shows the reason and re-reads the status", async () => {
    const state = { gets: 0 }
    const row = serve({
      get: () => {
        state.gets++
        return state.gets === 1
          ? status()
          : status({ exists: true, ours: false, onPath: true, installable: false, reason: foreign })
      },
      post: () => Response.json({ error: foreign }, { status: 409 }),
    })
    await until(() => row.button()?.textContent === "Install")

    row.button()!.click()
    await until(() => row.toasts().length === 1)
    expect(row.toasts()[0]).toContain("The command line tool was not installed")
    expect(row.toasts()[0]).toContain(foreign)
    await until(() => row.description() === `Installed and on your PATH. ${foreign}`)
    expect(row.button()).toBeNull()
    expect(state.gets).toBe(2)
  })
})
