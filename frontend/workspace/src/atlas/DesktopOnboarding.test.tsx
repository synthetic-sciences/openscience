import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { Platform } from "@/context/platform"

// happy-dom replaces the global Response; Bun's HTTP server needs its native one.
const Response = (await Bun.fetch("data:text/plain,")).constructor as typeof globalThis.Response

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: {
    alias: { "@": fileURLToPath(new URL("..", import.meta.url)) },
    conditions: ["browser", "production"],
    dedupe: ["solid-js", "solid-js/web"],
  },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule("/src/atlas/DesktopOnboarding.tsx")) as typeof import("./DesktopOnboarding")
const cleanups: Array<() => void> = []
const versionKey = "openscience.desktop_onboarding_version"

afterAll(() => vite.close())
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  localStorage.removeItem(versionKey)
  window.history.replaceState(null, "", "/")
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}

function fixture(
  options: {
    version?: number
    connected?: boolean
    login?: () => Response | Promise<Response>
    session?: () => Response | Promise<Response>
    preferences?: () => Response | Promise<Response>
  } = {},
) {
  const state = { version: options.version ?? 0, connected: options.connected ?? false }
  const requests: string[] = []
  const opened: string[] = []
  const touched: string[] = []
  const project = { id: "prj_onboarding", worktree: "/tmp/onboarding-fixture" }
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const route = `${request.method} ${new URL(request.url).pathname}`
      requests.push(route)
      if (route === "GET /settings/preferences") {
        return options.preferences?.() ?? Response.json({ desktop_onboarding_version: state.version })
      }
      if (route === "GET /account/session") {
        return options.session?.() ?? Response.json({ session: state.connected })
      }
      if (route === "POST /account/login-browser") {
        const response = await (options.login?.() ?? Response.json({ ok: true }))
        if ((await response.clone().json()).ok) state.connected = true
        return response
      }
      if (route === "POST /settings/preferences/onboarding-operation") {
        return Response.json({ operation_id: "51eb90b2-534b-4b48-aaba-d2a95a01ea16" })
      }
      if (route === "POST /global/project") return Response.json(project)
      if (route === "PATCH /settings/preferences") {
        state.version = (await request.json()).desktop_onboarding_version
        return Response.json({ desktop_onboarding_version: state.version })
      }
      if (route === "DELETE /settings/preferences/onboarding-operation") return Response.json(true)
      return Response.json({ error: `Unexpected request: ${route}` }, { status: 404 })
    },
  })
  cleanups.push(() => void api.stop(true))
  const server = {
    url: api.url.origin,
    projects: {
      open: (directory: string) => {
        opened.push(directory)
      },
      touch: (id: string) => {
        touched.push(id)
      },
    },
  }
  const platform: Platform = {
    platform: "desktop",
    fetch: Bun.fetch,
    openLink() {},
    restart: async () => {},
    notify: async () => {},
    back() {},
    forward() {},
  }
  const mount = (desktop = true, extra: { signInDeadlineMs?: number } = {}) => {
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = web.render(
      () =>
        subject.DesktopOnboardingController({
          server,
          platform,
          desktop,
          ...extra,
          get children() {
            const content = document.createElement("div")
            content.textContent = "Research workspace loaded"
            return content
          },
        }),
      host,
    )
    cleanups.push(dispose)
    return { host, dispose }
  }
  return { state, requests, opened, touched, project, mount }
}

function button(host: HTMLElement, label: string) {
  const result = Array.from(host.querySelectorAll("button")).find((element) => element.textContent?.trim() === label)
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}

test("a fresh desktop starts with sign-in and a separate Skip action", async () => {
  const app = fixture()
  const view = app.mount()
  await until(() => view.host.textContent?.includes("Welcome to OpenScience") === true)

  expect(button(view.host, "Sign in with Synthetic Sciences").disabled).toBe(false)
  expect(button(view.host, "Skip").closest("footer")).not.toBeNull()
  expect(view.host.textContent).toContain("Opens Synthetic Sciences in your browser")
  expect(view.host.textContent).not.toContain("syntheticsciences.ai")
  expect(view.host.textContent).not.toContain("Start with your research")
  expect(view.host.textContent).not.toContain("Research workspace loaded")
  expect(app.requests).toEqual(["GET /settings/preferences", "GET /account/session"])
})

