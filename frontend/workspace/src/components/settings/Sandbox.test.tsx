import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createServer as createHttpServer } from "node:http"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

// Full real render: the same Vite SSR-load + happy-dom harness KernelCard.test.tsx
// uses, but this panel additionally needs the app's real context stack (it calls
// useGlobalSDK()/usePlatform() to reach the settings API), so the provider chain
// is assembled here too rather than stubbed — a real ServerProvider computes a
// real active URL, a real GlobalSDKProvider wraps a real fetch, and a real
// (in-process) HTTP server answers /settings/sandbox. This is what proves the
// dropdown a user actually opens shows "allowlist", not just that the types
// compile.
const vite = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})

const [Sandbox, PlatformCtx, ServerCtx, GlobalSDKCtx, Solid, web] = await Promise.all([
  vite.ssrLoadModule("/src/components/settings/Sandbox.tsx") as Promise<typeof import("./Sandbox")>,
  vite.ssrLoadModule("/src/context/platform.tsx") as Promise<typeof import("../../context/platform")>,
  vite.ssrLoadModule("/src/context/server.tsx") as Promise<typeof import("../../context/server")>,
  vite.ssrLoadModule("/src/context/global-sdk.tsx") as Promise<typeof import("../../context/global-sdk")>,
  vite.ssrLoadModule("solid-js") as Promise<typeof import("solid-js")>,
  vite.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])

type SandboxConfig = {
  enabled?: boolean
  network?: "deny" | "allowlist" | "allow"
  allowHosts?: string[]
  allowWrite?: string[]
  onUnavailable?: "warn" | "error" | "allow"
}

// A real HTTP server implementing the GET/PUT /settings/sandbox contract
// (see backend/cli/src/server/routes/settings/sandbox.ts) against real
// in-memory state, so a PATCH the panel issues is a real request/response
// round trip, not an asserted call. Built on node:http rather than
// Bun.serve(): happy-dom's GlobalRegistrator (this workspace's shared test
// preload) replaces the process-global Response/fetch/Request classes, and
// Bun.serve()'s handler return value is checked against ITS OWN native
// Response identity — a happy-dom Response fails that check with "Expected
// a Response object, but received ...". node:http's request/response
// objects are a different API entirely, so they don't collide.
function fakeServer(initial: SandboxConfig) {
  let config: SandboxConfig = { ...initial }
  const puts: SandboxConfig[] = []
  let gets = 0
  const status = { platform: "linux", backend: "bubblewrap" as const, available: true, tool: "bwrap" }

  // happy-dom's fetch() enforces real CORS (unlike Bun's native fetch): the
  // window's origin differs from this server's, so every response needs an
  // explicit allow-origin, and the JSON content-type on PUT triggers a
  // preflight OPTIONS the server must answer.
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal")
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-methods": "GET,PUT,POST,OPTIONS" })
      res.end()
      return
    }
    if (url.pathname === "/settings/sandbox" && req.method === "GET") {
      gets++
      res.writeHead(200, { ...cors, "content-type": "application/json" })
      res.end(JSON.stringify({ config, status }))
      return
    }
    if (url.pathname === "/settings/sandbox" && req.method === "PUT") {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        const patch = JSON.parse(Buffer.concat(chunks).toString() || "{}") as SandboxConfig
        puts.push(patch)
        config = { ...config, ...patch }
        res.writeHead(200, { ...cors, "content-type": "application/json" })
        res.end(JSON.stringify({ config, status }))
      })
      return
    }
    // Health probe / event stream the surrounding app context makes on
    // mount — not under test here; just must not hang or throw.
    res.writeHead(200, { ...cors, "content-type": "application/json" })
    res.end("{}")
  })

  return {
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve)
      }),
    get url() {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("fakeServer not listening")
      return `http://127.0.0.1:${address.port}`
    },
    get config() {
      return config
    },
    get puts() {
      return puts
    },
    get gets() {
      return gets
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const platformValue = {
  platform: "web" as const,
  openLink: () => {},
  restart: async () => {},
  back: () => {},
  forward: () => {},
  notify: async () => {},
}

const cleanups: Array<() => void> = []
afterAll(async () => {
  cleanups.splice(0).forEach((c) => c())
  await vite.close()
})
afterEach(() => {
  cleanups.splice(0).forEach((c) => c())
  document.body.replaceChildren()
})

const settle = () => new Promise((r) => setTimeout(r, 20))

const mount = async (initial: SandboxConfig) => {
  const api = fakeServer(initial)
  await api.listen()
  const host = document.createElement("div")
  document.body.append(host)
  const view = () =>
    Solid.createComponent(PlatformCtx.PlatformProvider, {
      value: platformValue,
      get children() {
        return Solid.createComponent(ServerCtx.ServerProvider, {
          defaultUrl: api.url,
          get children() {
            return Solid.createComponent(GlobalSDKCtx.GlobalSDKProvider, {
              get children() {
                return Solid.createComponent(Sandbox.default, {})
              },
            })
          },
        })
      },
    })
  const dispose = web.render(view, host)
  cleanups.push(() => {
    dispose()
    api.stop()
  })
  // Real async settling: persisted-storage ready gate -> defaultUrl effect ->
  // the panel's own createResource GET -> re-render with real data. Poll on
  // the actual GET landing (not merely on a select existing — the trigger
  // renders immediately from the panel's own pre-load fallback, which would
  // satisfy an existence check before the real config ever arrives).
  for (let i = 0; i < 100 && api.gets === 0; i++) await settle()
  for (let i = 0; i < 20 && !host.querySelector("[data-slot='select-select-trigger-value']"); i++) await settle()
  await settle()
  return { host, api }
}

// Kobalte's Select opens/selects on a full pointer sequence, not a bare
// "click" — happy-dom needs pointerdown/mousedown/pointerup/mouseup/click
// dispatched explicitly for its internal press handling to fire.
const pointerActivate = (el: HTMLElement) => {
  el.focus()
  for (const [Ctor, type] of [
    [PointerEvent, "pointerdown"],
    [MouseEvent, "mousedown"],
    [PointerEvent, "pointerup"],
    [MouseEvent, "mouseup"],
    [MouseEvent, "click"],
  ] as const) {
    el.dispatchEvent(
      new Ctor(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...(Ctor === PointerEvent ? { pointerId: 1 } : {}),
      }),
    )
  }
}

