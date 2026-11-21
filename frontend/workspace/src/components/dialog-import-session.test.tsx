import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createTestServer as createServer } from "../../test/vite"
import solid from "vite-plugin-solid"
import type { ImportApi, ImportResult, ImportSource } from "./dialog-import-session"

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
const [subject, dialogs, web] = await Promise.all([
  server.ssrLoadModule("/src/components/dialog-import-session.tsx") as Promise<
    typeof import("./dialog-import-session")
  >,
  server.ssrLoadModule("@synsci/ui/context/dialog") as Promise<typeof import("@synsci/ui/context/dialog")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const sessions = {
  claude: [
    {
      source: "claude",
      id: "c1",
      path: "/p/c1.jsonl",
      cwd: "/work/alpha",
      firstMessage: "tune the model",
      created: 1,
      modified: 3,
    },
    {
      source: "claude",
      id: "c2",
      path: "/p/c2.jsonl",
      cwd: "/work/beta",
      firstMessage: "plot results",
      created: 1,
      modified: 2,
    },
  ],
  codex: [
    {
      source: "codex",
      id: "x1",
      path: "/p/x1.jsonl",
      cwd: "/work/gamma",
      firstMessage: "fix parser",
      created: 1,
      modified: 1,
    },
  ],
} as const

function api(overrides: Partial<ImportApi> & { calls?: Array<[ImportSource, string, string]> } = {}): ImportApi {
  return {
    list: async (source) => [...sessions[source]],
    folder: async (_source, id) => ({ path: id === "c2" ? "/work/beta" : "/work/alpha", exists: id !== "c2" }),
    run: async (source, id, access) => {
      overrides.calls?.push([source, id, access])
      return { sessionID: "ses_new", outcome: "created" }
    },
    ...overrides,
  }
}

function open(props: { api: ImportApi; onImported?: (result: ImportResult) => void }) {
  const host = document.createElement("div")
  document.body.append(host)
  const Harness = (): JSX.Element => {
    const dialog = dialogs.useDialog()
    const button = document.createElement("button")
    button.textContent = "Open import"
    button.addEventListener("click", () =>
      dialog.show(() => subject.DialogImportSession({ api: props.api, onImported: props.onImported ?? (() => {}) })),
    )
    return button
  }
  cleanups.push(
    web.render(
      () =>
        dialogs.DialogProvider({
          get children() {
            return Harness()
          },
        }),
      host,
    ),
  )
  host.querySelector("button")?.click()
}

const button = (label: string) =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((item) =>
    item.textContent?.includes(label),
  )

describe("DialogImportSession", () => {
  test("renders both tabs and lists sessions", async () => {
    open({ api: api() })
    await settle()
    expect(button("Claude Code")).toBeDefined()
    expect(button("Codex")).toBeDefined()
    expect(document.body.textContent).toContain("tune the model")
    expect(document.body.textContent).toContain("plot results")
    button("Codex")?.click()
    await settle()
    expect(document.body.textContent).toContain("fix parser")
    expect(document.body.textContent).not.toContain("tune the model")
  })

  test("search filters by folder", async () => {
    open({ api: api() })
    await settle()
    const search = document.body.querySelector<HTMLInputElement>('input[name="search"]')!
    search.value = "beta"
    search.dispatchEvent(new InputEvent("input", { bubbles: true }))
    await settle()
    expect(document.body.textContent).toContain("plot results")
    expect(document.body.textContent).not.toContain("tune the model")
  })

  test("picking a session with a missing folder skips the question", async () => {
    const calls: Array<[ImportSource, string, string]> = []
    const imported: ImportResult[] = []
    open({ api: api({ calls }), onImported: (result) => imported.push(result) })
    await settle()
    button("plot results")?.click()
    await settle()
    expect(document.body.textContent).not.toContain("Connect it to this project?")
    expect(calls).toEqual([["claude", "c2", "none"]])
    expect(imported.map((item) => item.sessionID)).toEqual(["ses_new"])
  })

  test("the folder question defaults to read and write", async () => {
    const calls: Array<[ImportSource, string, string]> = []
    open({ api: api({ calls }) })
    await settle()
    button("tune the model")?.click()
    await settle()
    expect(document.body.textContent).toContain("This conversation worked in /work/alpha. Connect it to this project?")
    const selected = document.body.querySelector<HTMLInputElement>('input[name="folder-access"]:checked')
    expect(selected?.value).toBe("write")
    button("Import")?.click()
    await settle()
    expect(calls).toEqual([["claude", "c1", "write"]])
  })

  test("a copied outcome shows the separate-copy note", async () => {
    const imported: ImportResult[] = []
    open({
      api: api({ run: async () => ({ sessionID: "ses_copy", outcome: "copied", reason: "continued" }) }),
      onImported: (result) => imported.push(result),
    })
    await settle()
    button("plot results")?.click()
    await settle()
    expect(document.body.textContent).toContain(
      "Your earlier import has been continued in OpenScience, so this is a separate copy.",
    )
    button("Open session")?.click()
    expect(imported.map((item) => item.sessionID)).toEqual(["ses_copy"])
  })
})