test("browser sign-in waits for workspace approval and then advances automatically", async () => {
  const approval = Promise.withResolvers<Response>()
  const app = fixture({ login: () => approval.promise })
  const view = app.mount()
  await until(() => view.host.textContent?.includes("Welcome to OpenScience") === true)
  button(view.host, "Sign in with Synthetic Sciences").click()
  await until(() => app.requests.includes("POST /account/login-browser"))
  expect(button(view.host, "Waiting for sign-in…").disabled).toBe(true)
  button(view.host, "Waiting for sign-in…").click()
  expect(app.requests.filter((route) => route === "POST /account/login-browser")).toHaveLength(1)
  expect(view.host.querySelector('[role="status"]')?.textContent).toContain("Choose your workspace in your browser")
  expect(view.host.textContent).not.toContain("Start with your research")

  approval.resolve(Response.json({ ok: true }))
  await until(() => view.host.textContent?.includes("Start with your research") === true)
  expect(view.host.textContent).toContain("Account connected")
  expect(document.activeElement).toBe(view.host.querySelector("h1"))
  expect(app.state.version).toBe(0)

  view.dispose()
  const resumed = app.mount()
  await until(() => resumed.host.textContent?.includes("Start with your research") === true)
  expect(resumed.host.textContent).not.toContain("Sign in with Synthetic Sciences")
})

test("browser sign-in gives up after its deadline and can be retried", async () => {
  const approval = Promise.withResolvers<Response>()
  const app = fixture({ login: () => approval.promise })
  const view = app.mount(true, { signInDeadlineMs: 40 })
  await until(() => view.host.textContent?.includes("Welcome to OpenScience") === true)
  button(view.host, "Sign in with Synthetic Sciences").click()
  await until(() => app.requests.includes("POST /account/login-browser"))
  expect(button(view.host, "Waiting for sign-in…").disabled).toBe(true)

  await until(() => view.host.querySelector('[role="alert"]') !== null)
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Sign-in did not complete in time")
  expect(button(view.host, "Sign in with Synthetic Sciences").disabled).toBe(false)
  expect(view.host.textContent).not.toContain("Start with your research")

  // The abandoned approval cannot advance the window later.
  approval.resolve(Response.json({ ok: true }))
  await Bun.sleep(25)
  expect(view.host.textContent).not.toContain("Start with your research")
  expect(app.state.version).toBe(0)
})

test("skipping sign-in still requires project setup before onboarding is saved", async () => {
  const app = fixture()
  const view = app.mount()
  await until(() => view.host.textContent?.includes("Welcome to OpenScience") === true)
  button(view.host, "Skip").click()
  await until(() => view.host.textContent?.includes("Start with your research") === true)
  expect(app.state.version).toBe(0)
  expect(app.requests.some((route) => route.startsWith("POST"))).toBe(false)
  expect(document.activeElement).toBe(view.host.querySelector("h1"))

  const blank = Array.from(view.host.querySelectorAll("button")).find((element) =>
    element.textContent?.includes("Start a blank project"),
  )!
  blank.click()
  await until(() => view.host.textContent?.includes("Research workspace loaded") === true)
  expect(app.state.version).toBe(1)
  expect(localStorage.getItem(versionKey)).toBe("1")
  expect(app.opened).toEqual([app.project.worktree])
  expect(app.touched).toEqual([app.project.id])
  expect(app.requests.filter((route) => route === "POST /global/project")).toHaveLength(1)
  expect(app.requests).not.toContain("POST /account/login-browser")

  view.dispose()
  localStorage.removeItem(versionKey)
  const resumed = app.mount()
  await until(() => resumed.host.textContent?.includes("Research workspace loaded") === true)
  expect(resumed.host.textContent).not.toContain("Welcome to OpenScience")
})

