import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_PANEL, SETTINGS_PANELS, findPanel } from "./registry"

const source = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")

describe("launch settings truth pass", () => {
  test("opens Customize on the first-class Models panel", () => {
    expect(SETTINGS_PANELS[0]?.id).toBe("models")
    expect(DEFAULT_PANEL).toBe("models")
  })

  test("keeps local models deferred and exposes the working memory implementation", () => {
    const ids = SETTINGS_PANELS.map((item) => item.id as string)

    expect(ids).not.toContain("local-models")
    expect(ids).toContain("memory")
    expect(source("LocalModels.tsx")).toContain("const LocalModels: Component = () =>")
    expect(source("Memory.tsx")).toContain("export default")
    expect(findPanel("memory").section).toBe("capabilities")
  })

  test("keeps the real skills catalog in Customize rather than a work tab", () => {
    const panel = findPanel("skills")
    const ids = SETTINGS_PANELS.map((item) => item.id)

    expect(ids).toContain("skills")
    expect(ids.indexOf("skills")).toBe(ids.indexOf("models") + 1)
    expect(panel.title).toBe("Skills")
    expect(panel.section).toBe("capabilities")
    expect(panel.icon).toBe("brain")
    expect(source("Skills.tsx")).toContain("<SkillsPage embedded />")
  })

  test("groups Customize by inference, capabilities, runtime, and app", () => {
    expect(SETTINGS_PANELS.find((item) => item.id === "models")?.section).toBe("inference")
    expect(SETTINGS_PANELS.find((item) => item.id === "connectors")?.section).toBe("capabilities")
    expect(SETTINGS_PANELS.find((item) => item.id === "compute")?.section).toBe("runtime")
    expect(SETTINGS_PANELS.find((item) => item.id === "general")?.section).toBe("app")
  })

  test("keeps local and SSH compute independent from deferred Atlas targets", () => {
    const compute = source("Compute.tsx")

    expect(compute).not.toContain("Model endpoints")
    expect(compute).not.toContain("/endpoint")
    expect(compute).not.toContain("GPU providers")
    expect(compute).toContain("call<Info>()")
    expect(compute).toContain('call<Info>("/ssh"')
    expect(compute).toContain('title="Local machine"')
    expect(compute).toContain('title="Remote compute"')
    expect(compute).toContain("Connect directly over SSH. Atlas is not required.")
    expect(compute).toContain('title="Atlas Compute"')
    expect(compute).toContain("<Badge>coming later</Badge>")
  })

  test("keeps deferred cloud storage out of Storage", () => {
    expect(source("Storage.tsx")).not.toContain("Cloud storage")
    expect(source("Storage.tsx")).not.toContain("manage cloud credentials")
  })

  test("connectors persist enablement and inspect real server capabilities", () => {
    const connectors = source("Connectors.tsx")

    expect(connectors).toContain("sdk.client.mcp.inspect({ name })")
    expect(connectors).toContain('sdk.client.mcp.config.set({ name, config: next, scope: "global" })')
    expect(connectors).toContain("sdk.client.mcp.auth.authenticate({ name })")
    expect(connectors).toContain("sdk.client.mcp.auth.remove({ name })")
    expect(connectors).toContain("saved, but could not connect")
    expect(connectors).toContain("<ConnectorInspection detail={detail()} />")
    expect(connectors).toContain("Stored header values are masked")
    expect(connectors).toContain("restoreRecord")
    expect(connectors).toContain("Add remote server")
    expect(connectors).toContain("Add local command")
    expect(connectors).not.toContain("https://mcp.example.com/mcp or a local command")
    expect(connectors).not.toContain("window.prompt")
  })

  test("keeps model credentials in Models and non-model secrets in Credentials", () => {
    const models = source("Models.tsx")
    const managed = source("ManagedInference.tsx")
    const providers = source("ProviderKeys.tsx")
    const credentials = source("Credentials.tsx")
    const ids = SETTINGS_PANELS.map((item) => item.id as string)

    expect(models).toContain("<ManagedInference onError={setError} />")
    expect(models).toContain("<CodexConnection onError={setError} />")
    expect(models).toContain("<ProviderKeys onError={setError} />")
    expect(managed).toContain(".update({ llm: value })")
    expect(managed).toContain("platform.openLink(URLS.dashboardBilling)")
    expect(providers).toContain("sdk.client.auth.set")
    expect(providers).toContain("sdk.client.auth.remove")
    expect(models).toContain("owner-only local auth file")
    expect(providers).toContain("not the system keychain")
    expect(ids).not.toContain("billing")
    expect(credentials).not.toContain("CodexConnection")
    expect(credentials).not.toContain("sdk.client.auth.set")
    expect(credentials).not.toContain("Provider keys")
  })

  test("presents the four built-in specialists with product-facing names", () => {
    const specialists = source("Specialists.tsx")

    expect(specialists).toContain('research: "Research"')
    expect(specialists).toContain('ml: "ML"')
    expect(specialists).toContain('biology: "Bio"')
    expect(specialists).toContain('physics: "Physics"')
  })
})
