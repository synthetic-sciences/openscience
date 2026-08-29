import { describe, expect, test } from "bun:test"

const root = new URL("./", import.meta.url)
const read = (path: string) => Bun.file(new URL(path, root)).text()

describe("models and compute settings UI contract", () => {
  test("presents inference routing as one semantic choice group", async () => {
    const source = await read("ManagedInference.tsx")

    expect(source).not.toContain('icon: "bolt"')
    expect(source).not.toContain('icon: "providers"')
    expect(source).not.toContain('icon: "sparkles"')
    expect(source).toContain('class="models-routing__option"')
    expect(source).toContain('class="models-routing__option-label"')
    expect(source).not.toContain('name="check-small"')
    expect(source).toContain('aria-describedby="managed-inference-description"')
    expect(source).toContain('id="managed-inference-description"')
    expect(source).not.toContain("managed-inference-${option.value")
    expect(source).toContain("aria-pressed=")
    expect(source).toContain("setMode(value)")
    const update = source.slice(source.indexOf("const update ="), source.indexOf("// The mode can change"))
    expect(update).toContain("setBusy(false)")
    expect(update.indexOf("setBusy(false)")).toBeLessThan(update.indexOf("void sync("))

    expect(source.indexOf('title: "BYOK / Subscription"')).toBeLessThan(source.indexOf('title: "Managed"'))
    for (const description of [
      "Use connected provider keys or models included with an eligible subscription.",
      "Use your purchased Wallet balance for supported models without configuring a provider key.",
    ]) {
      expect(source.split(description)).toHaveLength(2)
    }
  })

  test("uses compact semantic status and action affordances for model access", async () => {
    const models = await read("Models.tsx")
    const codex = await read("CodexConnection.tsx")
    const keys = await read("ProviderKeys.tsx")

    expect(models).not.toContain('title="Starting model"')
    expect(models).not.toContain("DefaultModelControl")
    expect(models).not.toContain('<Row title="Background model"')
    expect(models).toContain('title="Model access"')
    expect(models).toContain("useGlobalSDK()")
    expect(models).not.toContain("useSDK()")
    expect(models).toContain('class="settings-card models-access-card"')
    expect(models).toContain('title="Connections"')
    expect(models).toContain('class="settings-card models-connections-card"')
    expect(models).toContain('title="Model preferences"')
    expect(models).toContain('class="settings-card settings-defaults-card models-preferences-card"')
    expect(models).not.toContain('id="model-defaults"')
    expect(models).toContain("takeModelGroups(groups(), renderLimit())")
    expect(models).toContain("groupModelRoutes")
    expect(models).toContain("modelDisplayName")
    expect(models).toContain("logicalKey: choice.key")
    expect(models).toContain("value: modelRouteValue(key)")
    expect(models).toContain("models.setVisibility(model.key, checked)")
    expect(models).toContain("if (!checked && model.pinned) models.pinned.toggle(model.key)")
    expect(models).toContain("Pinned models appear first. Hidden models stay out of the picker.")
    expect(models).toContain("`${visibleCount()} visible · ${pinnedCount()}/3 pinned for quick access`")
    expect(models).toContain('aria-controls="composer-model-catalog"')
    expect(models).toContain('{catalogOpen() ? "Done" : "Edit"}')
    expect(models).toContain('id="model-preferences"')
    expect(models).toContain('aria-label="Worker model"')
    expect(models).toContain('label: "Same as conversation"')
    expect(models).toContain("const routes = options()")
    expect(models).toContain("resolveModelAccessRoute({")
    expect(models).toContain('settingsApi<BillingPreference>(sdk.url, fetchFn, "/settings/billing")')
    expect(models).toContain("sync.onProvidersRefreshed(() => void billingActions.refetch())")
    expect(models).toContain("billing.latest?.llm ?? sync.data.config.billing?.llm")
    expect(models).toContain("access: route.routeAccess")
    expect(models).toContain("current: selected")
    expect(models).toContain("if (!route) return []")
    expect(models).not.toContain('candidate.key.providerID === "openrouter"')
    expect(models).not.toContain('candidate.key.providerID !== "openrouter"')
    expect(models).toContain("value: model.logicalKey")
    expect(models).toContain("`saved:${modelRouteValue(selected)}`")
    expect(models).toContain("· {provider()}")
    expect(models).toContain("delegation_worker_model: option.model ?? null")
    expect(models).toContain("if (sameDelegationModel(previous.delegation_worker_model, option.model)) return")
    expect(models).toContain("publishCapabilityPreferences(saved)")
    expect(models).toContain("<Show when={catalogOpen()}>")
    expect(models).toContain("<SearchInput")
    expect(models).toContain("<FilterMenu")
    expect(models).toContain('ariaLabel="Model filter"')
    expect(models).toContain("Showing {renderLimit()} of {filtered().length}")
    expect(models).toContain("Show more")
    expect(models).toContain("Show ${model.label} in composer")
    expect(models).not.toContain("label: item.name")
    expect(models).toContain("providerLogo: display.id")
    expect(models).toContain("<ProviderLogo id={model.providerLogo}")
    expect(codex).toContain('class="settings-status" data-tone="ready"')
    expect(codex).toContain('<ProviderLogo id="openai-codex" label="OpenAI" />')
    expect(codex).toContain(">ChatGPT / Codex</span>")
    expect(codex).toContain("Use models included with your ChatGPT plan.")
    expect(codex).toContain(': "Sign in"')
    expect(codex).not.toContain('label="OpenAI" connected=')
    expect(codex).toContain('class="settings-panel-action settings-panel-action--quiet models-secondary-action"')
    expect(keys).toContain("settings-provider-key-form")
    expect(keys).toContain('class="models-provider-options"')
    expect(keys).toContain('triggerVariant="settings"')
    expect(keys).toContain("<ProviderLogo id={entry().id}")
    expect(keys).toContain('class="settings-status" data-tone="ready"')
    expect(keys).toContain('class="models-provider-keys"')
    expect(keys).toContain('aria-controls="models-add-provider-key"')
    expect(keys).toContain('{adding() ? "Cancel" : "Add key"}')
    expect(keys).toContain("No provider API keys connected.")
    expect(keys).not.toContain("connected />")
    expect(keys).toContain("sdk.client.auth.set")
    expect(keys).toContain("sdk.client.auth.remove")
    expect(keys).not.toContain("sdk.client.global.dispose")
    expect(keys.indexOf("setSaving(false)")).toBeLessThan(keys.indexOf('refreshAfterSave("Key saved")'))
  })

  test("gives compute targets semantic icons and exposes pinned remote dispatch", async () => {
    const source = await read("Compute.tsx")

    expect(source).toContain('icon="braces"')
    expect(source.split('icon="braces"').length).toBeGreaterThanOrEqual(3)
    expect(source).toContain('icon="server"')
    expect(source).toContain('title="Python starter"')
    expect(source).toContain('title="R starter"')
    expect(source).toContain('{environment("python")?.ready ? "Ready" : "Setup needed"}')
    expect(source).toContain('{environment("r")?.ready ? "Ready" : "Setup needed"}')
    expect(source).toContain("Choose where agent-managed Python, R, shell, and batch work runs.")
    expect(source).toContain("Test connection admits only administrator-managed executables")
    expect(source).toContain("ordinary Homebrew and pip installs remain credential-only")
    expect(source).not.toContain("Enabled for a provider-specific native broker")
    expect(source).not.toContain("Coming soon")
    expect(source).toContain("Pin a host key, then dispatch staged jobs through your active SSH agent.")
    expect(source).toContain("Ready to dispatch")
    expect(source).not.toContain("not execution targets")
    expect(source).not.toContain("Remote job dispatch remains unavailable")
    expect(source).toContain('class="settings-panel-action settings-panel-action--danger-quiet"')
  })

  test("does not reintroduce hard-coded black or white islands", async () => {
    for (const path of [
      "Models.tsx",
      "ManagedInference.tsx",
      "CodexConnection.tsx",
      "ProviderKeys.tsx",
      "Compute.tsx",
    ]) {
      const source = await read(path)
      expect(source).not.toMatch(/\bbg-(?:black|white)\b/)
      expect(source).not.toMatch(/(?:#000(?:000)?|#fff(?:fff)?|background:\s*(?:black|white))/i)
    }
  })

  test("keeps the model panel neutral and compact", async () => {
    const [models, dialog, switchCss] = await Promise.all([
      read("models.css"),
      Bun.file(new URL("../dialog-settings.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../../../ui/src/components/switch.css", import.meta.url)).text(),
    ])

    expect(models).toContain("--models-control-height: 32px")
    expect(models).toContain("background: var(--settings-primary)")
    expect(dialog).toContain("--switch-active-color: var(--settings-toggle-active)")
    expect(switchCss).toContain("width: 34px")
    expect(models).not.toContain('[data-slot="switch-control"]')
    expect(models).toContain("outline-color: var(--border-focus)")
    expect(models).toContain("background: var(--settings-surface-muted)")
    expect(models).toContain("background: var(--settings-surface)")
    expect(models).toContain("font-variant-numeric: tabular-nums")
    expect(models).toContain("box-shadow: none")
    expect(models).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))")
    expect(models).toContain(".models-routing__description {\n  flex: 1 1 auto;")
    expect(models).not.toContain(".models-routing__description {\n  flex: 1 1 260px;")
    expect(models).toContain(".models-routing__option:hover:not(:disabled)")
    expect(models).toContain(".models-preference-row")
    expect(models).toContain("position: sticky")
    expect(models).toContain("background-clip: padding-box")
    expect(models).not.toContain("border-radius: 999px")
    expect(models).not.toMatch(/(?:#007aff|#0a84ff|\bblue\b)/i)
    expect(models).not.toContain("var(--settings-accent)")
  })
})
