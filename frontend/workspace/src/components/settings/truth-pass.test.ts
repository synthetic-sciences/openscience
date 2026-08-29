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

  test("exposes verified local models while keeping removed internals out of Customize", () => {
    const ids = SETTINGS_PANELS.map((item) => item.id as string)

    expect(ids).toContain("local-models")
    expect(ids).not.toContain("memory")
    expect(ids).not.toContain("specialists")
    expect(source("LocalModels.tsx")).toContain("const LocalModels: Component = () =>")
    expect(source("LocalModels.tsx")).toContain('"/context"')
    expect(source("LocalModels.tsx")).toContain("contextLimit: ollama ? tokens")
    expect(source("LocalModels.tsx")).toContain("keeps the tuned runtime alias out of the Models")
    expect(ids).toEqual([
      "models",
      "local-models",
      "skills",
      "scientific-tools",
      "connectors",
      "research-tools",
      "compute",
      "permissions",
      "network",
      "sandbox",
      "credentials",
      "storage",
      "general",
    ])
  })

  test("keeps the real skills catalog in Customize rather than a work tab", () => {
    const panel = findPanel("skills")
    const ids = SETTINGS_PANELS.map((item) => item.id)

    expect(ids).toContain("skills")
    expect(ids.indexOf("skills")).toBe(ids.indexOf("local-models") + 1)
    expect(panel.title).toBe("Skills")
    expect(panel.section).toBe("capabilities")
    expect(panel.icon).toBe("flask")
    expect(source("Skills.tsx")).toContain("<SkillsPage embedded />")
  })

  test("keeps scientific tools as a flat truthful capability destination", () => {
    const panel = findPanel("scientific-tools")
    const scientific = source("ScientificTools.tsx")

    expect(panel.title).toBe("Scientific tools")
    expect(panel.section).toBe("capabilities")
    expect(scientific).toContain('"/settings/scientific-tools"')
    expect(scientific).toContain("Instructional presence and upstream availability never count")
    expect(scientific).toContain("Release-verified")
    expect(scientific).not.toContain("54 verified")
  })

  test("groups every Customize destination without nested navigation", () => {
    expect(SETTINGS_PANELS.find((item) => item.id === "models")?.section).toBe("inference")
    expect(SETTINGS_PANELS.find((item) => item.id === "connectors")?.section).toBe("capabilities")
    expect(SETTINGS_PANELS.find((item) => item.id === "compute")?.section).toBe("runtime")
    expect(SETTINGS_PANELS.find((item) => item.id === "general")?.section).toBe("app")
  })

  test("keeps local Python, R, shell, Modal, and SSH compute operational", () => {
    const compute = source("Compute.tsx")

    expect(compute).not.toContain("Model endpoints")
    expect(compute).not.toContain("/endpoint")
    expect(compute).not.toContain("GPU providers")
    expect(compute).toContain("call<Info>()")
    expect(compute).toContain('call<Info>("/ssh"')
    expect(compute).toContain('title="Local runtimes"')
    expect(compute).toContain('title="Python starter"')
    expect(compute).toContain('title="R starter"')
    expect(compute).toContain("Variables persist for the session")
    expect(compute).toContain('title="Remote hosts"')
    expect(compute).toContain("Ready to dispatch")
    expect(compute).toContain("Pin a host key, then dispatch staged jobs")
    expect(compute).not.toContain("not execution targets")
    expect(compute).not.toContain("Remote job dispatch remains unavailable")
    expect(compute).toContain('title="Cloud credentials"')
    expect(compute).not.toContain('title="Atlas Compute"')
    expect(compute).not.toContain("Coming soon")
    expect(compute).not.toContain("/atlas-compute")
  })

  test("prefers an active Modal CLI profile without exposing its credentials", () => {
    const compute = source("Compute.tsx")

    expect(compute).toContain("Modal CLI configuration found at ~/.modal.toml.")
    expect(compute).toContain('call<Info>("/modal/configure"')
    expect(compute).toContain('source: "stored" | "account" | "modal_toml" | null')
    expect(compute).toContain('label="Modal token ID"')
    expect(compute).toContain('label="Modal token secret"')
    expect(compute).toContain('type="password"')
    expect(compute).toContain('label="Default timeout (minutes)"')
    expect(compute).toContain("Credentials stay local. Every dispatch still requires approval.")
  })

  test("keeps Modal action results visible inside the compute panel", () => {
    const compute = source("Compute.tsx")

    expect(compute).not.toContain("Configured — connection not tested")
    expect(compute).toContain("Connection verified")
    expect(compute).toContain("Connection check failed")
    expect(compute).toContain("Defaults saved")
    expect(compute).toContain("Unsaved default changes")
    expect(compute).toContain('"Test connection"')
    expect(compute).toContain('"Save defaults"')
    expect(compute).toContain('"Add host"')
    expect(compute).toContain('aria-live="polite"')
  })

  test("exposes verified live storage relocation without restart copy", () => {
    const storage = source("Storage.tsx")
    const styles = source("preference-panels.css")

    expect(storage).not.toContain("Cloud storage")
    expect(storage).not.toContain("manage cloud credentials")
    expect(storage).not.toContain("window.prompt")
    expect(storage).not.toContain("Copy data")
    expect(storage).not.toContain("restart")
    expect(storage).toContain("Change location")
    expect(storage).toContain("Move data")
    expect(storage).toContain('method: "DELETE"')
    expect(storage).toContain("pauses active writes")
    expect(storage).toContain("server together")
    expect(storage).toContain("settings-storage-location-input")
    expect(styles).toContain(".settings-dialog .settings-storage-location-input")
    expect(styles).toContain("font-family: var(--font-family-mono)")
  })

  test("states the effective grant-only sandbox boundary", () => {
    const sandbox = source("Sandbox.tsx")

    expect(sandbox).toContain('readIsolation?: "grant_only" | "unavailable"')
    expect(sandbox).toContain('networkIsolation?: "deny_all" | "unavailable"')
    expect(sandbox).toContain('capability === "grant_only" || (capability === undefined && nativeBackendActive())')
    expect(sandbox).toContain('capability === "deny_all" || (capability === undefined && nativeBackendActive())')
    expect(sandbox).toContain("Reads and writes are limited to the workspace and approved paths")
    expect(sandbox).toContain("This backend always denies network access")
    expect(sandbox).toContain("including loopback, LAN, link-local, and metadata endpoints")
    expect(sandbox).not.toContain("private-network addresses may still be reachable")
    expect(sandbox).not.toContain("host_readable")
    expect(sandbox).not.toContain("does not isolate host reads")
  })

  test("connectors persist enablement and inspect real server capabilities", () => {
    const connectors = source("Connectors.tsx")
    const connectorForm = source("connector-form.ts")

    expect(connectors).toContain("sdk.client.mcp.inspect({ name })")
    expect(connectors).toContain('sdk.client.mcp.config.set({ name, config: next, scope: "global" })')
    expect(connectors).toContain("beginAuthentication(name)")
    expect(connectors).toContain('started.state === "settled"')
    expect(connectors).toContain('authPath(name, "/wait")')
    expect(connectors).toContain("sdk.client.mcp.auth.remove({ name })")
    expect(connectors).toContain('detail()?.auth === "authenticated" || s()?.status === "connected"')
    expect(connectors).toContain("saved, but could not connect")
    expect(connectors).toContain("<ConnectorInspection detail={detail()} />")
    expect(connectors).toContain("Stored header values are masked")
    expect(connectorForm).toContain("restoreRecord")
    expect(connectors).toContain('label="Hosted server"')
    expect(connectors).toContain('label="Local process"')
    expect(connectors).toContain('label="Add connector"')
    expect(connectors).toContain('label="Reviewed setup catalog"')
    expect(connectors).toContain("Nothing is installed, enabled, or granted write")
    expect(connectors).toContain("access until you review and save it")
    expect(connectors).toContain("connectorFormFromCatalog(entry.setup)")
    expect(connectors).not.toContain("write-back ready")
    expect(connectors).toContain('label: "Hosted server"')
    expect(connectors).toContain('label: "Local process"')
    expect(connectors).toContain('"Save connector"')
    expect(connectors).toContain('label="Cancel"')
    expect(connectors).toContain("Refresh status")
    expect(connectors).not.toContain('label="cancel"')
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
    expect(managed).not.toContain('title: "Automatic"')
    expect(managed).toContain('title: "Managed"')
    expect(managed).toContain('title: "BYOK / Subscription"')
    expect(providers).toContain("sdk.client.auth.set")
    expect(providers).toContain("sdk.client.auth.remove")
    expect(providers).toContain("owner-only local auth file")
    expect(providers).toContain("not the system keychain")
    expect(ids).not.toContain("billing")
    expect(credentials).not.toContain("CodexConnection")
    expect(credentials).not.toContain("sdk.client.auth.set")
    expect(credentials).not.toContain("Provider keys")
  })

  test("describes stored credentials without claiming an untested service connection", () => {
    const services = source("CredentialServices.tsx")

    expect(services).toContain("Encrypted on this machine")
    expect(services).toContain("{count()} saved")
    expect(services).toContain('<span class="settings-chip">Credential saved</span>')
    expect(services).not.toContain("connected={service.connected}")
    expect(services).not.toContain("Connected and ready")
  })
})
