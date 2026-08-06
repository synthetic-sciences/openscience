// Credentials — non-model external-service secrets encrypted at rest via
// /settings/credentials. Model keys and ChatGPT access live in Models.
import { type Component, type JSX, For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@synsci/ui/button"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
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

export const Credentials: Component = () => {
  const sdk = useGlobalSDK()
  const platform = usePlatform()

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
    if (!window.confirm(`Remove stored credentials for ${id}? This deletes the encrypted secrets from this machine.`))
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

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">Credentials</h2>
          <p class="text-13-regular text-text-weak">
            Connect non-model services and environment values. Secrets are encrypted on this machine and never shown
            again after you save them.
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
              <h3 class="text-13-medium text-text-weak tracking-wide">Services</h3>
              <p class="text-12-regular text-text-weak">
                Keys for the tools and clouds your research uses. {connectedCount()} of {services().length} connected.
              </p>
            </div>
            <input
              aria-label="Search credential services"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search services…"
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
                            Connected · {svc.set_fields.join(", ")}
                          </Show>
                        </span>
                      </div>
                    </div>
                    <div class="flex gap-2 flex-shrink-0">
                      <Show when={svc.connected}>
                        <Button
                          size="small"
                          variant="secondary"
                          aria-label={`Remove ${svc.label}`}
                          onClick={() => void disconnect(svc.id)}
                        >
                          Remove
                        </Button>
                      </Show>
                      <Button
                        size="small"
                        variant={svc.connected ? "secondary" : "primary"}
                        aria-label={`${svc.connected ? "Update" : "Connect"} ${svc.label}`}
                        onClick={() => openForm(svc)}
                      >
                        {editing() === svc.id ? "Cancel" : svc.connected ? "Update" : "Connect"}
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
                              {f.optional ? " (optional)" : ""}
                              <Show when={svc.set_fields.includes(f.name)}> · saved</Show>
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
                                    (svc.set_fields.includes(f.name) ? "•••••• (Leave blank to keep)" : "")
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
                          {saving() ? "Saving…" : "Save"}
                        </Button>
                        <Button
                          type="button"
                          size="small"
                          variant="secondary"
                          disabled={saving()}
                          onClick={() => setEditing(undefined)}
                        >
                          Cancel
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
                + Add custom key
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
              <span class="text-13-medium text-text-strong">Custom credential</span>
              <div class="flex flex-col sm:flex-row gap-2">
                <label class="flex flex-col gap-1 flex-1">
                  <span style={eyebrow()}>Name</span>
                  <input
                    value={customName()}
                    onInput={(e) => setCustomName(e.currentTarget.value)}
                    placeholder="My service"
                    style={fieldStyle()}
                  />
                </label>
                <label class="flex flex-col gap-1 sm:w-[160px]">
                  <span style={eyebrow()}>Field</span>
                  <input
                    value={customField()}
                    onInput={(e) => setCustomField(e.currentTarget.value)}
                    placeholder="api_key"
                    style={fieldStyle()}
                  />
                </label>
              </div>
              <label class="flex flex-col gap-1">
                <span style={eyebrow()}>Value</span>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={customValue()}
                  onInput={(e) => setCustomValue(e.currentTarget.value)}
                  placeholder="Secret value"
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
                  Save
                </Button>
                <Button type="button" size="small" variant="secondary" onClick={() => setCustomOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
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
