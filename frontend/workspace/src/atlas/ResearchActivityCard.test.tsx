import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { ObservableResearchActivity } from "./session-trace-model"

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
  server.ssrLoadModule("/src/atlas/ResearchActivityCard.tsx") as Promise<typeof import("./ResearchActivityCard")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

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

describe("research activity card", () => {
  test("uses a readable action, calm status, and no hidden runtime metadata", () => {
    const activity: ObservableResearchActivity = {
      id: "child:one",
      at: 1,
      kind: "agent",
      label: "Exploration task",
      detail: "4 actions completed · 800ms",
      status: "completed",
    }
    const host = mount(() => subject.ResearchActivityCard({ activity }))
    const card = host.querySelector<HTMLElement>(".research-activity-card")!

    expect(card.querySelector(".activity-card__kind")?.textContent).toBe("Agent")
    expect(card.querySelector(".activity-card__identity strong")?.textContent).toBe("Exploration task")
    expect(card.querySelector(".activity-card__status")?.textContent).toBe("Completed")
    expect(card.querySelector(".activity-card__summary")?.textContent).toBe("4 actions completed · 800ms")
    expect(card.querySelector("details")).toBeNull()
    expect(card.textContent).not.toContain("child:one")
  })
})
