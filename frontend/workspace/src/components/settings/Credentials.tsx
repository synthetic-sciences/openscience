// Credentials — external-service secrets (encrypted-at-rest via
// /settings/credentials) + provider BYOK keys (auth.json via /auth). Every
// secret is write-only: values are never returned after saving.
import { type Component, type JSX, For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@synsci/ui/button"
import type { Provider } from "@synsci/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { FONT_CODE, FONT_SANS, sectionTitle } from "@/styles/tokens"
import { StatusDot } from "@/atlas/shared/StatusDot"
import { settingsApi } from "./api"

type FieldSpec = {
  name: string
  label: string
  type: "password" | "text" | "textarea"
  optional: boolean
  placeholder?: string
}
type Service = {
  id: string
  label: string
  description: string
  custom: boolean
  fields: FieldSpec[]
  connected: boolean
  set_fields: string[]
  updated_at: string | null
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI",
  deepseek: "DeepSeek",
}
const BYOK_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "groq", "mistral", "xai", "deepseek"] as const

// Where a connected provider's credential actually lives. Only "api" keys sit in
// the local auth store — the others reappear after a remove, so remove is gated.
const SOURCE_INFO: Record<Provider["source"], { label: string; removable: boolean; title: string }> = {
  api: { label: "settings.credentials.source.api", removable: true, title: "settings.credentials.source.api.title" },
  env: {
    label: "settings.credentials.source.env",
    removable: false,
    title: "settings.credentials.source.env.title",
  },
  config: {
    label: "settings.credentials.source.config",
    removable: false,
    title: "settings.credentials.source.config.title",
  },
  custom: {
    label: "settings.credentials.source.custom",
    removable: false,
    title: "settings.credentials.source.custom.title",
  },
}

