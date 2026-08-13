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

    expect(card.querySelector(".activity-card__identity strong")?.textContent).toBe("Exploration task")
    expect(card.querySelector(".activity-card__status")).toBeNull()
    expect(card.querySelector(".activity-card__summary")?.textContent).toBe("Agent · 4 actions completed · 800ms")
    expect(card.querySelector("details")).toBeNull()
    expect(card.textContent).not.toContain("child:one")
  })

  test("turns a request URL into a readable endpoint without exposing its query payload", () => {
    const url = "https://api.gdc.cancer.gov/files?filters=%7B%22op%22%3A%22and%22%7D"
    const activity: ObservableResearchActivity = {
      id: "source:one",
      at: 1,
      kind: "source",
      label: url,
      detail: "Web source · 1.3s",
      status: "completed",
    }
    const host = mount(() => subject.ResearchActivityCard({ activity }))
    const label = host.querySelector<HTMLElement>(".activity-card__identity strong")!

    expect(label.textContent).toBe("api.gdc.cancer.gov / files")
    expect(label.title).toBe(url)
    expect(label.getAttribute("aria-label")).toBe("api.gdc.cancer.gov / files")
    expect(label.getAttribute("aria-label")).not.toContain("filters")
    expect(label.textContent).not.toContain("filters")
    expect(subject.researchLabel("Scientific database search")).toBe("Scientific database search")
  })

  test("names a terminal error truthfully and keeps provided failure detail inspectable", () => {
    const activity: ObservableResearchActivity = {
      id: "search:failed",
      at: 1,
      kind: "search",
      label: "Scientific database search",
      detail: "Scientific search · request timed out · 2.1s",
      status: "error",
    }
    const host = mount(() => subject.ResearchActivityCard({ activity }))
    const disclosure = host.querySelector<HTMLDetailsElement>(".research-activity-card__failure")

    expect(host.querySelector(".activity-card__status")?.textContent).toBe("Failed")
    expect(host.textContent).not.toContain("Needs attention")
    expect(host.querySelector(".activity-card__summary")?.textContent).toBe("Search")
    expect(disclosure?.open).toBe(false)
    expect(disclosure?.querySelector("summary")?.textContent).toBe("Failure details")
    expect(disclosure?.querySelector(".activity-disclosure__note")?.textContent).toBe(activity.detail)
  })

  test("shows bounded child work as partial rather than complete", () => {
    const activity: ObservableResearchActivity = {
      id: "child:partial",
      at: 1,
      kind: "agent",
      label: "Execution task",
      detail: "16 actions before the limit · 3m",
      status: "partial",
    }
    const host = mount(() => subject.ResearchActivityCard({ activity }))

    expect(host.querySelector(".activity-card__status")?.textContent).toBe("Partial")
    expect(host.querySelector(".activity-card__summary")?.textContent).toBe("Agent · 16 actions before the limit · 3m")
  })
})
