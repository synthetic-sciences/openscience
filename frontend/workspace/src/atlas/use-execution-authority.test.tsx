import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../test/vite"
import solid from "vite-plugin-solid"

type Handler = (event: { properties: { status: { projectID: string }; sessionID?: string } }) => void

type TestSDK = {
  projectID: string
  request: (path: string) => Promise<Response>
  event: { on: (type: string, handler: Handler | (() => void)) => () => void }
}

declare global {
  var __executionAuthorityTestSDK: TestSDK
}

const root = fileURLToPath(new URL("../..", import.meta.url))
const vite = await createServer({
  root,
  configFile: false,
  mode: "production",
  logLevel: "silent",
  plugins: [
    {
      name: "execution-authority-test-context",
      enforce: "pre",
      resolveId(id) {
        if (id === "virtual:execution-authority-sdk") return "\0execution-authority-sdk"
        if (id === "virtual:execution-authority-router") return "\0execution-authority-router"
        if (id === "virtual:execution-authority-fixture") return "\0execution-authority-fixture"
      },
      load(id) {
        if (id === "\0execution-authority-sdk")
          return "export const useSDK = () => globalThis.__executionAuthorityTestSDK"
        if (id === "\0execution-authority-router") return 'export const useParams = () => ({ id: "ses_test" })'
        if (id === "\0execution-authority-fixture")
          return `
            import { createComponent, createEffect, Suspense } from "solid-js"
            import { render } from "solid-js/web"
            import { useExecutionAuthority } from "@/atlas/use-execution-authority"

            function Probe() {
              const authority = useExecutionAuthority("shell")
              const section = document.createElement("section")
              const session = document.createElement("span")
              const message = document.createElement("span")
              const button = document.createElement("button")
              section.dataset.authorityProbe = "true"
              session.dataset.authoritySession = "true"
              message.dataset.authorityMessage = "true"
              button.type = "button"
              button.textContent = "Run"
              section.append(session, message, button)
              createEffect(() => {
                const allowed = authority.allowed()
                section.dataset.allowed = allowed ? "true" : "false"
                session.textContent = authority.decision()?.sessionID ?? "none"
                message.textContent = authority.message()
                button.disabled = !allowed
              })
              return section
            }

            export function mountExecutionAuthorityInSuspense(fallback, host) {
              return render(
                () => createComponent(Suspense, {
                  get fallback() { return fallback() },
                  get children() { return createComponent(Probe, {}) },
                }),
                host,
              )
            }
          `
      },
    },
    solid({ ssr: false, dev: false }),
  ],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: {
    alias: [
      { find: "@/context/sdk", replacement: "virtual:execution-authority-sdk" },
      { find: "@solidjs/router", replacement: "virtual:execution-authority-router" },
      { find: /^@\//, replacement: `${root}/src/` },
    ],
    conditions: ["browser", "production"],
    dedupe: ["solid-js", "solid-js/web"],
  },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})

const fixture = (await vite.ssrLoadModule("virtual:execution-authority-fixture")) as {
  mountExecutionAuthorityInSuspense(fallback: () => Element, host: HTMLElement): () => void
}

const cleanups: Array<() => void> = []

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const decision = (allowed: boolean) => ({
  allowed,
  reason: allowed ? "allowed" : "project_untrusted",
  capability: "shell",
  projectID: "prj_test",
  sessionID: "ses_test",
})

const response = (allowed: boolean) =>
  new Response(JSON.stringify(decision(allowed)), { headers: { "content-type": "application/json" } })

describe("execution authority refresh", () => {
  test("keeps the mounted transcript boundary while a refreshed decision is pending and denies execution", async () => {
    const handlers = new Map<string, Handler | (() => void)>()
    const requests: Array<(value: Response) => void> = []
    globalThis.__executionAuthorityTestSDK = {
      projectID: "prj_test",
      request: () => new Promise<Response>((resolve) => requests.push(resolve)),
      event: {
        on(type, handler) {
          handlers.set(type, handler)
          return () => handlers.delete(type)
        },
      },
    }

    const host = document.createElement("div")
    document.body.append(host)
    const fallback = () => {
      const node = document.createElement("p")
      node.dataset.authorityFallback = "true"
      return node
    }
    cleanups.push(fixture.mountExecutionAuthorityInSuspense(fallback, host))
    await Bun.sleep(20)

    expect(requests).toHaveLength(1)
    requests.shift()?.(response(true))
    await Bun.sleep(20)

    const probe = host.querySelector("[data-authority-probe]")
    expect(probe).not.toBeNull()
    expect(probe?.getAttribute("data-allowed")).toBe("true")
    expect(host.querySelector("[data-authority-session]")?.textContent).toBe("ses_test")

    const refresh = handlers.get("project.trust.changed") as Handler
    refresh({ properties: { status: { projectID: "prj_test" } } })
    await Bun.sleep(20)

    expect(requests).toHaveLength(1)
    expect(host.querySelector("[data-authority-fallback]")).toBeNull()
    expect(host.querySelector("[data-authority-probe]")).toBe(probe)
    expect(probe?.getAttribute("data-allowed")).toBe("false")
    expect(host.querySelector("button")?.disabled).toBe(true)
    expect(host.querySelector("[data-authority-message]")?.textContent).toBe("Checking execution access…")

    requests.shift()?.(response(false))
    await Bun.sleep(20)
    expect(host.querySelector("[data-authority-fallback]")).toBeNull()
    expect(host.querySelector("[data-authority-probe]")).toBe(probe)
    expect(probe?.getAttribute("data-allowed")).toBe("false")
  })
})