export const Credentials: Component = () => {
  const lang = useLanguage()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const providers = useProviders()

  const base = () => sdk.url
  const fetchFn = () => platform.fetch ?? fetch

  const [services, setServices] = createSignal<Service[]>([])
  const [error, setError] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [editing, setEditing] = createSignal<string>()
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [saving, setSaving] = createSignal(false)

  const load = async () => {
    setError(undefined)
    try {
      const res = await settingsApi<{ services: Service[] }>(base(), fetchFn(), "/settings/credentials")
      setServices(res.services)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  onMount(() => void load())

  const openForm = (svc: Service) => {
    setValues({})
    setEditing(editing() === svc.id ? undefined : svc.id)
  }

  const save = async (id: string, extra?: { label?: string }) => {
    if (saving()) return
    setSaving(true)
    setError(undefined)
    try {
      const res = await settingsApi<{ services: Service[] }>(
        base(),
        fetchFn(),
        `/settings/credentials/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          body: JSON.stringify({ fields: values(), ...(extra ?? {}) }),
        },
      )
      setServices(res.services)
      setEditing(undefined)
      setValues({})
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async (id: string) => {
    if (!window.confirm(lang.t("settings.credentials.confirm.removeService", { id })))
      return
    setError(undefined)
    try {
      const res = await settingsApi<{ services: Service[] }>(
        base(),
        fetchFn(),
        `/settings/credentials/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        },
      )
      setServices(res.services)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return services()
    return services().filter((s) => s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
  })
  const connectedCount = createMemo(() => services().filter((s) => s.connected).length)

  // ── Custom service ──
  const [customOpen, setCustomOpen] = createSignal(false)
  const [customName, setCustomName] = createSignal("")
  const [customValue, setCustomValue] = createSignal("")
  const [customField, setCustomField] = createSignal("api_key")
  const saveCustom = async () => {
    const name = customName().trim()
    const value = customValue().trim()
    const field = customField().trim() || "api_key"
    if (!name || !value) return
    const id = `custom:${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")}`
    setValues({ [field]: value })
    await save(id, { label: name })
    setCustomOpen(false)
    setCustomName("")
    setCustomValue("")
    setCustomField("api_key")
    setValues({})
  }

  // ── BYOK provider keys ──
  const [keyProvider, setKeyProvider] = createSignal<string>(BYOK_PROVIDERS[0])
  const [keyValue, setKeyValue] = createSignal("")
  const [savingKey, setSavingKey] = createSignal(false)
  const connectedProviders = createMemo(() => providers.connected().filter((p) => p.id !== "synsci"))
  // The list endpoint's generated type omits `source`, but the payload carries it
  // for every connected provider (see Provider in @synsci/sdk/v2/client).
  const sourceInfo = (p: { id: string }) => SOURCE_INFO[(p as { source?: Provider["source"] }).source ?? "api"]
  const saveKey = async () => {
    if (savingKey()) return
    const key = keyValue().trim()
    if (!key) return
    setSavingKey(true)
    setError(undefined)
    try {
      await sdk.client.auth.set({ providerID: keyProvider(), auth: { type: "api", key } })
      setKeyValue("")
      await sdk.client.global.sync()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingKey(false)
    }
  }
  const removeKey = async (providerID: string) => {
    if (!window.confirm(lang.t("settings.credentials.confirm.removeProviderKey", { provider: PROVIDER_LABEL[providerID] ?? providerID }))) return
    setError(undefined)
    try {
      await sdk.client.auth.remove({ providerID })
      await sdk.client.global.sync()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // ── Sign in with ChatGPT (Codex OAuth) — use an OpenAI plan's credits, no key ──
  // Drives the existing provider-OAuth routes: authorize() starts the local :1455
  // loopback + returns the auth URL; the client opens it; callback() long-polls
  // until the browser redirect lands (up to ~5 min) and persists the tokens.
  const [connectingCodex, setConnectingCodex] = createSignal(false)
  const codexConnected = createMemo(() => providers.connected().some((p) => p.id === "openai-codex"))
  const connectCodex = async () => {
    if (connectingCodex()) return
    setConnectingCodex(true)
    setError(undefined)
    try {
      const { data } = await sdk.client.provider.oauth.authorize({ providerID: "openai-codex", method: 0 })
      if (data?.url) platform.openLink(data.url)
      await sdk.client.provider.oauth.callback({ providerID: "openai-codex", method: 0 })
      await sdk.client.global.sync()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnectingCodex(false)
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">{lang.t("settings.credentials.heading")}</h2>
          <p class="text-13-regular text-text-weak">
            {lang.t("settings.credentials.description")}
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 px-4 pb-10 sm:px-8 max-w-[760px]">
        <Show when={error()}>
          <div
            style={{
              "font-family": FONT_SANS,
              "font-size": "12px",
              "line-height": 1.5,
              color: "var(--color-error)",
              border: "1px solid var(--color-error-muted)",
              "border-radius": "4px",
              padding: "10px 12px",
              "white-space": "pre-wrap",
            }}
          >
            {error()}
          </div>
        </Show>

        {/* Services */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-col gap-1">
              <h3 class="text-13-medium text-text-weak tracking-wide">{lang.t("settings.credentials.section.services")}</h3>
              <p class="text-12-regular text-text-weak">
                {lang.t("settings.credentials.section.services.description", { connected: connectedCount(), total: services().length })}
              </p>
            </div>
            <input
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder={lang.t("settings.credentials.placeholder.search")}
              style={{ ...fieldStyle(), width: "180px" }}
            />
          </div>

          <div style={{ border: "1px solid var(--color-border)", "border-radius": "4px", overflow: "hidden" }}>
            <For each={filtered()}>
              {(svc) => (
                <div class="border-b border-border-weak-base last:border-none">
                  <div class="flex items-center justify-between gap-3 px-4 py-3.5">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <StatusDot status={svc.connected ? "active" : "muted"} />
                      <div class="flex flex-col min-w-0">
                        <span class="text-13-medium text-text-strong truncate">{svc.label}</span>
                        <span class="text-12-regular text-text-weak truncate">
                          <Show when={svc.connected} fallback={svc.description}>
                            {lang.t("settings.credentials.status.connected")} · {svc.set_fields.join(", ")}
                          </Show>
                        </span>
                      </div>
                    </div>
                    <div class="flex gap-2 flex-shrink-0">
                      <Show when={svc.connected}>
                        <Button size="small" variant="secondary" onClick={() => void disconnect(svc.id)}>
                          {lang.t("common.remove")}
                        </Button>
                      </Show>
                      <Button
                        size="small"
                        variant={svc.connected ? "secondary" : "primary"}
                        onClick={() => openForm(svc)}
                      >
                        {editing() === svc.id ? lang.t("common.cancel") : svc.connected ? lang.t("settings.credentials.action.update") : lang.t("common.connect")}
                      </Button>
                    </div>
                  </div>

                  <Show when={editing() === svc.id}>
                    <form
                      class="flex flex-col gap-2.5 px-4 pb-4"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void save(svc.id)
                      }}
                    >
                      <For each={svc.fields}>
                        {(f) => (
                          <label class="flex flex-col gap-1">
                            <span style={eyebrow()}>
                              {f.label}
                              {f.optional ? lang.t("settings.credentials.form.optional") : ""}
                              <Show when={svc.set_fields.includes(f.name)}> {lang.t("settings.credentials.status.saved")}</Show>
                            </span>
                            <Show
                              when={f.type === "textarea"}
                              fallback={
                                <input
                                  type={f.type === "password" ? "password" : "text"}
                                  autocomplete="off"
                                  spellcheck={false}
                                  placeholder={
                                    f.placeholder ??
                                    (svc.set_fields.includes(f.name) ? lang.t("settings.credentials.placeholder.keepExisting") : "")
                                  }
                                  value={values()[f.name] ?? ""}
                                  onInput={(e) => setValues({ ...values(), [f.name]: e.currentTarget.value })}
                                  style={fieldStyle()}
                                />
                              }
                            >
                              <textarea
                                spellcheck={false}
                                placeholder={f.placeholder}
                                value={values()[f.name] ?? ""}
                                onInput={(e) => setValues({ ...values(), [f.name]: e.currentTarget.value })}
                                style={{ ...fieldStyle(), height: "88px", padding: "8px 12px", resize: "vertical" }}
                              />
                            </Show>
                          </label>
                        )}
                      </For>
                      <div class="flex gap-2">
                        <Button
                          type="button"
                          size="small"
                          variant="primary"
                          disabled={saving()}
                          onClick={() => void save(svc.id)}
                        >
                          {saving() ? lang.t("common.saving") : lang.t("common.save")}
                        </Button>
                        <Button
                          type="button"
                          size="small"
                          variant="secondary"
                          disabled={saving()}
                          onClick={() => setEditing(undefined)}
                        >
                          {lang.t("common.cancel")}
                        </Button>
                      </div>
                    </form>
                  </Show>
                </div>
              )}
            </For>
          </div>

          {/* Custom add-your-own-key */}
          <Show
            when={customOpen()}
            fallback={
              <button type="button" onClick={() => setCustomOpen(true)} style={addRowStyle()}>
                + {lang.t("settings.credentials.action.addCustomKey")}
              </button>
            }
          >
            <form
              class="flex flex-col gap-2.5"
              style={{ border: "1px solid var(--color-border)", "border-radius": "4px", padding: "16px 18px" }}
              onSubmit={(e) => {
                e.preventDefault()
                void saveCustom()
              }}
            >
              <span class="text-13-medium text-text-strong">{lang.t("settings.credentials.form.customCredential")}</span>
              <div class="flex flex-col sm:flex-row gap-2">
                <label class="flex flex-col gap-1 flex-1">
                  <span style={eyebrow()}>{lang.t("settings.credentials.form.name")}</span>
                  <input
                    value={customName()}
                    onInput={(e) => setCustomName(e.currentTarget.value)}
                    placeholder={lang.t("settings.credentials.form.name.placeholder")}
                    style={fieldStyle()}
                  />
                </label>
                <label class="flex flex-col gap-1 sm:w-[160px]">
                  <span style={eyebrow()}>{lang.t("settings.credentials.form.field")}</span>
                  <input
                    value={customField()}
                    onInput={(e) => setCustomField(e.currentTarget.value)}
                    placeholder="api_key"
                    style={fieldStyle()}
                  />
                </label>
              </div>
              <label class="flex flex-col gap-1">
                <span style={eyebrow()}>{lang.t("settings.credentials.form.value")}</span>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={customValue()}
                  onInput={(e) => setCustomValue(e.currentTarget.value)}
                  placeholder={lang.t("settings.credentials.placeholder.secretValue")}
                  style={fieldStyle()}
                />
              </label>
              <div class="flex gap-2">
                <Button
                  type="button"
                  size="small"
                  variant="primary"
                  disabled={saving() || !customName().trim() || !customValue().trim()}
                  onClick={() => void saveCustom()}
                >
                  {lang.t("common.save")}
                </Button>
                <Button type="button" size="small" variant="secondary" onClick={() => setCustomOpen(false)}>
                  {lang.t("common.cancel")}
                </Button>
              </div>
            </form>
          </Show>
        </div>

        {/* Provider keys (BYOK) */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <h3 class="text-13-medium text-text-weak tracking-wide">{lang.t("settings.credentials.section.providerKeys")}</h3>
            <p class="text-12-regular text-text-weak">
              {lang.t("settings.credentials.section.providerKeys.description")}
            </p>
          </div>

          {/* Sign in with ChatGPT (Codex OAuth) — an OpenAI plan's credits, no key */}
          <div
            class="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between"
            style={{ border: "1px solid var(--color-border)", "border-radius": "4px", padding: "14px 18px" }}
          >
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="text-13-medium text-text-base">{lang.t("settings.credentials.section.chatgpt.title")}</span>
              <span class="text-12-regular text-text-weak">
                {lang.t("settings.credentials.section.chatgpt.description")}
              </span>
            </div>
            <Show
              when={!codexConnected()}
              fallback={
                <div class="flex items-center gap-2 shrink-0">
                  <StatusDot status="active" size={8} />
                  <span class="text-12-regular text-text-weak">{lang.t("settings.credentials.status.connected")}</span>
                  <Button size="small" variant="secondary" onClick={() => void removeKey("openai-codex")}>
                    {lang.t("common.disconnect")}
                  </Button>
                </div>
              }
            >
              <Button
                type="button"
                size="small"
                variant="primary"
                class="shrink-0"
                disabled={connectingCodex()}
                onClick={() => void connectCodex()}
              >
                {connectingCodex() ? lang.t("settings.credentials.status.waitingForChatgpt") : lang.t("settings.credentials.section.chatgpt.title")}
              </Button>
            </Show>
          </div>

          <form
            class="flex flex-col sm:flex-row gap-2 sm:items-end"
            style={{ border: "1px solid var(--color-border)", "border-radius": "4px", padding: "16px 18px" }}
            onSubmit={(e) => {
              e.preventDefault()
              void saveKey()
            }}
          >
            <label class="flex flex-col gap-1 sm:w-[180px]">
              <span style={eyebrow()}>{lang.t("settings.credentials.form.provider")}</span>
              <select
                value={keyProvider()}
                onChange={(e) => setKeyProvider(e.currentTarget.value)}
                style={fieldStyle()}
              >
                <For each={BYOK_PROVIDERS}>{(id) => <option value={id}>{PROVIDER_LABEL[id] ?? id}</option>}</For>
              </select>
            </label>
            <label class="flex flex-col gap-1 flex-1 min-w-0">
              <span style={eyebrow()}>{lang.t("settings.credentials.form.apiKey")}</span>
              <input
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={keyValue()}
                onInput={(e) => setKeyValue(e.currentTarget.value)}
                placeholder="sk-…"
                style={fieldStyle()}
              />
            </label>
            <Button
              type="button"
              size="small"
              variant="primary"
              disabled={savingKey() || !keyValue().trim()}
              onClick={() => void saveKey()}
            >
              {savingKey() ? lang.t("common.saving") : lang.t("settings.credentials.action.saveKey")}
            </Button>
          </form>

          <Show when={connectedProviders().length > 0}>
            <div style={{ border: "1px solid var(--color-border)", "border-radius": "4px", overflow: "hidden" }}>
              <For each={connectedProviders()}>
                {(p) => (
                  <div class="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-border-weak-base last:border-none">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <StatusDot status="active" />
                      <span class="text-13-regular text-text-strong truncate">{PROVIDER_LABEL[p.id] ?? p.id}</span>
                      <span
                        class="flex-shrink-0 px-2 py-0.5 rounded-full text-11-regular border"
                        style={{
                          color: "var(--color-text-faint)",
                          "border-color": "var(--color-border)",
                          background: "transparent",
                        }}
                        title={lang.t(sourceInfo(p).title)}
                      >
                        {lang.t(sourceInfo(p).label)}
                      </span>
                    </div>
                    <Show
                      when={sourceInfo(p).removable}
                      fallback={
                        <span title={lang.t(sourceInfo(p).title)}>
                          <Button size="small" variant="secondary" disabled>
                            {lang.t("common.remove")}
                          </Button>
                        </span>
                      }
                    >
                      <Button size="small" variant="secondary" onClick={() => void removeKey(p.id)}>
                        {lang.t("common.remove")}
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

export default Credentials

function eyebrow(): JSX.CSSProperties {
  return sectionTitle
}

function fieldStyle(): JSX.CSSProperties {
  return {
    all: "unset",
    "box-sizing": "border-box",
    width: "100%",
    height: "36px",
    padding: "0 12px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-surface-solid, var(--color-bg))",
    "font-family": FONT_CODE,
    "font-size": "13px",
    "line-height": 1.5,
    color: "var(--color-text)",
    cursor: "text",
  }
}

function addRowStyle(): JSX.CSSProperties {
  return {
    all: "unset",
    "box-sizing": "border-box",
    cursor: "pointer",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    height: "40px",
    "border-radius": "4px",
    border: "1px dashed var(--color-border-strong)",
    "font-family": FONT_SANS,
    "font-size": "12px",
    color: "var(--color-text-weak)",
  }
}
