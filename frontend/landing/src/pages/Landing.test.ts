import { describe, expect, test } from "bun:test"

const landing = await Bun.file(new URL("./Landing.tsx", import.meta.url)).text()
const main = await Bun.file(new URL("../main.tsx", import.meta.url)).text()
const readme = await Bun.file(new URL("../../../../README.md", import.meta.url)).text()
const gateway = await Bun.file(new URL("../../../docs/src/content/openscience/gateway.mdx", import.meta.url)).text()
const docsIndex = await Bun.file(new URL("../../../docs/src/content/openscience/index.mdx", import.meta.url)).text()
const skills = await Bun.file(new URL("../../../docs/src/content/openscience/skills.mdx", import.meta.url)).text()
const installer = await Bun.file(new URL("../../public/install", import.meta.url)).text()
const docsHtml = await Bun.file(new URL("../../public/docs/index.html", import.meta.url)).text()
const docsScript = docsHtml.match(/src="\/docs\/assets\/([^\"]+\.js)"/)?.[1]
if (!docsScript) throw new Error("could not resolve the checked-in docs bundle")
const docsBundle = await Bun.file(new URL(`../../public/docs/assets/${docsScript}`, import.meta.url)).text()

describe("OpenScience landing contract", () => {
  test("keeps the core workbench open source, local, and account-optional", () => {
    expect(landing).toContain("The open-source AI workbench for scientists.")
    expect(landing).toContain("Your files")
    expect(landing).toContain("Your keys")
    expect(landing).toContain("Do I need a Synthetic Sciences account?")
    expect(landing).toContain("A Synthetic Sciences account is optional")
  })

  test("publishes the supported OpenScience install paths", () => {
    for (const source of [landing, readme, docsIndex]) {
      expect(source).toContain("@synsci/openscience")
    }
    expect(landing).toContain("curl -fsSL https://openscience.sh/install | bash")
    expect(installer).toContain("OpenScience Installer")
  })

  test("does not advertise paused surfaces or old branding", () => {
    for (const source of [landing, readme, gateway, docsIndex, skills, installer, docsBundle]) {
      expect(source).not.toMatch(/\b(?:Atlas|managed compute|cloud compute)\b/i)
    }
    expect(landing).not.toContain("Explore public")
  })

  test("gives visitors an explicit website analytics control", () => {
    expect(main).toContain('window.localStorage.getItem(ANALYTICS_PREFERENCE) !== "off"')
    expect(landing).toContain('Website analytics: {analyticsEnabled ? "on" : "off"}')
  })
})
