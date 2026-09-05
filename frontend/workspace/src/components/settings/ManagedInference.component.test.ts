import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { once } from "node:events"
import { createServer as createHTTPServer } from "node:http"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { ManagedInference } from "./ManagedInference"

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
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule(
  "/src/components/settings/ManagedInference.tsx",
)) as typeof import("./ManagedInference")
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await settle()
  expect(check()).toBe(true)
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
const contract = {
  activationAuthorizationUsd: 0,
  reloadThresholdUsd: 5,
  reloadAmountUsd: 20,
  serviceMarginPercent: 2,
  processingFeeDisclosedSeparately: true,
  reloadControlledByAce: true,
}
const funded = {
  signedIn: true,
  accessVerified: true,
  balanceUsd: 778.16,
  balanceRedacted: false,
  billingMode: "managed" as "managed" | "byok",
  managedSupported: true,
  managedUnlocked: true,
  aceEnabled: true,
  aceContract: contract,
}
type Wallet = Omit<typeof funded, "balanceUsd"> & {
  balanceUsd: number | null
  refreshing?: boolean
  refreshedAt?: number | null
  error?: string
}
type Services = NonNullable<Parameters<typeof ManagedInference>[0]["services"]>

// Exercise the real component, recovery controller and JSON transport against
// an isolated loopback account. No provider, account or payment is contacted.
const mount = async (wallet: Wallet = funded) => {
  const state = {
    wallet,
    mode: wallet.billingMode,
    unavailable: false,
    rejectWrite: false,
    refreshes: 0,
    reads: 0,
    billingReads: 0,
    holdBillingRead: undefined as Promise<void> | undefined,
    holdWalletRead: undefined as Promise<void> | undefined,
    holdWrite: undefined as Promise<void> | undefined,
    holdCommit: undefined as Promise<void> | undefined,
    writes: [] as unknown[],
    links: [] as string[],
    errors: [] as Array<string | undefined>,
    // Subscribers to the server's `account.updated` announcement.
    updated: new Set<() => void>(),
  }
  // Node's HTTP response avoids HappyDOM's replacement of global Response,
  // while preserving an actual streamed request/response through settingsApi.
  const server = createHTTPServer(async (request, response) => {
    const json = (data: unknown, status = 200) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, PUT, OPTIONS",
        "access-control-allow-headers": "content-type",
      })
      response.end(JSON.stringify(data))
    }
    if (request.method === "OPTIONS") return json(null, 204)
    const path = new URL(request.url!, "http://127.0.0.1").pathname
    if (path === "/settings/wallet") {
      state.reads++
      if (state.unavailable) return json({ message: "Temporarily unavailable" }, 503)
      const data = { ...state.wallet, billingMode: state.mode }
      await state.holdWalletRead
      return json(data)
    }
    if (path === "/settings/billing") {
      if (request.method === "PUT") {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { llm: typeof state.mode }
        state.writes.push(body)
        if (state.rejectWrite) {
          await state.holdWrite
          return json({ message: "Access preference could not be saved" }, 409)
        }
        await state.holdCommit
        state.mode = body.llm
        await state.holdWrite
        return json({ llm: body.llm })
      }
      state.billingReads++
      const data = { llm: state.mode }
      await state.holdBillingRead
      return json(data)
    }
    return json({ message: `Unexpected request: ${request.method} ${path}` }, 500)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener")
  const services: Services = {
    sdk: { url: `http://127.0.0.1:${address.port}` },
    sync: {
      data: { config: { billing: { llm: state.mode } } },
      refreshProviders: async () => {
        state.refreshes++
      },
      onProvidersRefreshed: () => () => {},
      onAccountRefreshed: (callback) => {
        state.updated.add(callback)
        return () => state.updated.delete(callback)
      },
    },
    platform: { fetch, openLink: (url) => state.links.push(url) },
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () => subject.ManagedInference({ services, onError: (message) => state.errors.push(message) }),
    host,
  )
  cleanups.push(() => {
    dispose()
    server.closeAllConnections()
    server.close()
  })
  return { host, state }
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

