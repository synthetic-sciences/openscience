import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { canUseManaged } from "./desktop-onboarding-access"

const cleanups: Array<() => void> = []
const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/DesktopOnboarding.tsx") as Promise<typeof import("./DesktopOnboarding")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  window.history.replaceState({}, "", "/")
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "content-type": "application/json" } })

const settle = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("onboarding did not settle")
}

describe("desktop onboarding", () => {
  test("keeps Aayam's signed-in, supported, and unlocked managed-access boundary", () => {
    expect(canUseManaged(undefined)).toBe(false)
    expect(
      canUseManaged({
        signedIn: true,
        managedSupported: true,
        managedUnlocked: true,
        aceEnabled: false,
        balanceUsd: 0,
      }),
    ).toBe(true)
    expect(
      canUseManaged({
        signedIn: false,
        managedSupported: true,
        managedUnlocked: true,
        aceEnabled: true,
        balanceUsd: 20,
      }),
    ).toBe(false)
    expect(
      canUseManaged({
        signedIn: true,
        managedSupported: false,
        managedUnlocked: true,
        aceEnabled: true,
        balanceUsd: 20,
      }),
    ).toBe(false)
    expect(
      canUseManaged({
        signedIn: true,
        managedSupported: true,
        managedUnlocked: false,
        aceEnabled: true,
        balanceUsd: 20,
      }),
    ).toBe(false)
  })

  test("creates the selected folder project before marking setup complete and opening it", async () => {
    const requests: string[] = []
    const opened: string[] = []
    const touched: string[] = []
    const platform = {
      platform: "desktop" as const,
      openLink() {},
      async restart() {},
      back() {},
      forward() {},
      async notify() {},
      async openDirectoryPickerDialog() {
        return "/Users/research/Cell atlas"
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname
        const key = `${init?.method ?? "GET"} ${pathname}`
        requests.push(key)
        if (key === "GET /settings/preferences") return json({ desktop_onboarding_version: 0 })
        if (key === "GET /account") return json({ session: true, user: { email: "researcher@example.com" } })
        if (key === "GET /settings/wallet") {
          return json({ signedIn: true, managedSupported: true, managedUnlocked: true, balanceUsd: 20 })
        }
        if (key === "POST /global/project") {
          expect(JSON.parse(String(init?.body))).toEqual({
            name: "Cell atlas",
            sources: [{ path: "/Users/research/Cell atlas", access: "write" }],
          })
          return json({ id: "prj_cell", worktree: "/managed/cell", name: "Cell atlas", time: { created: 1 } }, 201)
        }
        if (key === "PATCH /settings/preferences") return json({ desktop_onboarding_version: 1 })
        return json({ error: "not_found" }, 404)
      }) as typeof fetch,
    }
    const host = mount(() =>
      subject.DesktopOnboardingController({
        desktop: true,
        platform,
        server: {
          url: "http://127.0.0.1:4096",
          projects: {
            open: (worktree: string) => opened.push(worktree),
            touch: (id: string) => touched.push(id),
          },
        },
        children: "Workspace ready",
      }),
    )
    await settle(() => host.textContent?.includes("Open a folder") === true)

    const open = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Open a folder"),
    )
    open?.click()
    open?.click()
    await settle(() => host.textContent?.includes("Workspace ready") === true)

    expect(requests.filter((request) => request === "POST /global/project")).toHaveLength(1)
    expect(requests.indexOf("POST /global/project")).toBeLessThan(requests.indexOf("PATCH /settings/preferences"))
    expect(opened).toEqual(["/managed/cell"])
    expect(touched).toEqual(["prj_cell"])
  })

  test("keeps a useful branded loading surface while preferences are pending", async () => {
    const gate = Promise.withResolvers<Response>()
    const platform = {
      platform: "desktop" as const,
      openLink() {},
      async restart() {},
      back() {},
      forward() {},
      async notify() {},
      fetch: (async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input)).pathname
        if (pathname === "/settings/preferences") return gate.promise
        if (pathname === "/account") return json({ session: true })
        return json({ signedIn: true, managedSupported: false, managedUnlocked: false })
      }) as typeof fetch,
    }
    const host = mount(() =>
      subject.DesktopOnboardingController({
        desktop: true,
        platform,
        server: { url: "http://127.0.0.1:4096", projects: { open() {}, touch() {} } },
        children: "Workspace",
      }),
    )

    expect(host.querySelector('[role="img"][aria-label="OpenScience"]')).toBeTruthy()
    expect(host.textContent).toContain("Preparing your workspace")
    gate.resolve(json({ desktop_onboarding_version: 0 }))
  })

  test("saves a provider credential before selecting BYOK", async () => {
    const order: string[] = []
    await subject.configureProviderKey({
      saveKey: async () => {
        order.push("key")
      },
      selectByok: async () => {
        order.push("byok")
      },
    })
    expect(order).toEqual(["key", "byok"])
  })

  test("retries completion without creating a duplicate project", async () => {
    let creates = 0
    let completes = 0
    const flow = subject.createOnboardingProjectFlow({
      create: async () => {
        creates++
        return { id: "prj_once", worktree: "/managed/once", time: { created: 1 } }
      },
      markComplete: async () => {
        completes++
        if (completes === 1) throw new Error("preferences unavailable")
      },
      activate() {},
    })
    const draft = { name: "Once", sources: [] }
    await expect(flow(draft)).rejects.toThrow("preferences unavailable")
    await flow(draft)
    expect({ creates, completes }).toEqual({ creates: 1, completes: 2 })
  })
})
