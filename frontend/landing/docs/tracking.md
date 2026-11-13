# Website measurement

The public `growth/` module loads CookieConsent from a pinned, self-hosted distribution. Production hostnames and public service IDs are in `public/growth/config.js`. Update `consentRevision` when a new optional purpose or provider needs a fresh choice. Provider keys belong in the provider's account or server secrets.

Google Tag Manager loads only after analytics or advertising consent. Tags in the container must honor the corresponding Google consent state and the `growth_analytics` / `growth_advertising` event flags. The container receives only the `growth_*` events defined in `policy.js`. Configure the GA4 tag with automatic page views and enhanced measurement disabled, then use the supplied page event once. Production tags are disabled on previews by the hostname allowlist.

Visitor identification is disabled until an approved provider script is supplied. Its separate preference gates loading. Global Privacy Control overrides advertising and identification choices. Withdrawal saves the new choice, clears the matching first-party cookies, and reloads the page to terminate previously loaded scripts.

A successful clipboard operation emits `install_command_copy`. An installer link emits `download_click`. Contact/email actions represent a click or draft, not a delivered lead. Product activation requires its own product event and attribution integration.

Run `node --test tests/growth.test.mjs` in this site's directory for consent and event behavior. The `Landing tracking` GitHub workflow runs these checks and builds the site remotely. Verify first visit, reject, accept, withdrawal, return visit and Global Privacy Control in the preview before publishing.

The `growth/vendor/` license and provenance file apply to CookieConsent 3.3.0. These distribution files are kept byte-for-byte.

## Container configuration

`docs/gtm-container.json` is the reviewed import for this site's existing container. It sends the explicit `growth_*` events to the shared `G-2BF4QBMLXN` property. The tag requires analytics consent, a matching production hostname and the site's event label. It disables automatic page views, automatic event discovery and automatic collection of user-provided contact fields.

Import into the matching container's default workspace, review the changes and publish a named version. The initial imports replace only draft items created during this setup. A later import must preserve any separately added tags or settings. Keep the published export with the source release so that tag configuration can be reviewed and rolled back.

The Analytics account is `416229689`, property `564214334`, stream `16334840759`. The website setup measures downloads and command copies. Product activation and the optional identification provider remain separate integrations.
