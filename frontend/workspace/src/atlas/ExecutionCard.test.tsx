import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { Captured, ExecutionRecord } from "./ExecutionHistoryAPI"

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
  server.ssrLoadModule("/src/atlas/ExecutionCard.tsx") as Promise<typeof import("./ExecutionCard")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const available = <T,>(value: T): Captured<T> => ({ status: "available", value })
const run: ExecutionRecord = {
  id: "execution-7",
  session_id: "ses_current",
  sequence: 7,
  status: "succeeded",
  language: "python",
  code: available("summary = df.describe()"),
  environment: {
    name: available("project environment"),
    interpreter: available({ name: "Python", binary: "/usr/bin/python3", version: available("3.12") }),
    kernel_id: available("runtime-private"),
    incarnation: available(2),
    restart_boundary: true,
  },
  timing: {
    created_at: available("2026-08-12T10:00:00.000Z"),
    started_at: available("2026-08-12T10:00:00.000Z"),
    completed_at: available("2026-08-12T10:00:01.200Z"),
    duration_ms: available(1_200),
  },
  result: {
    summary: "Dataset summary generated",
    stdout: "rows=418",
    stderr: "",
    error: "",
    output_count: 1,
  },
  resources: available({ memory_bytes: 42_000_000, cpu_percent: 110 }),
  files: [{ path: "summary.csv", size: 2_400, sha256: "a".repeat(64) }],
  artifacts: [{ id: "artifact-1", label: "Summary table", kind: "csv" }],
  provenance_id: "provenance-private",
}

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

describe("execution activity card", () => {
  test("leads with the readable result and keeps code, logs, files, and provenance collapsed", () => {
    const host = mount(() => subject.ExecutionCard({ run }))
    const card = host.querySelector<HTMLElement>(".execution-card")!
    const disclosures = Array.from(card.querySelectorAll<HTMLDetailsElement>("details"))

    expect(card.querySelector(".activity-card__identity")?.textContent).toContain("Dataset summary generated")
    expect(card.querySelector(".activity-card__status")).toBeNull()
    expect(card.querySelector(".kernel-card__copy")?.textContent).toContain("Run 7 · 1.2 s")
    expect(disclosures.map((item) => item.querySelector("summary")?.textContent)).toEqual([
      "Code",
      "Logs",
      "Files",
      "Run details",
    ])
    expect(disclosures.every((item) => item.open === false)).toBe(true)
    expect(card.querySelector('[data-mono="true"]')?.textContent).toContain("provenance-private")
  })
})
