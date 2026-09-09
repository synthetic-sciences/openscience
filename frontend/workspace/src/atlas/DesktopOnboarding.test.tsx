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
    step?: string
    connected?: boolean
    ace?: boolean
    acePollsUntilOn?: number
    login?: () => Response | Promise<Response>
    session?: () => Response | Promise<Response>
    preferences?: () => Response | Promise<Response>
  } = {},
) {
  const state = {
    version: options.version ?? 0,
    step: options.step ?? "account",
    connected: options.connected ?? false,
    ace: options.ace ?? false,
    polls: 0,
    billing: "byok",
    keys: [] as string[],
    credentials: [] as string[],
  }
  const requests: string[] = []
  const opened: string[] = []
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const route = `${request.method} ${url.pathname}`
      requests.push(route)
      if (route === "GET /settings/preferences") {
        return (
          options.preferences?.() ??
          Response.json({ desktop_onboarding_version: state.version, desktop_onboarding_step: state.step })
        )
      }
      if (route === "PATCH /settings/preferences") {
        const patch = await request.json()
        if (typeof patch.desktop_onboarding_version === "number") state.version = patch.desktop_onboarding_version
        if (typeof patch.desktop_onboarding_step === "string") state.step = patch.desktop_onboarding_step
        return Response.json({ desktop_onboarding_version: state.version, desktop_onboarding_step: state.step })
      }
      if (route === "GET /account/session") {
        return options.session?.() ?? Response.json({ session: state.connected })
      }
      if (route === "POST /account/login-browser") {
        const response = await (options.login?.() ?? Response.json({ ok: true }))
        if ((await response.clone().json()).ok) state.connected = true
        return response
      }
      if (route === "POST /account/login-key") {
        const body = await request.json()
        if (body.key !== "valid-key") return Response.json({ ok: false, error: "That key was not accepted." })
        state.connected = true
        return Response.json({ ok: true })
      }
      if (route === "GET /settings/wallet") {
        if (url.searchParams.get("summary") !== "true") {
          state.polls += 1
          if (options.acePollsUntilOn !== undefined && state.polls >= options.acePollsUntilOn) state.ace = true
        }
        return Response.json({
          signedIn: true,
          balanceUsd: state.ace ? 12.5 : null,
          availableUsd: state.ace ? 12.5 : null,
          accessVerified: true,
          managedSupported: true,
          managedUnlocked: state.ace,
          aceEnabled: state.ace,
        })
      }
      if (route === "PUT /settings/billing") {
        state.billing = (await request.json()).llm
        return Response.json({ llm: state.billing })
      }
      if (route === "POST /provider/openai-codex/oauth/authorize") {
        return Response.json({ url: "https://auth.example/codex", method: "auto" })
      }
      if (route === "POST /provider/openai-codex/oauth/callback") {
        state.keys.push("openai-codex")
        return Response.json({})
      }
      if (request.method === "PUT" && /^\/auth\/[^/]+\/onboarding$/.test(url.pathname)) {
        const body = await request.json()
        if (body.key === "bad")
          return Response.json({ error: "That key was rejected by the provider." }, { status: 400 })
        state.keys.push(url.pathname.split("/")[2]!)
        return Response.json({ ok: true })
      }
      if (request.method === "PUT" && url.pathname.startsWith("/settings/credentials/")) {
        state.credentials.push(url.pathname.split("/").at(-1)!)
        return Response.json({ services: [] })
      }
      if (route === "POST /settings/compute/modal/configure") {
        return Response.json({ error: "No Modal profile found. Run `modal token new` first." }, { status: 400 })
      }
      return Response.json({ error: `Unexpected request: ${route}` }, { status: 404 })
    },
  })
  cleanups.push(() => void api.stop(true))
  const server = {
    url: api.url.origin,
    projects: { open() {}, touch() {} },
  }
  const platform: Platform = {
    platform: "desktop",
    fetch: Bun.fetch,
    openLink(url: string) {
      opened.push(url)
    },
    restart: async () => {},
    notify: async () => {},
    back() {},
    forward() {},
  }
  const mount = (desktop = true, extra: { signInDeadlineMs?: number; acePollMs?: number } = {}) => {
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = web.render(
      () =>
        subject.DesktopOnboardingController({
          server,
          platform,
          desktop,
          acePollMs: 10,
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
  return { state, requests, opened, mount }
}

function button(host: HTMLElement, label: string) {
  const result = Array.from(host.querySelectorAll("button")).find((element) => element.textContent?.trim() === label)
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}

function heading(host: HTMLElement) {
  return host.querySelector("h1")?.textContent ?? ""
}

function setInput(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>("input")
  if (!input) throw new Error("Missing input")
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

test("a fresh desktop starts at the account step with no way to skip it", async () => {
  const app = fixture()
  const view = app.mount()
  await until(() => heading(view.host) === "Welcome to OpenScience")
  expect(button(view.host, "Continue with Synthetic Sciences").disabled).toBe(false)
  expect(Array.from(view.host.querySelectorAll("button")).some((el) => /skip/i.test(el.textContent ?? ""))).toBe(false)
  expect(view.host.textContent).not.toContain("Research workspace loaded")
  expect(view.host.querySelector('[aria-current="step"]')).not.toBeNull()
})

test("browser sign-in waits for workspace approval, then advances to Ace", async () => {
  let release: (() => void) | undefined
  const app = fixture({ login: () => new Promise((resolve) => (release = () => resolve(Response.json({ ok: true })))) })
  const view = app.mount()
  await until(() => heading(view.host) === "Welcome to OpenScience")
  button(view.host, "Continue with Synthetic Sciences").click()
  await until(() => view.host.textContent?.includes("Waiting for sign-in") === true)
  expect(view.host.querySelector('[role="status"]')?.textContent).toContain("Choose your workspace in your browser")
  await until(() => typeof release === "function")
  release!()
  await until(() => heading(view.host) === "Turn on Ace")
  await until(() => app.state.step === "ace")
  expect(document.activeElement).toBe(view.host.querySelector("h1"))
  expect(view.host.textContent).toContain("Firecrawl")
})

test("a sign-in key is an alternative to the browser, and a bad key stays on the step", async () => {
  const app = fixture()
  const view = app.mount()
  await until(() => heading(view.host) === "Welcome to OpenScience")
  button(view.host, "Use a sign-in key instead").click()
  await until(() => view.host.querySelector("input") !== null)
  setInput(view.host, "nope")
  button(view.host, "Sign in").click()
  await until(() => view.host.querySelector('[role="alert"]') !== null)
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("not accepted")
  expect(heading(view.host)).toBe("Welcome to OpenScience")
  setInput(view.host, "valid-key")
  button(view.host, "Sign in").click()
  await until(() => heading(view.host) === "Turn on Ace")
  expect(app.requests.filter((route) => route === "POST /account/login-key")).toHaveLength(2)
})

test("browser sign-in gives up after its deadline and can be retried", async () => {
  const app = fixture({ login: () => new Promise(() => {}) })
  const view = app.mount(true, { signInDeadlineMs: 50 })
  await until(() => heading(view.host) === "Welcome to OpenScience")
  button(view.host, "Continue with Synthetic Sciences").click()
  await until(() => view.host.querySelector('[role="alert"]') !== null)
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Sign-in did not complete in time")
  expect(button(view.host, "Continue with Synthetic Sciences").disabled).toBe(false)
  expect(heading(view.host)).toBe("Welcome to OpenScience")
})

test("turning on Ace opens billing, polls the wallet, then selects managed models", async () => {
  const app = fixture({ connected: true, step: "ace", acePollsUntilOn: 2 })
  const view = app.mount()
  await until(() => heading(view.host) === "Turn on Ace")
  await until(() =>
    Array.from(view.host.querySelectorAll("button")).some((el) => el.textContent?.trim() === "Turn on Ace"),
  )
  button(view.host, "Turn on Ace").click()
  expect(app.opened).toEqual(["https://app.syntheticsciences.ai/billing"])
  await until(() => view.host.textContent?.includes("Ace is on") === true)
  expect(view.host.textContent).toContain("$12.50 available")
  expect(app.state.billing).toBe("managed")
  button(view.host, "Continue").click()
  await until(() => heading(view.host) === "Connect your own models")
  expect(view.host.textContent).toContain("used alongside Ace")
  await until(() => app.state.step === "connect")
})

test("skipping Ace warns that a model is still needed, and Back returns to Ace", async () => {
  const app = fixture({ connected: true, step: "ace" })
  const view = app.mount()
  await until(() => heading(view.host) === "Turn on Ace")
  await until(() =>
    Array.from(view.host.querySelectorAll("button")).some((el) => el.textContent?.trim() === "Skip for now"),
  )
  button(view.host, "Skip for now").click()
  await until(() => heading(view.host) === "Connect your own models")
  expect(view.host.textContent).toContain("You will need a model before your first message")
  button(view.host, "Back").click()
  await until(() => heading(view.host) === "Turn on Ace")
  expect(app.state.step).toBe("ace")
})

test("connections: a saved provider key clears the warning, a rejected key shows the provider's reason", async () => {
  const app = fixture({ connected: true, step: "connect" })
  const view = app.mount()
  await until(() => heading(view.host) === "Connect your own models")
  const rows = Array.from(view.host.querySelectorAll("li"))
  const anthropic = rows.find((row) => row.textContent?.includes("Anthropic"))!
  anthropic.querySelector("button")!.click()
  await until(() => anthropic.querySelector("input") !== null)
  setInput(anthropic, "bad")
  button(anthropic, "Save").click()
  await until(() => view.host.querySelector('[role="alert"]') !== null)
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("rejected by the provider")
  setInput(anthropic, "sk-ant-real")
  button(anthropic, "Save").click()
  await until(() => anthropic.textContent?.includes("Key saved") === true)
  expect(app.state.keys).toEqual(["anthropic"])
  expect(view.host.textContent).not.toContain("You will need a model before your first message")
  expect(view.host.querySelector('[role="alert"]')).toBeNull()
})

test("connections: ChatGPT connects through the OAuth routes, Modal detection reports its error inline", async () => {
  const app = fixture({ connected: true, step: "connect" })
  const view = app.mount()
  await until(() => heading(view.host) === "Connect your own models")
  button(view.host, "Connect").click()
  await until(() => view.host.textContent?.includes("Signed in") === true)
  expect(app.opened).toEqual(["https://auth.example/codex"])
  expect(app.state.keys).toEqual(["openai-codex"])
  button(view.host, "Detect").click()
  await until(() => view.host.querySelector('[role="alert"]') !== null)
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("modal token new")
})

test("finishing records the setup revision and reveals the workspace", async () => {
  const app = fixture({ connected: true, step: "connect", ace: true })
  const view = app.mount()
  await until(() => heading(view.host) === "Connect your own models")
  // A resumed setup reads the wallet before it claims anything about Ace.
  await until(() => view.host.textContent?.includes("used alongside Ace") === true)
  button(view.host, "Continue").click()
  await until(() => heading(view.host) === "You're set")
  expect(view.host.textContent).toContain("Signed in")
  expect(view.host.textContent).toContain("On · $12.50")
  button(view.host, "Open workspace").click()
  await until(() => view.host.textContent?.includes("Research workspace loaded") === true)
  expect(app.state.version).toBe(subject.ONBOARDING_VERSION)
  expect(app.state.step).toBe("done")
  expect(localStorage.getItem(versionKey)).toBe(String(subject.ONBOARDING_VERSION))

  const resumed = app.mount()
  await until(() => resumed.host.textContent?.includes("Research workspace loaded") === true)
  expect(resumed.host.textContent).not.toContain("Welcome to OpenScience")
})

test("a signed-in install resumes at the stored step; the account step is never shown again", async () => {
  const app = fixture({ connected: true, step: "connect" })
  const view = app.mount()
  await until(() => heading(view.host) === "Connect your own models")
  expect(view.host.textContent).not.toContain("Welcome to OpenScience")

  const stale = fixture({ connected: false, step: "connect" })
  const other = stale.mount()
  await until(() => heading(other.host) === "Welcome to OpenScience")
})

test("an install that finished the previous setup revision sees the new flow once", async () => {
  const app = fixture({ version: 1, connected: true })
  const view = app.mount()
  await until(() => heading(view.host) === "Turn on Ace")
  expect(view.host.textContent).not.toContain("Research workspace loaded")
})

test("server reset overrides a cached onboarding completion", async () => {
  localStorage.setItem(versionKey, String(subject.ONBOARDING_VERSION))
  const app = fixture({ version: 0 })
  const view = app.mount()
  await until(() => heading(view.host) === "Welcome to OpenScience")
  expect(view.host.textContent).not.toContain("Research workspace loaded")
})

test("an unavailable account check leaves sign-in usable", async () => {
  const app = fixture({ session: () => Response.json({ error: "Account check unavailable" }, { status: 503 }) })
  const view = app.mount()
  await until(() => heading(view.host) === "Welcome to OpenScience")
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Account check unavailable")
  expect(button(view.host, "Continue with Synthetic Sciences").disabled).toBe(false)
})

test("browser workspaces do not enter desktop onboarding", async () => {
  const app = fixture()
  const view = app.mount(false)
  expect(view.host.textContent).toContain("Research workspace loaded")
  expect(app.requests).toEqual([])
})
