import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../workspace/test/vite"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../../../workspace", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const data = (await vite.ssrLoadModule("@synsci/ui/context/data")) as typeof import("../context/data")
const subject = (await vite.ssrLoadModule("@synsci/ui/message-part")) as typeof import("./message-part")
const cleanups: Array<() => void> = []

function mount(custom?: boolean) {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        data.DataProvider({
          directory: "/research",
          data: { session: [], session_status: {}, session_diff: {}, message: {}, part: {} },
          get children() {
            return web.createComponent(subject.QuestionPrompt, {
              request: {
                id: "que_1",
                sessionID: "ses_1",
                questions: [
                  {
                    header: "Subagent limit reached",
                    question: "Add to the subagent budget so it can continue?",
                    options: [
                      { label: "Add $0.20", description: "Raise the budget" },
                      { label: "Finish without it", description: "Build on the saved result" },
                    ],
                    ...(custom === undefined ? {} : { custom }),
                  },
                ],
              },
            })
          },
        }),
      host,
    ),
  )
  return host
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
afterAll(() => vite.close())

test("a question that allows no custom answer offers only its options", () => {
  const host = mount(false)
  const options = [...host.querySelectorAll('[data-slot="question-option"]')]
  expect(options.map((option) => option.querySelector('[data-slot="option-label"]')?.textContent)).toEqual([
    "Add $0.20",
    "Finish without it",
  ])
  expect(host.querySelector('[data-custom="true"]')).toBeNull()
})

test("questions offer a typed answer by default", () => {
  const host = mount()
  expect(host.querySelector('[data-custom="true"]')).not.toBeNull()
})
