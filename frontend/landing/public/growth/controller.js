import { EMPTY_CONSENT, cleanEvent, googleConsent } from "./policy.js"

export function createController(config, transport) {
  let consent = { ...EMPTY_CONSENT }
  let googleLoaded = false
  let identityLoaded = false
  let stopped = false
  let initialized = false
  let page = null

  function update(next) {
    if (stopped) return
    if (initialized && Object.keys(consent).every((key) => consent[key] === next[key])) return
    initialized = true
    const revoked = Object.keys(consent).filter((key) => consent[key] && !next[key])
    consent = { ...next }
    transport.notify(consent)
    if (googleLoaded) transport.googleConsent(googleConsent(consent))
    if (revoked.length) {
      // A reload removes already-running vendor timers and listeners after the new choice is saved.
      stopped = true
      transport.clearCookies(revoked)
      transport.reload()
      return
    }
    if (!config.production) return
    if ((consent.analytics || consent.advertising) && config.googleTagManagerId && !googleLoaded) {
      transport.googleDefaults(googleConsent(EMPTY_CONSENT))
      transport.googleConsent(googleConsent(consent))
      googleLoaded = true
      transport.loadGoogle(config.googleTagManagerId)
    }
    if (consent.identification && config.identificationScript && !identityLoaded) {
      identityLoaded = true
      transport.loadIdentification(config.identificationScript)
    }
    if (page) pageview(page, true)
  }

  let sentPage = ""
  let sentPermissions = ""
  function pageview(location, consentChange = false) {
    page = location
    const permissions = String(consent.analytics) + ":" + String(consent.advertising)
    if (!consentChange && location === sentPage) return
    if (location === sentPage && permissions === sentPermissions) return
    if (track("page_view", {}, location)) {
      sentPage = location
      sentPermissions = permissions
    }
  }

  function track(name, properties = {}, location = page) {
    if (stopped || !config.production || !googleLoaded || !location) return false
    if (!consent.analytics && !consent.advertising) return false
    const event = cleanEvent(name, properties)
    if (!event) return false
    transport.event({
      event: "growth_" + event.name,
      growth_event: event.name,
      growth_site: config.site,
      growth_page_location: location,
      growth_page_path: new URL(location).pathname,
      growth_analytics: consent.analytics,
      growth_advertising: consent.advertising,
      growth_platform: event.properties.platform || "",
      growth_method: event.properties.method || "",
      growth_placement: event.properties.placement || "",
      growth_destination_site: event.properties.destination_site || "",
    })
    return true
  }

  return { update, pageview, track, consent: () => ({ ...consent }) }
}
