import { Button } from "@synsci/ui/button"
import { type Component, type JSX, For, Show, createMemo, createSignal, onMount } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"
import { ProviderLogo } from "./ProviderLogo"

type Field = {
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
  category?: "compute" | "integration"
  custom: boolean
  fields: Field[]
  connected: boolean
  set_fields: string[]
  updated_at: string | null
}

export const CredentialServices: Component<{
  category: "compute" | "integration"
  title: string
  description: string
  custom?: boolean
}> = (props) => {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const [services, setServices] = createSignal<Service[]>([])
  const [error, setError] = createSignal<string>()
  const [editing, setEditing] = createSignal<string>()
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [saving, setSaving] = createSignal(false)
  const [custom, setCustom] = createSignal(false)
  const [name, setName] = createSignal("")
  const [field, setField] = createSignal("api_key")
  const [secret, setSecret] = createSignal("")
  const category = (service: Service) => {
    if (service.category) return service.category
    if (["aws", "gcp", "azure", "nvidia"].includes(service.id)) return "compute"
    if (service.id === "modal") return undefined
    return "integration"
  }
  const items = createMemo(() => services().filter((service) => category(service) === props.category))
  const count = createMemo(() => items().filter((service) => service.connected).length)

  const load = async () => {
    setError(undefined)
    const result = await settingsApi<{ services: Service[] }>(
      sdk.url,
      platform.fetch ?? fetch,
      "/settings/credentials",
    ).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    if (result) setServices(result.services)
  }

  onMount(() => void load())

  const open = (id: string) => {
    setValues({})
    setEditing(editing() === id ? undefined : id)
  }

  const ready = (service: Service) => {
    const required = service.fields.filter((item) => !item.optional)
    if (required.length) {
      return required.every((item) => service.set_fields.includes(item.name) || Boolean(values()[item.name]?.trim()))
    }
    return service.fields.some((item) => service.set_fields.includes(item.name) || Boolean(values()[item.name]?.trim()))
  }

  const save = async (id: string, fields = values(), label?: string) => {
    if (saving()) return false
    setSaving(true)
    setError(undefined)
    const result = await settingsApi<{ services: Service[] }>(
      sdk.url,
      platform.fetch ?? fetch,
      `/settings/credentials/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: JSON.stringify({ fields, ...(label ? { label } : {}) }),
      },
    ).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    setSaving(false)
    if (!result) return false
    setServices(result.services)
    setEditing(undefined)
    setValues({})
    return true
  }

  const remove = async (service: Service) => {
    if (!window.confirm(`Remove the saved ${service.label} credentials from this machine?`)) return
    setError(undefined)
    const result = await settingsApi<{ services: Service[] }>(
      sdk.url,
      platform.fetch ?? fetch,
      `/settings/credentials/${encodeURIComponent(service.id)}`,
      { method: "DELETE" },
    ).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    if (result) setServices(result.services)
  }

  const add = async () => {
    const label = name().trim()
    const value = secret().trim()
    const key = field().trim() || "api_key"
    if (!label || !value) return
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    if (!slug) return
    const saved = await save(`custom:${slug}`, { [key]: value }, label)
    if (!saved) return
    setCustom(false)
    setName("")
    setField("api_key")
    setSecret("")
  }

  return (
    <section class="credential-services">
      <div class="settings-section-heading">
        <div>
          <h3>{props.title}</h3>
          <p>{props.description}</p>
        </div>
        <span>{count()} connected</span>
      </div>

      <Show when={error()}>
        <div class="settings-error" role="alert">
          {error()}
        </div>
      </Show>

      <div class="settings-list">
        <For each={items()}>
          {(service) => (
            <div class="settings-list-item">
              <div class="settings-list-row">
                <ProviderLogo id={service.id} label={service.label} connected={service.connected} />
                <div class="settings-list-copy">
                  <strong>{service.label}</strong>
                  <span>{service.connected ? "Connected and ready" : service.description}</span>
                </div>
                <div class="settings-list-actions">
                  <Show when={service.connected}>
                    <Button size="small" variant="ghost" onClick={() => void remove(service)}>
                      Remove
                    </Button>
                  </Show>
                  <Button
                    size="small"
                    variant={service.connected ? "secondary" : "primary"}
                    onClick={() => open(service.id)}
                  >
                    {editing() === service.id ? "Cancel" : service.connected ? "Update" : "Connect"}
                  </Button>
                </div>
              </div>

              <Show when={editing() === service.id}>
                <form
                  class="credential-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void save(service.id)
                  }}
                >
                  <For each={service.fields}>
                    {(item) => (
                      <label>
                        <span>
                          {item.label}
                          {item.optional ? " (optional)" : ""}
                          {service.set_fields.includes(item.name) ? " · saved" : ""}
                        </span>
                        <Show
                          when={item.type === "textarea"}
                          fallback={
                            <input
                              type={item.type === "password" ? "password" : "text"}
                              autocomplete="off"
                              spellcheck={false}
                              value={values()[item.name] ?? ""}
                              placeholder={
                                item.placeholder ??
                                (service.set_fields.includes(item.name) ? "Leave blank to keep saved value" : "")
                              }
                              onInput={(event) => setValues({ ...values(), [item.name]: event.currentTarget.value })}
                            />
                          }
                        >
                          <textarea
                            autocomplete="off"
                            spellcheck={false}
                            value={values()[item.name] ?? ""}
                            placeholder={
                              item.placeholder ??
                              (service.set_fields.includes(item.name) ? "Leave blank to keep saved value" : "")
                            }
                            onInput={(event) => setValues({ ...values(), [item.name]: event.currentTarget.value })}
                          />
                        </Show>
                      </label>
                    )}
                  </For>
                  <div class="credential-form-actions">
                    <Button type="submit" size="small" variant="primary" disabled={saving() || !ready(service)}>
                      {saving() ? "Saving…" : "Save credential"}
                    </Button>
                    <Button type="button" size="small" variant="ghost" onClick={() => setEditing(undefined)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show when={props.custom}>
        <Show
          when={custom()}
          fallback={
            <button class="settings-add-row" type="button" onClick={() => setCustom(true)}>
              Add custom credential
            </button>
          }
        >
          <form
            class="credential-form credential-form--custom"
            onSubmit={(event) => {
              event.preventDefault()
              void add()
            }}
          >
            <div class="credential-form-grid">
              <Field label="Service name" value={name()} placeholder="My service" onInput={setName} />
              <Field label="Environment field" value={field()} placeholder="api_key" onInput={setField} />
            </div>
            <Field
              label="Secret value"
              value={secret()}
              type="password"
              placeholder="Paste secret"
              onInput={setSecret}
            />
            <p>OpenScience will make this available as SERVICE_NAME_ENVIRONMENT_FIELD.</p>
            <div class="credential-form-actions">
              <Button
                type="submit"
                size="small"
                variant="primary"
                disabled={saving() || !name().trim() || !secret().trim()}
              >
                {saving() ? "Saving…" : "Save credential"}
              </Button>
              <Button type="button" size="small" variant="ghost" onClick={() => setCustom(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Show>
      </Show>
    </section>
  )
}

const Field: Component<{
  label: string
  value: string
  placeholder: string
  type?: JSX.InputHTMLAttributes<HTMLInputElement>["type"]
  onInput: (value: string) => void
}> = (props) => (
  <label>
    <span>{props.label}</span>
    <input
      type={props.type}
      autocomplete="off"
      spellcheck={false}
      value={props.value}
      placeholder={props.placeholder}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </label>
)
