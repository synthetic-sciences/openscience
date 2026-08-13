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
    expect(source).toContain("aria-describedby=")
    expect(source).toContain("aria-pressed=")
    expect(source).toContain("setMode(value)")
    expect(source).toContain("setBusy(false)")
    expect(source.indexOf("setBusy(false)")).toBeLessThan(source.indexOf(".refreshProviders()"))
  })

  test("uses compact semantic status and action affordances for model access", async () => {
    const models = await read("Models.tsx")
    const codex = await read("CodexConnection.tsx")
    const keys = await read("ProviderKeys.tsx")

    expect(models).toContain('<Row title="Research model"')
    expect(models).toContain('<Row title="Background model"')
    expect(models).toContain('title="Access and routing"')
    expect(models).toContain('class="settings-card models-access-card"')
    expect(models.indexOf('id="model-defaults"')).toBeLessThan(models.indexOf('id="provider-keys"'))
    expect(models).toContain("takeModelGroups(groups(), renderLimit())")
    expect(models).toContain("groupModelRoutes")
    expect(models).toContain("modelDisplayName")
    expect(models).toContain("logicalModelKey")
    expect(models).toContain("preservedModelRoute")
    expect(models).toContain("<DefaultModelControl")
    expect(models).toContain("aria-label={`${props.label} access`}")
    expect(models).toContain('placeholder="Choose access"')
    expect(models).toContain("model.routes.forEach((route) => models.setVisibility(route.key, checked))")
    expect(models).not.toContain("label: item.name")
    expect(models).toContain("providerLogo: display.id")
    expect(models).toContain("<ProviderLogo id={model.providerLogo}")
    expect(codex).toContain('class="settings-status" data-tone="ready"')
    expect(codex).toContain('<ProviderLogo id="openai-codex" label="OpenAI" />')
    expect(codex).not.toContain('label="OpenAI" connected=')
    expect(codex).toContain('class="settings-panel-action settings-panel-action--quiet models-secondary-action"')
    expect(keys).toContain("settings-provider-key-form")
    expect(keys).toContain('class="models-provider-options"')
    expect(keys).toContain('triggerVariant="settings"')
    expect(keys).toContain("<ProviderLogo id={entry().id}")
    expect(keys).toContain('class="settings-status" data-tone="ready"')
    expect(keys).toContain('class="settings-card models-provider-keys"')
    expect(keys).toContain("No provider API keys are connected yet.")
    expect(keys).not.toContain("connected />")
    expect(keys).toContain("sdk.client.auth.set")
    expect(keys).toContain("sdk.client.auth.remove")
    expect(keys).not.toContain("sdk.client.global.dispose")
    expect(keys.indexOf("setSaving(false)")).toBeLessThan(keys.indexOf('refreshAfterSave("Key saved")'))
  })

  test("gives compute targets semantic icons and exposes pinned remote dispatch", async () => {
    const source = await read("Compute.tsx")

    expect(source).toContain('icon="braces"')
    expect(source).toContain('icon="console"')
    expect(source).toContain('icon="server"')
    expect(source).toContain('<Badge tone="ready">Automatic</Badge>')
    expect(source).toContain('<Badge tone="ready">Ready</Badge>')
    expect(source).toContain("Choose where agent-managed Python, R, shell, and batch work runs.")
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
    expect(switchCss).toContain("width: 30px")
    expect(models).not.toContain('[data-slot="switch-control"]')
    expect(models).toContain("outline-color: var(--border-focus)")
    expect(models).toContain("background: var(--settings-surface-muted)")
    expect(models).toContain("background: var(--settings-surface)")
    expect(models).toContain("box-shadow: none")
    expect(models).toContain("grid-template-columns: minmax(330px, 0.9fr) minmax(220px, 1.1fr)")
    expect(models).toContain("background-clip: padding-box")
    expect(models).not.toContain("border-radius: 999px")
    expect(models).not.toMatch(/(?:#007aff|#0a84ff|\bblue\b)/i)
    expect(models).not.toContain("var(--settings-accent)")
  })
})
