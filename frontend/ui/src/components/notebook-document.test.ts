import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../../workspace/test/vite"
import solid from "vite-plugin-solid"

// Use jsdom here: the real Markdown sanitizer needs live NodeIterator semantics.
const vite = await createServer({
  root: fileURLToPath(new URL("../../../workspace", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const marked = (await vite.ssrLoadModule("@synsci/ui/context/marked")) as typeof import("@synsci/ui/context/marked")
const subject = (await vite.ssrLoadModule(
  "/src/atlas/files/NotebookDocument.tsx",
)) as typeof import("../../../workspace/src/atlas/files/NotebookDocument")
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await settle()
  expect(check()).toBe(true)
}
const mount = (props: Parameters<typeof subject.NotebookDocument>[0]) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        marked.MarkedProvider({
          get children() {
            return subject.NotebookDocument(props)
          },
        }),
      host,
    ),
  )
  return host
}
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("renders real Markdown, attachments, images, errors and isolated HTML outputs", async () => {
  const host = mount({
    name: "experiment.ipynb",
    format: "ipynb",
    text: JSON.stringify({
      nbformat: 4,
      cells: [
        {
          cell_type: "markdown",
          source: "# Experiment\n\n**Measured** output.\n\n![Attached](attachment:plot.png)",
          attachments: { "plot.png": { "image/png": "aGVsbG8=" } },
        },
        {
          cell_type: "code",
          source: "display(result)",
          execution_count: 8,
          outputs: [
            {
              output_type: "display_data",
              data: {
                "image/svg+xml": '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5" /></svg>',
                "text/plain": "<Figure>",
              },
            },
            {
              output_type: "display_data",
              data: { "text/html": "<table><tr><td>2</td></tr></table><script>window.evil=true</script>" },
            },
            { output_type: "error", ename: "ValueError", evalue: "Missing data" },
          ],
        },
      ],
    }),
  })
  await ready(() => host.querySelector("h1") !== null)
  expect(host.querySelector("h1")?.textContent).toBe("Experiment")
  expect(host.querySelector("strong")?.textContent).toBe("Measured")
  expect(host.querySelector('img[alt="Attached"]')?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=")
  expect(host.querySelector('img[alt="Cell 2 output"]')?.getAttribute("src")).toStartWith("data:image/svg+xml,")
  expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("")
  expect(host.querySelector("iframe")?.getAttribute("srcdoc")).toContain("default-src 'none'")
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("ValueError: Missing data")
  expect(host.textContent).not.toContain("<Figure>")
  expect(host.querySelector("script")).toBeNull()
})

test.each(["rmd", "qmd"])(
  "renders %s prose with authorized relative assets and keeps chunks separate",
  async (format) => {
    const opened: string[] = []
    const host = mount({
      name: `analysis.${format}`,
      format,
      text: "# Results\n\n![Plot](plots/result.png)\n\n[Data](data.csv)\n\n```{r}\nmean(x)\n```",
      resolveImage: (src) => (src === "plots/result.png" ? "http://127.0.0.1/authorized-plot" : src),
      resolveFile: (src) => (src === "data.csv" ? "/allowed/data.csv" : undefined),
      onOpenFile: (path) => opened.push(path),
    })
    await ready(() => host.querySelector("h1") !== null)
    expect(host.querySelector("h1")?.textContent).toBe("Results")
    expect(host.querySelector("img")?.getAttribute("src")).toBe("http://127.0.0.1/authorized-plot")
    host.querySelector("a")!.click()
    expect(opened).toEqual(["/allowed/data.csv"])
    expect(host.querySelector('[data-cell-type="code"] code')?.textContent).toBe("mean(x)")
  },
)
