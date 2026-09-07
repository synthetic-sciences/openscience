import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  configFile: false,
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const subject = (await vite.ssrLoadModule("/src/data/DataTableView.tsx")) as typeof import("./DataTableView")
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const core = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const cleanups: Array<() => void> = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
afterAll(() => vite.close())

test.each([
  { format: "csv" as const, text: "sample,value\nA,4\nB,\nC,8\nD,   \n" },
  { format: "tsv" as const, text: "sample\tvalue\nA\t4\nB\t\nC\t8\nD\t   \n" },
  { format: "json" as const, text: '[{"value":4},{"value":null},{"value":8},{},{"value":"   "}]' },
])("$format histogram excludes missing values from the same population as its summary", (input) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () => core.createComponent(subject.DataTableView, { ...input, name: `measurements.${input.format}` }),
      host,
    ),
  )
  const button = host.querySelector<HTMLButtonElement>('[data-action="table-plot"]')!
  expect(button.disabled).toBe(false)
  button.click()
  const bins = Array.from(host.querySelectorAll("svg rect title"), (element) =>
    Number(element.textContent?.split(" ")[0]),
  )
  expect(host.querySelector('[aria-label="Distribution summary"]')?.textContent).toBe("N 2Min 4Mean 6Max 8")
  expect(bins.reduce((sum, count) => sum + count, 0)).toBe(2)
  expect(bins[0]).toBe(1)
  expect(bins.at(-1)).toBe(1)
})

test("a genuine zero remains in the distribution", () => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () => core.createComponent(subject.DataTableView, { text: "value\n0\n4\n8\n", format: "csv", name: "zeros.csv" }),
      host,
    ),
  )
  host.querySelector<HTMLButtonElement>('[data-action="table-plot"]')!.click()
  const bins = Array.from(host.querySelectorAll("svg rect title"), (element) =>
    Number(element.textContent?.split(" ")[0]),
  )
  expect(host.querySelector('[aria-label="Distribution summary"]')?.textContent).toBe("N 3Min 0Mean 4Max 8")
  expect(bins.reduce((sum, count) => sum + count, 0)).toBe(3)
  expect(bins[0]).toBe(1)
})
