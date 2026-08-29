import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { ProjectCreateInput } from "@/components/dialog-create-project"
import { canUseManaged } from "./desktop-onboarding-access"

type DesktopPreferences = {
  desktop_onboarding_version?: number
  desktop_onboarding_operations?: Record<string, string>
}

const cleanups: Array<() => void> = []
const mounted = new Map<HTMLElement, () => void>()
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
  mounted.clear()
  document.body.replaceChildren()
  window.history.replaceState({}, "", "/")
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(view, host)
  let active = true
  const cleanup = () => {
    if (!active) return
    active = false
    dispose()
    host.remove()
  }
  mounted.set(host, cleanup)
  cleanups.push(cleanup)
  return host
}

const unmount = (host: HTMLElement) => {
  const cleanup = mounted.get(host)
  if (!cleanup) return
  cleanup()
  mounted.delete(host)
  const index = cleanups.indexOf(cleanup)
  if (index >= 0) cleanups.splice(index, 1)
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
    const events: string[] = []
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
        if (key === "GET /settings/preferences") return json({ desktop_onboarding_version: 0 })
        if (key === "GET /account") return json({ session: true, user: { email: "researcher@example.com" } })
        if (key === "GET /settings/wallet") {
          return json({ signedIn: true, managedSupported: true, managedUnlocked: true, balanceUsd: 20 })
        }
        if (key === "POST /settings/preferences/onboarding-operation") {
          events.push("bind")
          return json({ operation_id: "00000000-0000-4000-8000-000000000001" })
        }
        if (key === "DELETE /settings/preferences/onboarding-operation") {
          events.push("clear")
          return new Response(null, { status: 204 })
        }
        if (key === "POST /global/project") {
          events.push("create")
          expect(JSON.parse(String(init?.body))).toEqual({
            name: "Cell atlas",
            sources: [{ path: "/Users/research/Cell atlas", access: "write" }],
            operation_id: expect.any(String),
          })
          return json({ id: "prj_cell", worktree: "/managed/cell", name: "Cell atlas", time: { created: 1 } }, 201)
        }
        if (key === "PATCH /settings/preferences") {
          const body = JSON.parse(String(init?.body)) as DesktopPreferences
          if (body.desktop_onboarding_version === 1) events.push("complete")
          return json({ desktop_onboarding_version: body.desktop_onboarding_version ?? 0, ...body })
        }
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
            open: (worktree: string) => {
              events.push("open")
              opened.push(worktree)
            },
            touch: (id: string) => {
              events.push("touch")
              touched.push(id)
            },
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

    expect(events).toEqual(["bind", "create", "complete", "open", "touch", "clear"])
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

  test("keeps the entered key visible when transactional provider setup rolls back", async () => {
    let stored: string | undefined
    const requests: string[] = []
    const platform = {
      platform: "desktop" as const,
      openLink() {},
      async restart() {},
      back() {},
      forward() {},
      async notify() {},
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname
        const request = `${init?.method ?? "GET"} ${pathname}`
        requests.push(request)
        if (request === "GET /settings/preferences") return json({ desktop_onboarding_version: 0 })
        if (request === "GET /account") return json({ session: true })
        if (request === "GET /settings/wallet") {
          return json({ signedIn: true, managedSupported: false, managedUnlocked: false })
        }
        if (request === "PUT /auth/anthropic/onboarding") {
          const previous = stored
          stored = (JSON.parse(String(init?.body)) as { key: string }).key
          // Model the server transaction's failure-after-save compensation.
          stored = previous
          return json({ error: "billing mode unavailable" }, 503)
        }
        return json({ error: "not_found" }, 404)
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
    await settle(() => host.textContent?.includes("Save key") === true)

    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!
    input.value = "sk-ant-retry"
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    await settle(() =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.includes("Save key") && !button.disabled,
      ),
    )
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save key"))
      ?.click()
    await settle(() => host.textContent?.includes("billing mode unavailable") === true)

    expect(input.value).toBe("sk-ant-retry")
    expect(stored).toBeUndefined()
    expect(requests).toContain("PUT /auth/anthropic/onboarding")
    expect(requests).not.toContain("PUT /auth/anthropic")
    expect(requests).not.toContain("POST /account/billing-mode")
  })

  test("preserves a pre-existing key, then retries cleanly after a full remount", async () => {
    let stored = "sk-existing"
    let mode: "managed" | "byok" = "managed"
    let attempts = 0
    const state = () => ({ stored, mode, attempts })
    const platform = {
      platform: "desktop" as const,
      openLink() {},
      async restart() {},
      back() {},
      forward() {},
      async notify() {},
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname
        const request = `${init?.method ?? "GET"} ${pathname}`
        if (request === "GET /settings/preferences") return json({ desktop_onboarding_version: 0 })
        if (request === "GET /account") return json({ session: true })
        if (request === "GET /settings/wallet") {
          return json({ signedIn: true, managedSupported: false, managedUnlocked: false })
        }
        if (request === "PUT /auth/anthropic/onboarding") {
          attempts++
          const previous = stored
          const previousMode = mode
          stored = (JSON.parse(String(init?.body)) as { key: string }).key
          if (attempts === 1) {
            stored = previous
            mode = previousMode
            return json({ error: "billing mode unavailable" }, 503)
          }
          mode = "byok"
          return json({ configured: true })
        }
        return json({ error: "not_found" }, 404)
      }) as typeof fetch,
    }
    const view = () =>
      subject.DesktopOnboardingController({
        desktop: true,
        platform,
        server: { url: "http://127.0.0.1:4096", projects: { open() {}, touch() {} } },
        children: "Workspace",
      })
    const enterAndSave = async (host: HTMLElement) => {
      await settle(() => host.textContent?.includes("Save key") === true)
      const input = host.querySelector<HTMLInputElement>('input[type="password"]')!
      input.value = "sk-replayed"
      input.dispatchEvent(new InputEvent("input", { bubbles: true }))
      await settle(() =>
        Array.from(host.querySelectorAll<HTMLButtonElement>("button")).some(
          (button) => button.textContent?.includes("Save key") && !button.disabled,
        ),
      )
      Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("Save key"))
        ?.click()
    }

    const first = mount(view)
    await enterAndSave(first)
    await settle(() => first.textContent?.includes("billing mode unavailable") === true)
    expect(state()).toMatchObject({ stored: "sk-existing", mode: "managed" })

    unmount(first)
    const second = mount(view)
    await enterAndSave(second)
    await settle(() => second.textContent?.includes("Saved") === true)

    expect(state()).toEqual({ stored: "sk-replayed", mode: "byok", attempts: 2 })
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

  test("keeps an ambiguous create retry on one operation and binds a different draft to a new operation", async () => {
    const operations = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]
    const requests: Array<ProjectCreateInput & { operation_id: string }> = []
    let firstCreate = true
    const flow = subject.createOnboardingProjectFlow({
      operationID: () => operations.shift()!,
      create: async (input) => {
        requests.push(input)
        if (firstCreate) {
          firstCreate = false
          throw new Error("response lost")
        }
        return {
          id: input.name === "Folder" ? "prj_folder" : "prj_blank",
          worktree: input.name === "Folder" ? "/managed/folder" : "/managed/blank",
          time: { created: 1 },
        }
      },
      markComplete: async () => {},
      activate() {},
    })
    const folder = { name: "Folder", sources: [{ path: "/research/folder", access: "write" as const }] }
    await expect(flow(folder)).rejects.toThrow("response lost")
    await flow(folder)
    await flow({ name: "Blank", sources: [] })

    expect(requests.map((request) => request.operation_id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ])
    expect(requests.at(-1)).toMatchObject({ name: "Blank", sources: [] })
  })

  test("reuses the persisted operation after a failed completion and a full component remount", async () => {
    let version = 0
    let operations: Record<string, string> = {}
    let completions = 0
    const posted: Array<ProjectCreateInput & { operation_id: string }> = []
    const events: string[] = []
    const platform = {
      platform: "desktop" as const,
      openLink() {},
      async restart() {},
      back() {},
      forward() {},
      async notify() {},
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname
        const request = `${init?.method ?? "GET"} ${pathname}`
        if (request === "GET /settings/preferences") return json({ desktop_onboarding_version: version })
        if (request === "GET /account") return json({ session: true })
        if (request === "GET /settings/wallet") {
          return json({ signedIn: true, managedSupported: false, managedUnlocked: false })
        }
        if (request === "POST /settings/preferences/onboarding-operation") {
          const { fingerprint } = JSON.parse(String(init?.body)) as { fingerprint: string }
          const existing = operations[fingerprint]
          operations[fingerprint] ??= crypto.randomUUID()
          if (!existing) events.push("bind")
          return json({ operation_id: operations[fingerprint] })
        }
        if (request === "DELETE /settings/preferences/onboarding-operation") {
          const { fingerprint } = JSON.parse(String(init?.body)) as { fingerprint: string }
          delete operations[fingerprint]
          events.push("clear")
          return new Response(null, { status: 204 })
        }
        if (request === "PATCH /settings/preferences") {
          const body = JSON.parse(String(init?.body)) as DesktopPreferences
          if (body.desktop_onboarding_version === 1) {
            completions++
            if (completions === 1) {
              events.push("completion-lost")
              return json({ message: "preferences unavailable" }, 503)
            }
            version = 1
            events.push("complete")
          }
          return json({ desktop_onboarding_version: version })
        }
        if (request === "POST /global/project") {
          const body = JSON.parse(String(init?.body)) as ProjectCreateInput & { operation_id: string }
          posted.push(body)
          events.push(posted.length === 1 ? "create" : "replay")
          return json(
            { id: "prj_replay", worktree: "/managed/replay", name: body.name, time: { created: 1 } },
            posted.length === 1 ? 201 : 200,
          )
        }
        return json({ error: "not_found" }, 404)
      }) as typeof fetch,
    }
    const view = () =>
      subject.DesktopOnboardingController({
        desktop: true,
        platform,
        server: {
          url: "http://127.0.0.1:4096",
          projects: {
            open: () => events.push("open"),
            touch: () => events.push("touch"),
          },
        },
        children: "Workspace ready",
      })

    const first = mount(view)
    await settle(() => first.textContent?.includes("Start a blank project") === true)
    Array.from(first.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Start a blank project"))
      ?.click()
    await settle(() => first.textContent?.includes("preferences unavailable") === true)
    const persisted = { ...operations }
    expect(Object.keys(persisted)).toEqual([
      subject.onboardingDraftFingerprint({ name: "New research project", sources: [] }),
    ])

    unmount(first)
    window.history.replaceState({}, "", "/")
    const second = mount(view)
    await settle(() => second.textContent?.includes("Start a blank project") === true)
    Array.from(second.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Start a blank project"))
      ?.click()
    await settle(() => second.textContent?.includes("Workspace ready") === true)

    expect(posted).toHaveLength(2)
    expect(posted[0]!.operation_id).toBe(posted[1]!.operation_id)
    expect(posted[0]!.operation_id).toBe(Object.values(persisted)[0])
    expect(operations).toEqual({})
    expect(events).toEqual(["bind", "create", "completion-lost", "replay", "complete", "open", "touch", "clear"])
  })

  test("creates the newly selected workspace when completion failed after another choice", async () => {
    const posted: Array<ProjectCreateInput & { operation_id: string }> = []
    const operations: Record<string, string> = {}
    const bindingSnapshots: Array<Record<string, string>> = []
    const opened: string[] = []
    let completions = 0
    const platform = {
      platform: "desktop" as const,
      openLink() {},
      async restart() {},
      back() {},
      forward() {},
      async notify() {},
      async openDirectoryPickerDialog() {
        return "/Users/research/Folder choice"
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname
        const key = `${init?.method ?? "GET"} ${pathname}`
        if (key === "GET /settings/preferences") return json({ desktop_onboarding_version: 0 })
        if (key === "GET /account") return json({ session: true, user: { email: "researcher@example.com" } })
        if (key === "GET /settings/wallet") {
          return json({ signedIn: true, managedSupported: true, managedUnlocked: true, balanceUsd: 20 })
        }
        if (key === "POST /settings/preferences/onboarding-operation") {
          const { fingerprint } = JSON.parse(String(init?.body)) as { fingerprint: string }
          operations[fingerprint] ??= crypto.randomUUID()
          bindingSnapshots.push({ ...operations })
          return json({ operation_id: operations[fingerprint] })
        }
        if (key === "DELETE /settings/preferences/onboarding-operation") {
          const { fingerprint } = JSON.parse(String(init?.body)) as { fingerprint: string }
          delete operations[fingerprint]
          bindingSnapshots.push({ ...operations })
          return new Response(null, { status: 204 })
        }
        if (key === "POST /global/project") {
          const body = JSON.parse(String(init?.body)) as ProjectCreateInput & { operation_id: string }
          posted.push(body)
          const folder = body.sources.length > 0
          return json(
            {
              id: folder ? "prj_folder" : "prj_blank",
              worktree: folder ? "/managed/folder" : "/managed/blank",
              name: body.name,
              time: { created: 1 },
            },
            201,
          )
        }
        if (key === "PATCH /settings/preferences") {
          const body = JSON.parse(String(init?.body)) as DesktopPreferences
          completions++
          if (completions === 1) return json({ message: "preferences unavailable" }, 503)
          return json({ desktop_onboarding_version: 1 })
        }
        return json({ error: "not_found" }, 404)
      }) as typeof fetch,
    }
    const host = mount(() =>
      subject.DesktopOnboardingController({
        desktop: true,
        platform,
        server: {
          url: "http://127.0.0.1:4096",
          projects: { open: (worktree: string) => opened.push(worktree), touch() {} },
        },
        children: "Workspace ready",
      }),
    )
    await settle(() => host.textContent?.includes("Open a folder") === true)

    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Open a folder"))
      ?.click()
    await settle(() => host.textContent?.includes("preferences unavailable") === true)
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Start a blank project"))
      ?.click()
    await settle(() => host.textContent?.includes("Workspace ready") === true)

    expect(posted).toHaveLength(2)
    expect(posted[0]).toMatchObject({
      name: "Folder choice",
      sources: [{ path: "/Users/research/Folder choice", access: "write" }],
    })
    expect(posted[1]).toMatchObject({ name: "New research project", sources: [] })
    expect(posted.map((request) => request.operation_id)).toEqual([
      expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
      expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
    ])
    expect(posted[0]!.operation_id).not.toBe(posted[1]!.operation_id)
    expect(Object.values(bindingSnapshots[0]!)).toEqual([posted[0]!.operation_id])
    expect(Object.values(bindingSnapshots[1]!).toSorted()).toEqual(
      [posted[0]!.operation_id, posted[1]!.operation_id].toSorted(),
    )
    expect(bindingSnapshots[2]).toEqual(bindingSnapshots[0])
    expect(opened).toEqual(["/managed/blank"])
  })
})
