import * as CookieConsent from "./vendor/cookieconsent-3.3.0.js"
import config from "./config.js"
import { effectiveConsent, eventForLink, pageLocation, campaignAttribution } from "./policy.js"
import { createController } from "./controller.js"

document.documentElement.dataset.growthSite = config.site
document.documentElement.dataset.growthSection = window.location.pathname.startsWith("/docs") ? "docs" : "landing"

const production = config.hostnames.includes(window.location.hostname)
const privacySignal = navigator.globalPrivacyControl === true
const tags = config.googleTagManagerId && /^GTM-[A-Z0-9]+$/.test(config.googleTagManagerId)
const identification = Boolean(config.identificationScript)
const categories = {
  necessary: { enabled: true, readOnly: true },
  analytics: {},
  ...(config.advertising && !privacySignal ? { advertising: {} } : {}),
  ...(identification && !privacySignal ? { identification: {} } : {}),
}

window.dataLayer = window.dataLayer || []
const google = function () {
  window.dataLayer.push(arguments)
}
const insertScript = (src, id) => {
  if (document.getElementById(id)) return
  const script = document.createElement("script")
  script.id = id
  script.src = src
  script.async = true
  document.head.append(script)
}

function clearCookies(revoked) {
  if (config.googleAnalyticsId && revoked.includes("analytics")) {
    window["ga-disable-" + config.googleAnalyticsId] = true
  }
  const patterns = [
    ...(revoked.includes("analytics") ? [/^_ga(?:_|$)/, /^_gid$/, /^_gat/] : []),
    ...(revoked.includes("advertising") ? [/^_gcl_/, /^_gac_/] : []),
    ...(revoked.includes("identification") ? [/^_reb2b/, /^rb2b/] : []),
  ]
  const hosts = window.location.hostname.split(".")
  const domains = ["", ...hosts.map((_, index) => hosts.slice(index).join(".")).filter((host) => host.includes("."))]
  for (const entry of document.cookie.split(";")) {
    const name = entry.split("=")[0].trim()
    if (!patterns.some((pattern) => pattern.test(name))) continue
    for (const domain of domains) {
      document.cookie = name + "=; Max-Age=0; Path=/; SameSite=Lax" + (domain ? "; Domain=" + domain : "")
    }
  }
}

const controller = createController(
  { ...config, production, googleTagManagerId: tags ? config.googleTagManagerId : "" },
  {
    googleDefaults: (value) => google("consent", "default", value),
    googleConsent: (value) => google("consent", "update", value),
    loadGoogle: (id) => {
      google("set", "ads_data_redaction", true)
      google("set", "url_passthrough", false)
      window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" })
      insertScript("https://www.googletagmanager.com/gtm.js?id=" + encodeURIComponent(id), "growth-google")
    },
    loadIdentification: (src) => insertScript(src, "growth-identification"),
    event: (value) => {
      const attribution = campaignAttribution(window.location.href, value.growth_advertising)
      const location = new URL(value.growth_page_location)
      for (const [key, item] of Object.entries(attribution)) location.searchParams.set(key, item)
      window.dataLayer.push({ ...value, growth_page_location: location.href })
    },
    clearCookies,
    reload: () => window.location.reload(),
    notify: (value) => {
      window.__growthConsent = { ...value, production }
      window.dispatchEvent(new CustomEvent("growth:consent", { detail: window.__growthConsent }))
    },
  },
)

function applyConsent() {
  const accepted = Object.keys(categories).filter((category) => CookieConsent.acceptedCategory(category))
  controller.update(effectiveConsent(accepted, privacySignal))
}

// The notice: one quiet line in the corner, styled by consent.css with each site's own type and colours.
// CookieConsent stores the choice; its own dialogs are never drawn. Accept enables every optional category
// above, so the sentence names each one: a new category needs words here and a consent revision.
const uses = [
  "measure visits",
  ...(categories.advertising ? ["measure our ads"] : []),
  ...(categories.identification ? ["let " + config.identificationName + " identify visiting companies"] : []),
]
const usesText = uses.length < 2 ? uses.join("") : uses.slice(0, -1).join(", ") + " and " + uses[uses.length - 1]
const automated = navigator.webdriver === true || /bot|crawl|spider|slurp|teoma/i.test(navigator.userAgent)
const quickMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
let notice = null

