/* Every external destination the site links to, in one place. */

export const SITE = "https://openscience.sh"
export const GITHUB = "https://github.com/synthetic-sciences/OpenScience"
export const RELEASES = `${GITHUB}/releases`
export const RELEASE_DOWNLOAD = `${GITHUB}/releases/latest/download`
export const CHANGELOG = `${GITHUB}/blob/main/CHANGELOG.md`
export const LICENSE = `${GITHUB}/blob/main/LICENSE`
export const SECURITY = `${GITHUB}/blob/main/SECURITY.md`
export const REPORT_VULNERABILITY = `${GITHUB}/security/advisories/new`
export const NPM = "https://www.npmjs.com/package/@synsci/openscience"
export const NPM_SDK = "https://www.npmjs.com/package/@synsci/sdk"

export const DOCS = `${SITE}/docs`
export const docs = (page: string, hash = "") => `${DOCS}/#/openscience/${page}${hash}`

export const SYNTHETIC_SCIENCES = "https://syntheticsciences.ai"
export const DASHBOARD = "https://app.syntheticsciences.ai"
export const ASCENT = "https://tryascent.ai"
export const X = "https://x.com/SynScience"

export const INSTALL_SCRIPT = `${SITE}/install`
