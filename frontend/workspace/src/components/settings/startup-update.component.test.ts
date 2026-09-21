import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import type { Platform } from "@/context/platform"
import { createTestServer } from "../../../test/vite"
import type { CommandLineStatus } from "./command-line-tool"
import type { CommandLineServices } from "../settings-general"

// happy-dom replaces the global Response; Bun's HTTP server needs its native one.
const Response = (await Bun.fetch("data:text/plain,")).constructor as typeof globalThis.Response

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

/** A real local server for the command-line row's `GET /settings/cli` — the
 * General panel renders that row too on a desktop platform, the same server
 * shape #663's own `command-line-tool.test.tsx` serves it against. */
function serveCommandLine(): { services: CommandLineServices; stop: () => void } {
  const home = "/Users/ada"
  const status: CommandLineStatus = {
    home,
    directory: `${home}/.openscience/bin`,
    path: `${home}/.openscience/bin/openscience`,
    exists: true,
    current: true,
    ours: true,
    onPath: true,
    shell: "zsh",
    line: `export PATH=${home}/.openscience/bin:$PATH`,
    installable: true,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/settings/cli") return Response.json(status)
      return Response.json({ error: "not_found", path: url.pathname }, { status: 404 })
    },
  })
  return { services: { sdk: { url: server.url.origin } }, stop: () => void server.stop(true) }
}

describe("launch update notice", () => {
  test("offers one press on an installation that can stage the update", async () => {
    const { host } = await mount(true)

    const notice = host.querySelector(".startup-update")
    expect(notice?.textContent).toContain("One press downloads and verifies the signed update")
    expect(notice?.textContent).not.toContain("releases page")
    expect(buttons(host)).toContain("Download and restart")
  })

  test("offers the installer, and says so, where nothing can be staged", async () => {
    const { host, opened } = await mount(false)

    const notice = host.querySelector(".startup-update")
    expect(notice?.textContent).toContain("OpenScience 2.0.127 is available")
    expect(notice?.textContent).toContain("Get the installer from the releases page and reinstall to update.")
    // Nothing downloads in the app and there is no restart step to choose.
    expect(notice?.textContent).not.toContain("One press")
    expect(notice?.textContent).not.toContain("in the background")
    expect(notice?.textContent).not.toContain("restart")
    expect(buttons(host)).toEqual(expect.arrayContaining(["Download installer", "Later", "What's new"]))
    expect(buttons(host)).not.toContain("Download and restart")

    const installer = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Download installer",
    )
    installer?.click()

    expect(opened).toEqual(["https://github.com/synthetic-sciences/OpenScience/releases"])
  })
})

/** Customize → General against a platform that has found 2.0.127, and the row
 * that describes the offer. */
async function mountGeneral(staging: boolean) {
  const subject = platform(staging)
  // happy-dom's fetch cannot parse a response from Bun's own HTTP server
  // (HPE_UNEXPECTED_CONTENT_LENGTH); the command-line row's request needs
  // Bun's fetch, the same swap #663's own command-line-tool.test.tsx makes.
  subject.value.fetch = Bun.fetch as unknown as typeof fetch
  await controllers.updateController(subject.value).check()
  const { services, stop } = serveCommandLine()
  cleanups.push(stop)
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(fixture.createGeneralFixture(subject.value, services), host))
  const row = Array.from(host.querySelectorAll(".settings-row")).find((element) =>
    element.textContent?.includes("OpenScience 2.0.127 is available"),
  )
  return { ...subject, host, row }
}

describe("Customize → General update row", () => {
  test("describes the same offer as the notice, for its own button", async () => {
    const { host, row } = await mountGeneral(true)

    expect(row?.textContent).toContain(
      "OpenScience 2.0.127 is available. Download the signed update and restart when you are ready.",
    )
    // The restart is a second press here, so the row never promises one press.
    expect(row?.textContent).not.toContain("One press")
    expect(row?.textContent).not.toContain("releases page")
    expect(buttons(host)).toContain("Download 2.0.127")
  })

  test("points at the releases page where nothing can be staged", async () => {
    const { host, row, opened } = await mountGeneral(false)

    expect(row?.textContent).toContain(
      "OpenScience 2.0.127 is available. Get the installer from the releases page and reinstall to update.",
    )
    expect(row?.textContent).not.toContain("in the background")
    expect(row?.textContent).not.toContain("restart")

    const installer = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Download installer",
    )
    installer?.click()

    expect(opened).toEqual(["https://github.com/synthetic-sciences/OpenScience/releases"])
  })
})