function closeNotice() {
  if (!notice) return
  const element = notice
  notice = null
  element.classList.remove("is-open")
  window.setTimeout(() => element.remove(), quickMotion() ? 0 : 200)
}

function choose(all) {
  closeNotice()
  CookieConsent.acceptCategory(all ? "all" : [])
}

function openNotice(focus) {
  if (notice) {
    if (focus) notice.querySelector("button")?.focus()
    return
  }
  const decided = CookieConsent.validConsent()
  const accepted = CookieConsent.acceptedCategory("analytics")
  notice = document.createElement("div")
  notice.id = "growth-consent"
  notice.setAttribute("role", "region")
  notice.setAttribute("aria-label", "Cookies")
  const text = document.createElement("p")
  const link = document.createElement("a")
  link.href = config.privacyUrl
  link.textContent = "cookies"
  text.append("We use ", link, " to " + usesText + ".")
  const actions = document.createElement("div")
  for (const [label, all] of [
    ["Decline", false],
    ["Accept", true],
  ]) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = label
    if (decided) button.setAttribute("aria-pressed", String(all === accepted))
    button.addEventListener("click", () => choose(all))
    actions.append(button)
  }
  notice.append(text, actions)
  document.body.append(notice)
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => notice?.classList.add("is-open")))
  if (focus) actions.querySelector("button").focus()
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && notice && CookieConsent.validConsent()) closeNotice()
})

document.addEventListener(
  "click",
  (event) => {
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest("[data-cookie-preferences]")) {
      event.preventDefault()
      openNotice(true)
      return
    }
    const link = element?.closest("a[href]")
    if (!link) return
    const placement = link.closest("footer") ? "footer" : link.closest("header, nav") ? "header" : "page"
    const item = eventForLink(link.getAttribute("href"), window.location.href, placement)
    if (item) controller.track(item.name, item.properties)
  },
  { capture: true },
)

window.addEventListener("growth:event", (event) => {
  if (!event.detail || typeof event.detail.name !== "string") return
  controller.track(event.detail.name, event.detail.properties)
})

let currentPage = pageLocation(window.location.href)
controller.pageview(currentPage)
window.addEventListener("popstate", () => {
  currentPage = pageLocation(window.location.href)
  visibleSeconds = 0
  articleRead = false
  controller.pageview(currentPage)
})
// These marketing sites use document navigation or popstate. A page can explicitly announce a SPA route.
window.addEventListener("growth:navigation", () => controller.pageview(pageLocation(window.location.href)))

let visibleSeconds = 0
let articleRead = false
const reading = window.setInterval(() => {
  if (articleRead || !controller.consent().analytics || document.visibilityState !== "visible") return
  if (!window.location.pathname.startsWith("/research/")) return
  visibleSeconds += 1
  const height = document.documentElement.scrollHeight - window.innerHeight
  if (visibleSeconds >= 30 && (height <= 0 || window.scrollY / height >= 0.5)) {
    articleRead = controller.track("research_read")
    if (articleRead) window.clearInterval(reading)
  }
}, 1000)

await CookieConsent.run({
  mode: "opt-in",
  revision: config.consentRevision,
  cookie: {
    name: "synsci_consent",
    domain: window.location.hostname,
    path: "/",
    sameSite: "Lax",
    expiresAfterDays: 180,
  },
  hideFromBots: true,
  autoShow: false,
  manageScriptTags: false,
  autoClearCookies: false,
  categories,
  onConsent: applyConsent,
  onChange: applyConsent,
  language: {
    default: "en",
    translations: { en: { consentModal: { title: "Cookies", description: "We use cookies to " + usesText + "." } } },
  },
})
applyConsent()
if (!CookieConsent.validConsent() && !automated) openNotice(false)
