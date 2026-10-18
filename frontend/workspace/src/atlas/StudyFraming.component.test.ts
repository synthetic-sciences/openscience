import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule("/src/atlas/StudyFraming.tsx")) as typeof import("./StudyFraming")
const cleanups: Array<() => void> = []

function mount(reject = false) {
  const state = {
    study: { id: "study_test", question: "Does momentum help?", hypothesis: "It converges sooner." },
    writes: [] as { question: string; hypothesis: string }[],
    reject,
  }
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        subject.StudyFraming({
          study: state.study,
          save: async (input) => {
            state.writes.push(input)
            if (state.reject) throw new Error("fixture unavailable")
            Object.assign(state.study, input)
          },
        }),
      host,
    ),
  )
  return { state, host }
}
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text))!
const settle = async () => {
  await Bun.sleep(20)
}
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("question and hypothesis can be edited and saved separately from purpose", async () => {
  const { state, host } = mount()
  expect(host.textContent).toContain("Does momentum help?")
  button(host, "Edit").click()
  const input = host.querySelectorAll("textarea")[1]
  input.value = "  Momentum reaches the same loss sooner.  "
  input.dispatchEvent(new Event("input", { bubbles: true }))
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await settle()
  expect(state.writes).toEqual([
    { question: "Does momentum help?", hypothesis: "Momentum reaches the same loss sooner." },
  ])
  expect(host.querySelector("form")).toBeNull()
})

test("failed saves preserve the draft and allow retry; cancelling performs no save", async () => {
  const { state, host } = mount(true)
  button(host, "Edit").click()
  const input = host.querySelector("textarea")!
  input.value = "A revised question"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await settle()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Please retry")
  expect(host.querySelector("textarea")?.value).toBe("A revised question")
  expect(state.study.question).toBe("Does momentum help?")
  button(host, "Cancel").click()
  expect(state.writes).toHaveLength(1)
  expect(host.querySelector("form")).toBeNull()
})