test("failed login stays on sign-in, focuses the error, and can be retried", async () => {
  const responses = [
    Response.json({ ok: false, error: "Workspace approval expired. Try again." }),
    Response.json({ ok: true }),
  ]
  const app = fixture({ login: () => responses.shift()! })
  const view = app.mount()
  await until(() => view.host.textContent?.includes("Welcome to OpenScience") === true)
  button(view.host, "Sign in with Synthetic Sciences").click()
  await until(() => view.host.querySelector('[role="alert"]') !== null)
  expect(view.host.textContent).toContain("Workspace approval expired. Try again.")
  expect(view.host.textContent).not.toContain("Start with your research")
  expect(document.activeElement).toBe(view.host.querySelector('[role="alert"]'))
  button(view.host, "Sign in with Synthetic Sciences").click()
  await until(() => view.host.textContent?.includes("Start with your research") === true)
  expect(view.host.querySelector('[role="alert"]')).toBeNull()
})

test.each([true, false])("Skip remains available while browser sign-in is pending (success: %s)", async (ok) => {
  const approval = Promise.withResolvers<Response>()
  const app = fixture({ login: () => approval.promise })
  const view = app.mount()
  await until(() => view.host.textContent?.includes("Welcome to OpenScience") === true)
  button(view.host, "Sign in with Synthetic Sciences").click()
  await until(() => app.requests.includes("POST /account/login-browser"))
  expect(button(view.host, "Skip").disabled).toBe(false)
  button(view.host, "Skip").click()
  expect(view.host.textContent).toContain("Start with your research")

  approval.resolve(Response.json({ ok, error: "Browser authorization timed out." }))
  await Bun.sleep(25)
  expect(view.host.textContent).toContain("Start with your research")
  expect(view.host.querySelector('[role="alert"]')).toBeNull()
  expect(app.state.version).toBe(0)
})

test("an existing account proceeds directly to research setup", async () => {
  const app = fixture({ connected: true })
  const view = app.mount()
  await until(() => view.host.textContent?.includes("Start with your research") === true)
  expect(view.host.textContent).toContain("Account connected")
  expect(view.host.textContent).not.toContain("Sign in with Synthetic Sciences")
  expect(app.state.version).toBe(0)
})

test("completed onboarding does not require an account or reopen setup", async () => {
  const app = fixture({ version: 1 })
  const view = app.mount()
  await until(() => view.host.textContent?.includes("Research workspace loaded") === true)
  expect(app.requests).toEqual(["GET /settings/preferences"])
  expect(view.host.textContent).not.toContain("Welcome to OpenScience")
})

test("server reset overrides a cached onboarding completion", async () => {
  localStorage.setItem(versionKey, "1")
  const app = fixture()
  const view = app.mount()
  await until(() => view.host.textContent?.includes("Welcome to OpenScience") === true)
  expect(view.host.textContent).not.toContain("Research workspace loaded")
  expect(localStorage.getItem(versionKey)).toBe("0")
})

test("a cached completion waits for the account check before exposing setup actions", async () => {
  localStorage.setItem(versionKey, "1")
  const session = Promise.withResolvers<Response>()
  const app = fixture({ session: () => session.promise })
  const view = app.mount()
  await until(() => app.requests.includes("GET /account/session"))
  expect(view.host.querySelector('[aria-label="Loading desktop setup"]')).not.toBeNull()
  expect(view.host.querySelector("button")).toBeNull()

  session.resolve(Response.json({ session: false }))
  await until(() => view.host.textContent?.includes("Welcome to OpenScience") === true)
  button(view.host, "Skip").click()
  expect(view.host.textContent).toContain("Start with your research")
})

test("an unavailable account check leaves sign-in and Skip usable", async () => {
  const app = fixture({ session: () => Response.json({ error: "Account check unavailable" }, { status: 503 }) })
  const view = app.mount()
  await until(() => view.host.textContent?.includes("Welcome to OpenScience") === true)
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Account check unavailable")
  expect(button(view.host, "Sign in with Synthetic Sciences").disabled).toBe(false)
  button(view.host, "Skip").click()
  expect(view.host.textContent).toContain("Start with your research")
  expect(view.host.querySelector('[role="alert"]')).toBeNull()
})

test("browser workspaces do not enter desktop onboarding", async () => {
  const app = fixture()
  const view = app.mount(false)
  expect(view.host.textContent).toContain("Research workspace loaded")
  expect(app.requests).toEqual([])
})
