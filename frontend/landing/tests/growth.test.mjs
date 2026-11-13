import test from "node:test"
import assert from "node:assert/strict"
import { createController } from "../public/growth/controller.js"
import { effectiveConsent, cleanEvent, eventForLink, pageLocation } from "../public/growth/policy.js"

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
