import test from "node:test"
import assert from "node:assert/strict"
import { createController } from "../public/growth/controller.js"
import {
  effectiveConsent,
  cleanEvent,
  eventForLink,
  pageLocation,
  campaignAttribution,
} from "../public/growth/policy.js"

function fixture(overrides = {}) {
  const calls = []
  const controller = createController(
    {
      production: true,
      site: "openscience",
      googleTagManagerId: "GTM-TEST123",
      identificationScript: "https://example.org/provider.js",
      ...overrides,
    },
    Object.fromEntries(
      [
        "notify",
        "googleDefaults",
        "googleConsent",
        "loadGoogle",
        "loadIdentification",
        "event",
        "clearCookies",
        "reload",
      ].map((name) => [name, (...values) => calls.push({ name, values })]),
    ),
  )
  return { controller, calls, count: (name) => calls.filter((call) => call.name === name) }
}
const consent = (categories) => effectiveConsent(categories)
const url = "https://www.openscience.sh/download"

test("initial visit and rejection load no optional scripts and send no events", () => {
  const f = fixture()
  f.controller.pageview(url)
  f.controller.track("download_click", { platform: "mac-arm64" })
  f.controller.update(consent([]))
  assert.equal(f.count("loadGoogle").length, 0)
  assert.equal(f.count("loadIdentification").length, 0)
  assert.equal(f.count("event").length, 0)
})

test("consent is queued before the container, and only the current page is measured", () => {
  const f = fixture()
  f.controller.pageview("https://www.openscience.sh/")
  f.controller.pageview(url)
  f.controller.update(consent(["analytics"]))
  const network = f.calls.filter((call) => call.name !== "notify")
  assert.deepEqual(
    network.slice(0, 3).map((call) => call.name),
    ["googleDefaults", "googleConsent", "loadGoogle"],
  )
  assert.equal(network[0].values[0].analytics_storage, "denied")
  assert.equal(network[1].values[0].analytics_storage, "granted")
  assert.equal(network[1].values[0].ad_storage, "denied")
  assert.equal(f.count("event").length, 1)
  assert.equal(f.count("event")[0].values[0].growth_page_location, url)
  f.controller.pageview(url)
  f.controller.update(consent(["analytics"]))
  assert.equal(f.count("event").length, 1)
  assert.equal(f.count("loadGoogle").length, 1)
})

test("advertising consent alone leaves analytics denied", () => {
  const f = fixture()
  f.controller.pageview(url)
  f.controller.update(consent(["advertising"]))
  assert.equal(f.count("googleConsent")[0].values[0].analytics_storage, "denied")
  assert.equal(f.count("event")[0].values[0].growth_analytics, false)
  assert.equal(f.count("event")[0].values[0].growth_advertising, true)
})

test("identification has an independent opt-in", () => {
  const f = fixture()
  f.controller.pageview(url)
  f.controller.update(consent(["identification"]))
  assert.equal(f.count("loadIdentification").length, 1)
  assert.equal(f.count("loadGoogle").length, 0)
  f.controller.update(consent(["identification"]))
  assert.equal(f.count("loadIdentification").length, 1)
})

test("withdrawal clears relevant cookies and stops later events before reload", () => {
  const f = fixture()
  f.controller.pageview(url)
  f.controller.update(consent(["analytics", "identification"]))
  f.controller.update(consent([]))
  assert.deepEqual(f.count("clearCookies")[0].values[0], ["analytics", "identification"])
  assert.equal(f.count("reload").length, 1)
  const before = f.count("event").length
  assert.equal(f.controller.track("download_click", { platform: "mac-arm64" }), false)
  f.controller.update(consent(["analytics"]))
  assert.equal(f.count("event").length, before)
  assert.equal(f.count("loadGoogle").length, 1)
})

test("preview hostnames never load vendors or submit events", () => {
  const f = fixture({ production: false })
  f.controller.pageview(url)
  f.controller.update(consent(["analytics", "advertising", "identification"]))
  assert.equal(f.count("loadGoogle").length, 0)
  assert.equal(f.count("loadIdentification").length, 0)
  assert.equal(f.count("event").length, 0)
})

test("Global Privacy Control overrides stored advertising and identification choices", () => {
  assert.deepEqual(effectiveConsent(["analytics", "advertising", "identification"], true), {
    analytics: true,
    advertising: false,
    identification: false,
  })
})

test("events reject unknown fields, free text, and forged event names", () => {
  assert.deepEqual(
    cleanEvent("download_click", {
      platform: "linux-x64",
      placement: "header",
      email: "private@example.org",
      prompt: "research",
      url: "https://example.org/?key=secret",
    }),
    { name: "download_click", properties: { placement: "header", platform: "linux-x64" } },
  )
  assert.deepEqual(cleanEvent("install_command_copy", { method: "my secret command" }), {
    name: "install_command_copy",
    properties: {},
  })
  assert.equal(cleanEvent("sign_up"), null)
  assert.equal(cleanEvent("__proto__"), null)
  assert.equal(cleanEvent("page_view", null), null)
  assert.equal(cleanEvent("page_view", []), null)
})

