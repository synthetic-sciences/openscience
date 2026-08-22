import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

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
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/pages/project-availability.tsx") as Promise<typeof import("./project-availability")>,
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

describe("project availability recovery", () => {
  test("recognizes only a confirmed stale project directory", () => {
    expect(
      subject.missingProject({
        name: "ProjectStaleError",
        data: { reason: "missing_directory", directory: "/research/CERBench" },
      }),
    ).toEqual({ directory: "/research/CERBench" })
    expect(subject.missingProject({ response: { status: 410 } })).toEqual({})
    expect(subject.missingProject({ name: "ProjectUnknownError", data: { projectID: "prj_unknown" } })).toBeUndefined()
    expect(subject.missingProject(new Error("Failed to fetch"))).toBeUndefined()
  })

  test("offers safe recovery without suggesting another folder", () => {
    const actions: string[] = []
    const host = mount(() =>
      subject.ProjectUnavailable({
        directory: "/research/CERBench",
        onBack: () => actions.push("back"),
        onRemove: () => actions.push("remove"),
      }),
    )

    expect(host.querySelector("h1")?.textContent).toBe("This project folder can’t be found")
    expect(host.textContent).toContain("It won’t recreate the folder or switch this session to another location.")
    expect(host.textContent).toContain("/research/CERBench")
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Back to Projects", "Remove from home"])
    buttons.forEach((button) => button.click())
    expect(actions).toEqual(["back", "remove"])
  })
})
