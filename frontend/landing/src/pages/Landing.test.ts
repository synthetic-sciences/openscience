import { describe, expect, test } from "bun:test"

const landing = await Bun.file(new URL("./Landing.tsx", import.meta.url)).text()
const main = await Bun.file(new URL("../main.tsx", import.meta.url)).text()
const readme = await Bun.file(new URL("../../../../README.md", import.meta.url)).text()
const gateway = await Bun.file(new URL("../../../docs/src/content/openscience/gateway.mdx", import.meta.url)).text()
const docsIndex = await Bun.file(new URL("../../../docs/src/content/openscience/index.mdx", import.meta.url)).text()
const skills = await Bun.file(new URL("../../../docs/src/content/openscience/skills.mdx", import.meta.url)).text()
const installer = await Bun.file(new URL("../../public/install", import.meta.url)).text()
const packageReadme = await Bun.file(new URL("../../../../backend/cli/README.md", import.meta.url)).text()
const graphSkill = await Bun.file(
  new URL("../../../../backend/cli/src/skill/system/initialize-research-graph.txt", import.meta.url),
).text()
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
    for (const source of [
      landing,
      readme,
      packageReadme,
      gateway,
      docsIndex,
      skills,
      installer,
      graphSkill,
      docsBundle,
    ]) {
      expect(source).not.toMatch(/\b(?:Atlas|managed compute|cloud compute)\b/i)
    }
    expect(landing).not.toContain("Explore public")
  })

  test("publishes only the pay-as-you-go credit contract", () => {
    for (const source of [landing, readme, packageReadme, gateway, docsBundle]) {
      expect(source).not.toMatch(
        /(?:Ace\+|Ace is \$20\/month|\$100\/month|150 credits|research quota|Synthetic Scientists access|\$50 or \$200|recurring monthly)/i,
      )
    }
    for (const source of [readme, gateway, docsBundle]) {
      expect(source).toContain("20 credits")
      expect(source).toMatch(/\$20 (?:to your wallet|wallet value)/i)
      expect(source).toMatch(/below 5/i)
      expect(source).toMatch(/processing fee/i)
    }
  })

  test("gives visitors an explicit website analytics control", () => {
    expect(main).toContain('window.localStorage.getItem(ANALYTICS_PREFERENCE) !== "off"')
    expect(landing).toContain('Website analytics: {analyticsEnabled ? "on" : "off"}')
  })
})