const networkTriggerValue = (host: HTMLElement) => {
  const row = [...host.querySelectorAll("span")]
    .find((el) => el.textContent === "Network egress")
    ?.closest("div.flex.flex-wrap")
  return row?.querySelector("[data-slot='select-select-trigger-value']")?.textContent
}

describe("Sandbox settings panel — network policy", () => {
  test("a config that has never set network still shows the shipped allowlist default", async () => {
    const { host } = await mount({})
    expect(networkTriggerValue(host)).toContain("Allowlist")
  })

  test("a config explicitly persisted as allowlist displays as allowlist, not blank", async () => {
    const { host } = await mount({ network: "allowlist" })
    expect(networkTriggerValue(host)).toContain("Allowlist")
  })

  test("a config persisted as deny still displays as deny", async () => {
    const { host } = await mount({ network: "deny" })
    expect(networkTriggerValue(host)).toContain("Deny")
  })

  test("selecting Allow from the dropdown round-trips a real PATCH and the trigger updates", async () => {
    const { host, api } = await mount({ network: "allowlist" })
    expect(networkTriggerValue(host)).toContain("Allowlist")

    const row = [...host.querySelectorAll("span")]
      .find((el) => el.textContent === "Network egress")
      ?.closest("div.flex.flex-wrap")
    const trigger = row?.querySelector<HTMLElement>("[data-slot='select-select-trigger']")
    expect(trigger).toBeTruthy()
    pointerActivate(trigger!)

    let option: HTMLElement | undefined
    for (let i = 0; i < 50 && !option; i++) {
      option = [...document.querySelectorAll<HTMLElement>("[data-slot='select-select-item']")].find((el) =>
        el.textContent?.includes("Allow — unrestricted"),
      )
      if (!option) await settle()
    }
    expect(option).toBeTruthy()
    pointerActivate(option!)

    for (let i = 0; i < 50 && api.puts.length === 0; i++) await settle()
    expect(api.puts).toEqual([{ network: "allow" }])
    expect(api.config.network).toBe("allow")

    for (let i = 0; i < 50 && !networkTriggerValue(host)?.includes("Allow —"); i++) await settle()
    expect(networkTriggerValue(host)).toContain("Allow — unrestricted")
  })
})

describe("Sandbox settings panel — extra allowed hosts", () => {
  test("the editor is shown under allowlist and hidden under deny", async () => {
    const allowlisted = await mount({ network: "allowlist" })
    expect([...allowlisted.host.querySelectorAll("span")].some((el) => el.textContent === "Extra allowed hosts")).toBe(
      true,
    )

    const denied = await mount({ network: "deny" })
    expect([...denied.host.querySelectorAll("span")].some((el) => el.textContent === "Extra allowed hosts")).toBe(false)
  })

  test("adding a host round-trips a real PATCH and the new host renders back", async () => {
    const { host, api } = await mount({ network: "allowlist", allowHosts: [] })
    const input = [...host.querySelectorAll("input")].find((el) => el.placeholder === "pypi.example.com")
    expect(input).toBeTruthy()

    input!.value = ".internal.example.com"
    input!.dispatchEvent(new Event("input", { bubbles: true }))
    const add = [...host.querySelectorAll("button")].find((el) => el.textContent === "Add" && !el.disabled)
    expect(add).toBeTruthy()
    pointerActivate(add!)

    for (let i = 0; i < 50 && api.puts.length === 0; i++) await settle()
    expect(api.puts).toEqual([{ allowHosts: [".internal.example.com"] }])

    // Poll on exactly the predicate being asserted. Waiting on a looser one
    // (the whole subtree's textContent containing the host) can go true while
    // the <code> element this asserts on has not rendered, spending all 50
    // iterations and then failing anyway — and a substring test against a
    // rendered hostname is also what CodeQL flags as incomplete URL
    // sanitization, which it is not, but the strict check is better regardless.
    const rendered = () => [...host.querySelectorAll("code")].some((el) => el.textContent === ".internal.example.com")
    for (let i = 0; i < 50 && !rendered(); i++) await settle()
    expect(rendered()).toBe(true)
  })
})