test("page locations omit query parameters, fragments, and sensitive-looking paths", () => {
  assert.equal(pageLocation(url + "?email=private@example.org&token=secret#private"), url)
  assert.equal(pageLocation("https://www.openscience.sh/private@example.org"), "https://www.openscience.sh/")
})

test("installer clicks are distinct from repository and contact clicks", () => {
  assert.equal(
    eventForLink(
      "https://github.com/synthetic-sciences/OpenScience/releases/latest/download/OpenScience-mac-arm64.dmg",
      url,
    ).name,
    "download_click",
  )
  assert.equal(eventForLink("https://github.com/synthetic-sciences/OpenScience", url).name, "github_click")
  assert.deepEqual(eventForLink("mailto:private@example.org?body=secret", url), {
    name: "contact_click",
    properties: { placement: "page", method: "email" },
  })
  assert.equal(eventForLink("#top", url), null)
  assert.equal(eventForLink("https://unknown.example.org/download", url), null)
})

test("campaign attribution keeps controlled campaign fields and gates advertising click IDs", () => {
  const href =
    "https://www.openscience.sh/?utm_source=google&utm_medium=cpc&utm_campaign=launch&gclid=Ad-123&email=private@example.org&token=secret"
  assert.deepEqual(campaignAttribution(href), { utm_source: "google", utm_medium: "cpc", utm_campaign: "launch" })
  assert.deepEqual(campaignAttribution(href, true), {
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "launch",
    gclid: "Ad-123",
  })
  assert.deepEqual(
    campaignAttribution("https://www.openscience.sh/?utm_campaign=private%40example.org&gclid=bad%20id", true),
    {},
  )
})

test("the imported container uses the configured site, hostname, and analytics consent", async () => {
  const { readFile } = await import("node:fs/promises")
  const config = (await import("../public/growth/config.js")).default
  const container = JSON.parse(
    await readFile(new URL("../docs/gtm-container.json", import.meta.url), "utf8"),
  ).containerVersion
  assert.equal(container.container.publicId, config.googleTagManagerId)
  assert.equal(container.tag.length, 1)
  assert.equal(container.tag[0].consentSettings.consentStatus, "NEEDED")
  const filters = container.trigger[0].filter
  assert.ok(
    filters.some((filter) => filter.parameter.some((parameter) => parameter.value === "{{DLV - growth_analytics}}")),
  )
  assert.ok(filters.some((filter) => filter.parameter.some((parameter) => parameter.value === config.site)))
  for (const settings of container.gtagConfig) {
    for (const parameter of settings.parameter) {
      if (parameter.type === "BOOLEAN") assert.equal(parameter.value, "false")
    }
  }
})

test("the actual container tag gates collection and omits raw referrer data", async () => {
  const { readFile } = await import("node:fs/promises")
  const vm = await import("node:vm")
  const config = (await import("../public/growth/config.js")).default
  const container = JSON.parse(
    await readFile(new URL("../docs/gtm-container.json", import.meta.url), "utf8"),
  ).containerVersion
  const html = container.tag[0].parameter.find((parameter) => parameter.key === "html").value
  const scripts = []
  const window = { dataLayer: [] }
  const sandbox = {
    window,
    URL,
    document: {
      referrer: "https://example.org/private?email=private@example.org",
      createElement: () => ({}),
      head: { appendChild: (script) => scripts.push(script) },
    },
  }
  function execute(analytics, advertising) {
    const values = {
      "DLV - growth_analytics": analytics,
      "DLV - growth_advertising": advertising,
      "DLV - growth_event": "download_click",
      "DLV - growth_page_location": "https://www.openscience.sh/download",
      "DLV - growth_page_path": "/download",
      "DLV - growth_site": config.site,
      "DLV - growth_platform": "linux-x64",
    }
    const source = html
      .replace(/^<script>\s*|\s*<\/script>$/g, "")
      .replace(/{{([^}]+)}}/g, (_, key) => JSON.stringify(values[key.trim()] ?? ""))
    vm.runInNewContext(source, sandbox)
  }
  execute(false, false)
  assert.equal(scripts.length, 0)
  assert.equal(window.dataLayer.length, 0)
  execute(true, false)
  assert.equal(scripts.length, 1)
  const calls = window.dataLayer.map((args) => Array.from(args))
  const setup = calls.find((args) => args[0] === "config")
  assert.equal(setup[1], config.googleAnalyticsId)
  assert.equal(setup[2].send_page_view, false)
  assert.equal(setup[2].allow_google_signals, false)
  const sent = calls.find((args) => args[0] === "event")
  assert.equal(sent[1], "download_click")
  assert.equal(sent[2].page_referrer, "https://example.org")
  assert.equal(sent[2].platform, "linux-x64")
  execute(true, true)
  assert.equal(scripts.length, 1)
  assert.equal(Array.from(window.dataLayer[window.dataLayer.length - 2])[2].allow_google_signals, true)
})
