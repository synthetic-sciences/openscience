export const EMPTY_CONSENT = Object.freeze({
  analytics: false,
  advertising: false,
  identification: false,
})

export function effectiveConsent(categories, globalPrivacyControl = false) {
  return {
    analytics: categories.includes("analytics"),
    advertising: !globalPrivacyControl && categories.includes("advertising"),
    identification: !globalPrivacyControl && categories.includes("identification"),
  }
}

export function googleConsent(consent) {
  return {
    analytics_storage: consent.analytics ? "granted" : "denied",
    ad_storage: consent.advertising ? "granted" : "denied",
    ad_user_data: consent.advertising ? "granted" : "denied",
    ad_personalization: consent.advertising ? "granted" : "denied",
    functionality_storage: "granted",
    security_storage: "granted",
    personalization_storage: "denied",
  }
}

export function pageLocation(href) {
  const url = new URL(href)
  // Marketing sites have public path names. Queries and fragments can contain personal data.
  const path = /^[a-zA-Z0-9/_-]*$/.test(url.pathname) ? url.pathname : "/"
  return url.origin + path
}

export function eventForLink(href, currentUrl, placement = "page") {
  let url
  try {
    url = new URL(href, currentUrl)
  } catch {
    return null
  }
  const properties = { placement: ["header", "footer", "page"].includes(placement) ? placement : "page" }
  if (url.protocol === "mailto:") return { name: "contact_click", properties: { ...properties, method: "email" } }
  if (
    url.hostname === "github.com" &&
    /^\/synthetic-sciences\/openscience\/releases\/(latest\/download|download\/)/i.test(url.pathname)
  ) {
    const platform = url.pathname
      .match(/OpenScience-(mac-arm64|mac-x64|windows-x64|linux-x64|linux-arm64)\./i)?.[1]
      ?.toLowerCase()
    return platform ? { name: "download_click", properties: { ...properties, platform } } : null
  }
  if (url.hostname === "github.com" && /^\/synthetic-sciences(\/|$)/i.test(url.pathname)) {
    return { name: "github_click", properties }
  }
  if (url.hostname === "app.syntheticsciences.ai") return { name: "account_click", properties }
  const products = {
    "openscience.sh": "openscience",
    "www.openscience.sh": "openscience",
    "syntheticsciences.ai": "syntheticsciences",
    "tryascent.ai": "ascent",
    "www.tryascent.ai": "ascent",
  }
  if (products[url.hostname] && url.hostname !== new URL(currentUrl).hostname) {
    return { name: "site_link_click", properties: { ...properties, destination_site: products[url.hostname] } }
  }
  return null
}

const EVENTS = {
  page_view: {},
  download_click: { platform: ["mac-arm64", "mac-x64", "windows-x64", "linux-x64", "linux-arm64"] },
  install_command_copy: { method: ["curl", "npm", "npx", "desktop", "cli"] },
  account_click: {},
  github_click: {},
  research_read: {},
  contact_click: { method: ["email", "dialog"] },
  access_request_email: {},
  site_link_click: { destination_site: ["openscience", "syntheticsciences", "ascent"] },
}

export function cleanEvent(name, properties = {}) {
  if (!Object.hasOwn(EVENTS, name)) return null
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null
  const clean = {}
  if (["header", "footer", "page"].includes(properties.placement)) clean.placement = properties.placement
  for (const [field, allowed] of Object.entries(EVENTS[name])) {
    if (allowed.includes(properties[field])) clean[field] = properties[field]
  }
  return { name, properties: clean }
}

export function campaignAttribution(href, advertising = false) {
  const url = new URL(href)
  const result = {}
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_id", "utm_content", "utm_term"]) {
    const value = url.searchParams.get(key)
    if (value && /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,99}$/.test(value)) result[key] = value
  }
  if (advertising) {
    for (const key of ["gclid", "dclid", "gbraid", "wbraid"]) {
      const value = url.searchParams.get(key)
      if (value && /^[a-zA-Z0-9_-]{1,512}$/.test(value)) result[key] = value
    }
  }
  return result
}
