import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import type { Platform } from "@/context/platform"
import { createTestServer } from "../../../test/vite"

const server = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [fixture, controllers, web] = await Promise.all([
  server.ssrLoadModule("/src/components/settings/startup-update.fixture.tsx") as Promise<
    typeof import("./startup-update.fixture")
  >,
  server.ssrLoadModule("/src/components/settings/update-controller.ts") as Promise<
    typeof import("./update-controller")
  >,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])

const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

/** A desktop platform that has found 2.0.127. `staging` is what a packaged
 * macOS app has and every other build does not. */
function platform(staging: boolean) {
  const opened: string[] = []
  const value: Platform = {
    platform: "desktop",
    openLink: (url) => opened.push(url),
    async restart() {},
    back() {},
    forward() {},
    async notify() {},
    async checkUpdate() {
      return { updateAvailable: true, version: "2.0.127" }
    },
  }
  if (staging) {
    value.updateState = async () => ({ phase: "idle" })
    value.stageUpdate = async () => ({ phase: "downloading", version: "2.0.127" })
    value.applyUpdate = async () => ({ phase: "restarting", version: "2.0.127" })
    value.cancelUpdate = async () => ({ phase: "idle" })
  }
  return { value, opened }
}

async function mount(staging: boolean) {
  const subject = platform(staging)
  // The controller is shared per platform, so the offer the component paints
  // is the one this check found.
  await controllers.updateController(subject.value).check()
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(fixture.createStartupUpdateFixture(subject.value), host))
  return { ...subject, host }
}

const buttons = (host: HTMLElement) => Array.from(host.querySelectorAll("button")).map((button) => button.textContent)

describe("launch update notice", () => {
  test("offers one press on an installation that can stage the update", async () => {
    const { host } = await mount(true)

    expect(host.querySelector(".startup-update")?.textContent).toContain(
      "One press downloads and verifies the signed update",
    )
    expect(buttons(host)).toContain("Download and restart")
  })

  test("offers the installer, and says so, where nothing can be staged", async () => {
    const { host, opened } = await mount(false)

    const notice = host.querySelector(".startup-update")
    expect(notice?.textContent).toContain("OpenScience 2.0.127 is available")
    expect(notice?.textContent).not.toContain("One press")
    expect(buttons(host)).toContain("Download installer")
    expect(buttons(host)).not.toContain("Download and restart")

    const installer = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Download installer",
    )
    installer?.click()

    expect(opened).toEqual(["https://github.com/synthetic-sciences/OpenScience/releases"])
  })
})

describe("Customize → General update row", () => {
  test("describes the same offer as the notice, for its own button", async () => {
    const subject = platform(true)
    await controllers.updateController(subject.value).check()
    const host = document.createElement("div")
    document.body.append(host)
    cleanups.push(web.render(fixture.createGeneralFixture(subject.value), host))

    const row = Array.from(host.querySelectorAll(".settings-row")).find((element) =>
      element.textContent?.includes("OpenScience 2.0.127 is available"),
    )
    expect(row?.textContent).toContain(
      "OpenScience 2.0.127 is available. Download the signed update and restart when you are ready.",
    )
    // The restart is a second press here, so the row never promises one press.
    expect(row?.textContent).not.toContain("One press")
    expect(buttons(host)).toContain("Download 2.0.127")
  })
})
