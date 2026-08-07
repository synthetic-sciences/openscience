import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

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
  server.ssrLoadModule("/src/atlas/ComputeSurface.tsx") as Promise<typeof import("./ComputeSurface")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []
type Mounted = { kernels: number; jobs: number }

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

const child = (name: keyof Mounted, mounted: Mounted) => () => {
  mounted[name]++
  const panel = document.createElement("section")
  panel.dataset.computeChild = name
  panel.textContent = `${name} content`
  return panel
}

const request = (status: Array<"running" | "succeeded"> = []) =>
  Object.assign(
    async () =>
      Response.json(
        status.map((value, index) => ({
          id: `job_${index}`,
          status: value,
        })),
      ),
    { url: () => "http://localhost/settings/compute/jobs" },
  )

describe("compute surface", () => {
  test("defaults to Kernels and does not mount Jobs until selected", async () => {
    const mounted = { kernels: 0, jobs: 0 }
    const host = mount(() =>
      subject.ComputeSurface({
        strip: () => document.createElement("section"),
        kernels: child("kernels", mounted),
        jobs: child("jobs", mounted),
        request: request(),
      }),
    )
    const kernels = host.querySelector<HTMLButtonElement>('[role="tab"][data-compute-tab="kernels"]')
    const jobs = host.querySelector<HTMLButtonElement>('[role="tab"][data-compute-tab="jobs"]')

    expect(host.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Compute views")
    expect(kernels?.getAttribute("aria-selected")).toBe("true")
    expect(jobs?.getAttribute("aria-selected")).toBe("false")
    expect(host.querySelector('[data-compute-child="kernels"]')).not.toBeNull()
    expect(host.querySelector('[data-compute-child="jobs"]')).toBeNull()
    expect(mounted).toEqual({ kernels: 1, jobs: 0 })
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"]')
    expect(kernels?.getAttribute("aria-controls")).toBe(panel?.id)
    expect(panel?.getAttribute("aria-labelledby")).toBe(kernels?.id)

    jobs?.click()
    await Promise.resolve()

    expect(kernels?.getAttribute("aria-selected")).toBe("false")
    expect(jobs?.getAttribute("aria-selected")).toBe("true")
    expect(host.querySelector('[data-compute-child="kernels"]')).toBeNull()
    expect(host.querySelector('[data-compute-child="jobs"]')).not.toBeNull()
    expect(mounted).toEqual({ kernels: 1, jobs: 1 })
    const next = host.querySelector<HTMLElement>('[role="tabpanel"]')
    expect(jobs?.getAttribute("aria-controls")).toBe(next?.id)
    expect(next?.getAttribute("aria-labelledby")).toBe(jobs?.id)
  })

  test("uses automatic arrow-key activation and focus for its tabs", async () => {
    const mounted = { kernels: 0, jobs: 0 }
    const host = mount(() =>
      subject.ComputeSurface({
        strip: () => document.createElement("section"),
        kernels: child("kernels", mounted),
        jobs: child("jobs", mounted),
        request: request(),
      }),
    )
    const kernels = host.querySelector<HTMLButtonElement>('[role="tab"][data-compute-tab="kernels"]')
    const jobs = host.querySelector<HTMLButtonElement>('[role="tab"][data-compute-tab="jobs"]')

    kernels?.focus()
    kernels?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    await Promise.resolve()

    expect(jobs?.getAttribute("aria-selected")).toBe("true")
    expect(document.activeElement).toBe(jobs)

    jobs?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    await Promise.resolve()

    expect(kernels?.getAttribute("aria-selected")).toBe("true")
    expect(document.activeElement).toBe(kernels)
  })

  test("carries the job total in the Jobs tab label", async () => {
    const mounted = { kernels: 0, jobs: 0 }
    const host = mount(() =>
      subject.ComputeSurface({
        strip: () => document.createElement("section"),
        kernels: child("kernels", mounted),
        jobs: child("jobs", mounted),
        request: request(["running", "succeeded", "running"]),
      }),
    )
    const count = await (async function wait(attempts = 20): Promise<HTMLElement | null> {
      const value = host.querySelector<HTMLElement>('[data-compute-tab="jobs"] .compute-surface__count')
      if (value?.textContent === "3" || !attempts) return value
      await Bun.sleep(10)
      return wait(attempts - 1)
    })()

    // The label states how many runs are here, not how many are moving — a
    // total is what a glance at a tab wants, and the running ones are already
    // legible in the list by their status dots.
    expect(count?.textContent).toBe("3")
    // Read aloud with a unit, because "Jobs 3" alone is ambiguous.
    const tab = host.querySelector('[data-compute-tab="jobs"]')
    expect(tab?.textContent).toContain("3 jobs")
    expect(count?.getAttribute("aria-hidden")).toBe("true")
    expect(mounted).toEqual({ kernels: 1, jobs: 0 })
  })

  test("does not run the heavyweight jobs refresh at the live-view cadence while Kernels is selected", async () => {
    const mounted = { kernels: 0, jobs: 0 }
    const calls = { count: 0 }
    const host = mount(() =>
      subject.ComputeSurface({
        strip: () => document.createElement("section"),
        kernels: child("kernels", mounted),
        jobs: child("jobs", mounted),
        request: Object.assign(
          async () => {
            calls.count++
            return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } })
          },
          { url: () => "http://localhost/settings/compute/jobs" },
        ),
      }),
    )
    await Bun.sleep(2_700)

    expect(calls.count).toBe(1)
    expect(host.querySelector('[data-compute-child="kernels"]')).not.toBeNull()
  })

  test("contains no unavailable or transport-facing product copy", () => {
    const source = readFileSync(fileURLToPath(new URL("./ComputeSurface.tsx", import.meta.url)), "utf8")

    expect(source).not.toContain("Terminal")
    expect(source).not.toContain("Atlas Compute")
    expect(source).not.toContain("OpenRouter")
    expect(source).not.toContain("provider")
  })

  test("leaves research job creation to the agent in the product surface", () => {
    const source = readFileSync(fileURLToPath(new URL("./ComputeSurface.tsx", import.meta.url)), "utf8")

    expect(source).toContain("manual={false}")
  })

  test("marks the selected tab with an underline rather than a filled shape", () => {
    const css = readFileSync(fileURLToPath(new URL("./ComputeSurface.css", import.meta.url)), "utf8")

    // Type on a hairline, not a pill group.
    expect(css).toMatch(/\.compute-surface__tabs\s*\{[^}]*border-bottom: 1px solid var\(--color-border\)/s)
    // origin/main's compute surface sets nothing in capitals and keeps
    // letter-spacing only as negative tracking on a heading, so neither
    // appears here either.
    expect(css).not.toContain("text-transform: uppercase")
    expect(css).not.toMatch(/letter-spacing: 0\.\d/)
    // ...but absence is not enough, and asserting only absence is what let the
    // ledger keep shouting while this test passed. atlas.css sets uppercase and
    // 0.05em tracking on `.kernel-card__metric span`, and the cascade resolves
    // per property, so the base declarations win against a rule that simply
    // omits them. They have to be turned off by name.
    const base = readFileSync(fileURLToPath(new URL("../styles/atlas.css", import.meta.url)), "utf8")
    expect(base).toMatch(/\.kernel-card__metric span\s*\{[^}]*text-transform: uppercase/s)
    expect(css).toMatch(/\.compute-surface \.kernel-card__metric span\s*\{[^}]*text-transform: none/s)
    expect(css).toMatch(/\.compute-surface \.kernel-card__metric span\s*\{[^}]*letter-spacing: 0;/s)
    // No face named on this surface: origin/main puts the whole app on one sans
    // face, and every label here inherits it rather than naming a second token
    // that could drift from it. `font-family: inherit` is the one allowed form.
    expect(css).not.toContain("--font-code")
    expect(css.match(/font-family:[^;]*/g) ?? []).toEqual(["font-family: inherit"])
    // The one solid terracotta on this surface belongs to the primary action,
    // so selection is an underline drawn in the brand colour instead.
    expect(css).toMatch(
      /\.compute-surface__tab\[data-active="true"\]\s*\{[^}]*box-shadow: inset 0 -2px 0 var\(--surface-brand-base\)/s,
    )
    expect(css).toMatch(/\.compute-surface__tab\[data-active="true"\]\s*\{[^}]*background: none/s)
    // The count joins its label as one token of type rather than sitting apart.
    expect(css).toMatch(/\.compute-surface__count::before\s*\{[^}]*content: "·"/s)
    // No hardcoded colour: the app ships 16 themes.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })

  test("renders the host strip above the tablist", () => {
    const host = mount(() =>
      subject.ComputeSurface({
        strip: () => {
          const strip = document.createElement("section")
          strip.dataset.computeChild = "strip"
          return strip
        },
        kernels: child("kernels", { kernels: 0, jobs: 0 }),
        jobs: child("jobs", { kernels: 0, jobs: 0 }),
        request: request(),
      }),
    )
    const surface = host.querySelector(".compute-surface")
    const children = [...(surface?.children ?? [])]
    const strip = children.findIndex((element) => element.matches('[data-compute-child="strip"]'))
    const tabs = children.findIndex((element) => element.matches('[role="tablist"]'))

    expect(strip).toBe(0)
    expect(tabs).toBeGreaterThan(strip)
  })
  test("does not poll the jobs route itself while the jobs panel is mounted", () => {
    const source = readFileSync(fileURLToPath(new URL("./ComputeSurface.tsx", import.meta.url)), "utf8")
    // Two polls of the same route at different intervals, for the same number.
    expect(source).toContain('if (state.tab !== "jobs") void refresh()')
    expect(source).toContain('onTotalChange={(count) => setState("jobs", count)}')
  })
  test("carries state colour on the dot, never on the word", () => {
    const css = readFileSync(fileURLToPath(new URL("./ComputeSurface.css", import.meta.url)), "utf8")

    // Colouring the word means setting a hue on a 12% tint of itself. That
    // works on a dark ground, where the tint darkens it, and collapses on a
    // light one, where the tint is near-white and the hue has nothing to
    // separate from — measured across all shipped themes it fell to 1.0:1 on
    // vesper/light and sat under AA on nearly every light variant. The dot
    // carries the colour instead, at a size where contrast is not what makes
    // it legible.
    for (const tone of ["active", "pending", "danger"]) {
      const rule = css.match(new RegExp(`\\.kernel-card__state\\[data-tone="${tone}"\\] \\{[^}]*\\}`, "s"))?.[0]
      expect(rule).toBeDefined()
      expect(rule).not.toMatch(/color:/)
      expect(rule).toContain("background: color-mix")
      expect(css).toContain(`.kernel-card__state[data-tone="${tone}"] .kernel-card__state-dot`)
    }
  })
})