describe("Ace account surface", () => {
  test("separates exact purchased balance, authorization and routing with native disclosure", async () => {
    const { host } = await mount()
    await ready(() => host.textContent?.includes("$778.16") === true)
    expect(host.querySelector("dt")?.textContent).toBe("Purchased Wallet")
    expect(host.querySelector("dd")?.textContent).toBe("$778.16")
    expect([...host.querySelectorAll("strong")].filter((item) => item.textContent === "Ace")).toHaveLength(1)
    expect(host.querySelector('[role="status"]')?.textContent).toBe("On")
    expect(button(host, "Ace").getAttribute("aria-pressed")).toBe("true")
    expect(button(host, "Manage Ace")).toBeDefined()
    const details = host.querySelector("details")!
    expect(details.open).toBe(false)
    expect(details.querySelector("summary")?.textContent).toBe("Auto-reloadadds $20 when the balance drops below $5")
    details.querySelector("summary")!.click()
    expect(details.open).toBe(true)
    expect(details.textContent).toContain(subject.aceContractLabel(contract))
    expect(details.textContent).toContain("does not turn off Ace or its auto-reload")
  })

  test("uses server-provided reload amounts and never turns a routing choice into a payment", async () => {
    const { host, state } = await mount({
      ...funded,
      aceContract: { ...contract, reloadAmountUsd: 40, reloadThresholdUsd: 9 },
    })
    await ready(
      () => host.querySelector("summary")?.textContent?.includes("$40 when the balance drops below $9") === true,
    )
    button(host, "Ace").click()
    await settle()
    expect(state.writes).toEqual([])
    button(host, "Keys & subscriptions").click()
    await ready(() => state.refreshes === 1)
    expect(state.writes).toEqual([{ llm: "byok" }])
    expect(button(host, "Keys & subscriptions").getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector('[role="status"]')?.textContent).toBe("On")
    expect(host.querySelector("summary")?.textContent).toContain("Auto-reload")
    expect(state.links).toEqual([])
  })

  test("shows authorization terms before activation and opens the existing consent flow", async () => {
    const { host, state } = await mount({ ...funded, balanceUsd: 0, aceEnabled: false, managedUnlocked: false })
    await ready(() => button(host, "Turn on Ace") !== undefined)
    expect(button(host, "Ace").disabled).toBe(true)
    expect(host.querySelector("details")?.open).toBe(true)
    expect(host.querySelector("details")?.textContent).toContain("$0 authorization, not a purchase or subscription")
    expect(host.querySelector("details")?.textContent).toContain(
      "processing fee is disclosed separately before payment",
    )
    button(host, "Turn on Ace").click()
    expect(state.links).toHaveLength(1)
    expect(state.links[0]).toContain("billing")
    expect(state.writes).toEqual([])
  })

  test("redacted member balances stay private while verified managed access remains selectable", async () => {
    const { host } = await mount({ ...funded, balanceRedacted: true, balanceUsd: null, billingMode: "byok" })
    await ready(() => host.textContent?.includes("Private to admins") === true)
    expect(host.querySelector("dd")?.textContent).toBe("Private to admins")
    expect(button(host, "Ace").disabled).toBe(false)
    expect(host.textContent).not.toContain("$778.16")
  })

  test("signed-out users see sign-in and cannot select purchased model access", async () => {
    const { host, state } = await mount({
      ...funded,
      signedIn: false,
      balanceUsd: null,
      aceEnabled: false,
      managedUnlocked: false,
    })
    await ready(() => button(host, "Sign in") !== undefined)
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Sign in required")
    expect(host.querySelector("dd")?.textContent).toBe("Sign in to view")
    expect(button(host, "Ace").disabled).toBe(true)
    expect(host.querySelector("details")?.open).toBe(false)
    expect(state.writes).toEqual([])
  })

  test("shows the stored account summary at once and swaps in the background refresh when announced", async () => {
    const { host, state } = await mount({ ...funded, balanceUsd: 50, refreshing: true, refreshedAt: 1_700_000_000_000 })
    // The stored values render immediately, marked as refreshing; nothing is
    // blanked and Ace stays selectable on the last verified entitlement.
    await ready(() => host.querySelector("dd")?.textContent?.includes("$50.00") === true)
    expect(host.querySelector("dd")?.getAttribute("data-refreshing")).toBe("true")
    expect(host.querySelector("dd")?.textContent).toContain("Refreshing…")
    expect(host.querySelector('[role="status"]')?.textContent).toBe("On")
    expect(button(host, "Ace").disabled).toBe(false)
    expect(state.reads).toBe(1)
    expect(state.updated.size).toBe(1)

    // The server announces the newer summary; the surface re-reads it and
    // keeps the previous values on screen until the new ones land.
    state.wallet = { ...funded, balanceUsd: 60, refreshing: false, refreshedAt: 1_700_000_005_000 }
    for (const notify of state.updated) notify()
    await ready(() => host.querySelector("dd")?.textContent === "$60.00")
    expect(host.querySelector("dd")?.getAttribute("data-refreshing")).toBeNull()
    expect(state.reads).toBe(2)
    expect(state.errors.filter(Boolean)).toEqual([])
  })

  test("keeps the stored values on screen when the server reports a failed refresh", async () => {
    const { host, state } = await mount({
      ...funded,
      balanceUsd: 50,
      refreshing: false,
      error: "The Ace account service is unavailable. Retry when connected.",
    })
    await ready(() => host.querySelector("dd")?.textContent === "$50.00")
    expect(state.errors.at(-1)).toContain("Showing the last known account state.")
    expect(state.errors.at(-1)).toContain("unavailable")
    expect(button(host, "Ace").disabled).toBe(false)
  })

  test("a failed account refresh clears the displayed balance and Retry restores current truth", async () => {
    const { host, state } = await mount()
    await ready(() => host.textContent?.includes("$778.16") === true)
    state.unavailable = true
    window.dispatchEvent(new Event("focus"))
    await ready(() => button(host, "Retry") !== undefined)
    expect(host.textContent).not.toContain("$778.16")
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Account unavailable")
    expect(button(host, "Ace").disabled).toBe(true)
    expect(host.querySelector("details")).toBeNull()
    state.unavailable = false
    state.wallet = { ...funded, balanceUsd: 125.25 }
    button(host, "Retry").click()
    await ready(() => host.querySelector("dd")?.textContent === "$125.25")
    expect(button(host, "Ace").disabled).toBe(false)
  })

  test("a failed routing write restores the saved choice without changing authorization", async () => {
    const { host, state } = await mount()
    await ready(() => host.textContent?.includes("$778.16") === true)
    state.rejectWrite = true
    button(host, "Keys & subscriptions").click()
    await ready(() => state.errors.includes("Access preference could not be saved"))
    expect(button(host, "Ace").getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector('[role="status"]')?.textContent).toBe("On")
    expect(state.refreshes).toBe(0)
  })

  test.each(["billing", "wallet"] as const)("a delayed %s read cannot undo a newer saved preference", async (kind) => {
    const { host, state } = await mount()
    await ready(() => button(host, "Ace").disabled === false && state.billingReads === 1)
    const gate = deferred()
    if (kind === "billing") {
      state.holdBillingRead = gate.promise
      window.dispatchEvent(new Event("focus"))
      await ready(() => state.billingReads === 2)
    } else {
      state.holdWalletRead = gate.promise
      for (const notify of state.updated) notify()
      await ready(() => state.reads === 2)
    }
    button(host, "Keys & subscriptions").click()
    await ready(() => state.refreshes === 1)
    gate.resolve()
    await settle()
    expect(button(host, "Keys & subscriptions").getAttribute("aria-pressed")).toBe("true")
    expect(state.mode).toBe("byok")
    expect(state.writes).toEqual([{ llm: "byok" }])
  })

  test("focus during a routing write cannot queue a stale preference read", async () => {
    const { host, state } = await mount()
    await ready(() => button(host, "Ace").disabled === false && state.billingReads === 1)
    const commit = deferred()
    const read = deferred()
    state.holdCommit = commit.promise
    state.holdBillingRead = read.promise
    button(host, "Keys & subscriptions").click()
    await ready(() => state.writes.length === 1)
    window.dispatchEvent(new Event("focus"))
    await settle()
    commit.resolve()
    await ready(() => state.refreshes === 1)
    read.resolve()
    await settle()
    expect(state.billingReads).toBe(1)
    expect(button(host, "Keys & subscriptions").getAttribute("aria-pressed")).toBe("true")
    expect(state.mode).toBe("byok")
  })

  test.each([false, true])(
    "an old account's write completion cannot change the new account (rejected=%s)",
    async (rejected) => {
      const { host, state } = await mount()
      await ready(() => button(host, "Ace").disabled === false && state.billingReads === 1)
      const gate = deferred()
      state.holdWrite = gate.promise
      state.rejectWrite = rejected
      button(host, "Keys & subscriptions").click()
      await ready(() => state.writes.length === 1)
      state.wallet = { ...funded, balanceUsd: 9, billingMode: "managed" }
      // Distinct preferences catch both stale success and rollback paths.
      state.mode = rejected ? "byok" : "managed"
      window.dispatchEvent(new Event("openscience:account-changed"))
      await ready(() => host.querySelector("dd")?.textContent === "$9.00")
      const choice = rejected ? "Keys & subscriptions" : "Ace"
      expect(button(host, choice).getAttribute("aria-pressed")).toBe("true")
      expect(button(host, choice).disabled).toBe(false)
      gate.resolve()
      await settle()
      expect(button(host, choice).getAttribute("aria-pressed")).toBe("true")
      expect(state.errors.filter(Boolean)).toEqual([])
      expect(state.refreshes).toBe(0)
    },
  )
})
