import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { ProjectCreateInput } from "./dialog-create-project"

const style = fileURLToPath(new URL("./dialog-create-project.css", import.meta.url))
const cleanups: Array<() => void> = []
const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, dialogs, web] = await Promise.all([
  server.ssrLoadModule("/src/components/dialog-create-project.tsx") as Promise<
    typeof import("./dialog-create-project")
  >,
  server.ssrLoadModule("@synsci/ui/context/dialog") as Promise<typeof import("@synsci/ui/context/dialog")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

function Harness(props: {
  onCreate: (input: ProjectCreateInput) => Promise<void>
  onChooseSources: () => void
  sources?: string[]
}): JSX.Element {
  const dialog = dialogs.useDialog()
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = "New project"
  button.addEventListener("click", () => {
    dialog.show(() =>
      subject.DialogCreateProject({
        onCreate: props.onCreate,
        onChooseSources: props.onChooseSources,
        sources: props.sources,
      }),
    )
  })
  return button
}

describe("DialogCreateProject", () => {
  test("submits the user name through the create action", async () => {
    const inputs: ProjectCreateInput[] = []
    const host = mount(() =>
      dialogs.DialogProvider({
        get children() {
          return Harness({
            onCreate: async (input) => {
              inputs.push(input)
            },
            onChooseSources: () => {},
          })
        },
      }),
    )

    host.querySelector<HTMLButtonElement>("button")?.click()
    expect(document.body.textContent).toContain("optionally connect folders")
    const input = document.body.querySelector<HTMLInputElement>('input[name="name"]')
    if (input) {
      input.value = "Cell atlas"
      input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    }
    const create = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Create project",
    )
    create?.click()
    await Promise.resolve()

    expect(inputs).toEqual([{ name: "Cell atlas", sources: [] }])
  })

  test("opens the source-folder chooser from the primary source area", () => {
    const choices: string[] = []
    const host = mount(() =>
      dialogs.DialogProvider({
        get children() {
          return Harness({
            onCreate: async () => {},
            onChooseSources: () => choices.push("choose"),
          })
        },
      }),
    )

    host.querySelector<HTMLButtonElement>("button")?.click()
    const action = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Add source folders"),
    )
    action?.click()

    expect(choices).toEqual(["choose"])
  })

  test("creates durable read-write source connections", async () => {
    const inputs: ProjectCreateInput[] = []
    const host = mount(() =>
      dialogs.DialogProvider({
        get children() {
          return Harness({
            onCreate: async (input) => {
              inputs.push(input)
            },
            onChooseSources: () => {},
            sources: ["/Users/aayam/kras-speedrun"],
          })
        },
      }),
    )

    host.querySelector<HTMLButtonElement>("button")?.click()
    const input = document.body.querySelector<HTMLInputElement>('input[name="name"]')
    if (input) {
      input.value = "KRAS study"
      input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    }
    expect(document.body.textContent).toContain("kras-speedrun")
    expect(document.body.textContent).toContain("/Users/aayam/kras-speedrun")
    const create = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Create project",
    )
    create?.click()
    await Promise.resolve()

    expect(inputs).toEqual([
      {
        name: "KRAS study",
        sources: [{ path: "/Users/aayam/kras-speedrun", access: "write" }],
      },
    ])
  })

  test("uses one quiet responsive surface hierarchy", async () => {
    const css = await Bun.file(style).text()

    expect(css).toContain(".project-create__source-empty")
    expect(css).toContain("background: transparent")
    expect(css).toContain("font-size: 0.875rem")
    expect(css).toContain("@media (pointer: coarse)")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).not.toContain("text-transform")
  })
})
