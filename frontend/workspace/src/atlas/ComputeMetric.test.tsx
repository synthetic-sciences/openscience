import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
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
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const core = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await server.ssrLoadModule("/src/atlas/ComputeMetric.tsx")) as typeof import("./ComputeMetric")
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

describe("compute metric trace", () => {
  test("advances only when its parent reports a successful inventory sample", async () => {
    const [value, setValue] = core.createSignal<number | undefined>(25)
    const [sample, setSample] = core.createSignal(0)
    const host = document.createElement("div")
    document.body.append(host)
    cleanups.push(
      web.render(
        () =>
          core.createComponent(subject.ComputeMetric, {
            metric: "cpu",
            label: "0.3 cores",
            get value() {
              return value()
            },
            get sample() {
              return sample()
            },
          }),
        host,
      ),
    )
    const points = () => host.querySelector("polyline")?.getAttribute("points")?.split(" ") ?? []

    await Promise.resolve()
    expect(points()).toHaveLength(2)

    // Identical readings still represent real successful polls.
    setSample(1)
    await Promise.resolve()
    setSample(2)
    await Promise.resolve()
    expect(points()).toHaveLength(3)

    // An unavailable reading does not add a synthetic zero or flat sample.
    setValue(undefined)
    setSample(3)
    await Promise.resolve()
    expect(points()).toHaveLength(3)
  })
})
