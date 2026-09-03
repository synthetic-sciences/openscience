import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { type Component, type JSX, For, Show, createMemo, createSignal, onMount } from "solid-js"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"
import { ProviderLogo } from "./ProviderLogo"
import { customCredentialIdentity } from "./custom-credential"
import { invalidateCredentials, loadCredentials, type Service } from "./credential-loader"
import { invalidateScientificTools } from "./scientific-tools-loader"

export const CredentialServices: Component<{
  category: "compute" | "integration"
  title: string
  description: string
  custom?: boolean
}> = (props) => {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const [services, setServices] = createSignal<Service[]>([])
  const [error, setError] = createSignal<string>()
  const [editing, setEditing] = createSignal<string>()
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [saving, setSaving] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [custom, setCustom] = createSignal(false)
  const [name, setName] = createSignal("")
  const [field, setField] = createSignal("api_key")
  const [secret, setSecret] = createSignal("")
  const category = (service: Service) => {
    if (service.category) return service.category
    if (["aws", "gcp", "azure"].includes(service.id)) return "compute"
    if (service.id === "modal") return undefined
    return "integration"
  }
  const items = createMemo(() => services().filter((service) => category(service) === props.category))
  const count = createMemo(() => items().filter((service) => service.connected).length)

  const load = async (refresh = false) => {
    setLoading(true)
    setError(undefined)
    const result = await loadCredentials(sdk.url, platform.fetch ?? fetch, refresh).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    if (result) setServices(result.services)
    setLoading(false)
  }

  onMount(() => void load())

  const open = (id: string) => {
    if (saving()) return
    setValues({})
    setEditing(editing() === id ? undefined : id)
  }

  const ready = (service: Service) => {
    const required = service.fields.filter((item) => !item.optional)
    if (required.length) {
      return required.every(
        (item) =>
          (service.source !== "account" && service.set_fields.includes(item.name)) ||
          Boolean(values()[item.name]?.trim()),
      )
    }
    return service.fields.some(
      (item) =>
        (service.source !== "account" && service.set_fields.includes(item.name)) ||
        Boolean(values()[item.name]?.trim()),
    )
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
    invalidateCredentials(sdk.url)
    invalidateScientificTools(sdk.url)
    setServices(result.services)
    setEditing(undefined)
    setValues({})
    return true
  }

  const remove = async (service: Service) => {
    if (saving()) return
    const confirmed = await confirmDialog(dialog, {
      title: `Remove ${service.label} credentials?`,
      message: "This removes the saved credentials from this machine. It does not change external cloud resources.",
      confirmLabel: "Remove credentials",
      danger: true,
    })
    if (!confirmed) return
    setSaving(true)
    setError(undefined)
    try {
      const result = await settingsApi<{ services: Service[] }>(
        sdk.url,
        platform.fetch ?? fetch,
        `/settings/credentials/${encodeURIComponent(service.id)}`,
        { method: "DELETE" },
      ).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        return undefined
      })
      if (result) {
        invalidateCredentials(sdk.url)
        invalidateScientificTools(sdk.url)
        setServices(result.services)
        if (editing() === service.id) setEditing(undefined)
      }
    } finally {
      setSaving(false)
    }
  }

  const add = async () => {
    const value = secret().trim()
    const identity = customCredentialIdentity(name(), field())
    if (!value || !identity.ok) {
      if (!identity.ok) setError(identity.error)
      return
    }
    const saved = await save(identity.id, { [identity.field]: value }, identity.label)
    if (!saved) return
    setCustom(false)
    setName("")
    setField("api_key")
    setSecret("")
  }

  return (
    <section class="credential-services settings-section">
      <div class="settings-section-heading flex-wrap">
        <div class="min-w-0 flex-1 basis-[240px]">
          <h3>{props.title}</h3>
          <p>{props.description}</p>
        </div>
        <span class="ml-auto shrink-0">{loading() ? "Loading…" : `${count()} saved`}</span>
      </div>

      <Show when={error()}>
        <div class="settings-alert" data-tone="critical" role="alert">
          <span>{error()}</span>
          <Button
            size="small"
            variant="secondary"
            class="settings-panel-action"
            disabled={loading() || saving()}
            onClick={() => void load(true)}
          >
            Retry
          </Button>
        </div>
      </Show>

      <Show
        when={!loading()}
        fallback={
          <div class="settings-panel-loading__rows" role="status" aria-label="Loading services">
            <span />
            <span />
            <span />
          </div>
        }
      >
        <Show
          when={items().length > 0}
          fallback={
            <div class="settings-card">
              <p class="settings-card-empty" role="status">
                No services are available from this server.
              </p>
            </div>
          }
        >
          <div class="settings-list settings-card">
            <For each={items()}>
              {(service) => (
                <div class="settings-list-item">
                  <div class="settings-list-row">
                    <ProviderLogo id={service.id} label={service.label} />
                    <div class="settings-list-copy">
                      <div class="flex min-w-0 flex-wrap items-center gap-2">
                        <strong>{service.label}</strong>
                        <Show when={service.connected}>
                          <span class="settings-chip">
                            {service.source === "account" ? "Workspace" : "Credential saved"}
                          </span>
                        </Show>
                      </div>
                      <span>{service.description}</span>
                      <Show when={service.connected}>
                        <span>
                          {service.source === "account" ? "Synced from your workspace" : "Encrypted on this machine"}
                          {service.set_fields.length
                            ? ` · ${service.set_fields.length} field${service.set_fields.length === 1 ? "" : "s"} saved`
                            : ""}
                        </span>
                      </Show>
                    </div>
                    <div class="settings-list-actions ml-auto max-w-full flex-wrap justify-end">
                      <Show when={service.connected && service.source !== "account"}>
                        <button
                          type="button"
                          class="settings-icon-action"
                          disabled={saving()}
                          aria-label={`Remove ${service.label} credentials`}
                          title="Remove credentials"
                          onClick={() => void remove(service)}
                        >
                          <Icon name="trash" size="small" />
                        </button>
                      </Show>
                      <Show when={service.source === "account"}>
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() =>
                            platform.openLink(
                              service.organization_id
                                ? `https://app.syntheticsciences.ai/workspace/${encodeURIComponent(service.organization_id)}/credentials`
                                : "https://app.syntheticsciences.ai/integrations",
                            )
                          }
                        >
                          Manage
                        </Button>
                      </Show>
                      <Button size="small" variant="secondary" disabled={saving()} onClick={() => open(service.id)}>
                        {editing() === service.id
                          ? "Cancel"
                          : service.source === "account"
                            ? "Use local key"
                            : service.connected
                              ? "Update"
                              : "Add credential"}
                      </Button>
                    </div>
                  </div>

                  <Show when={editing() === service.id}>
                    <form
                      class="credential-form min-w-0"
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
                                  disabled={saving()}
                                  value={values()[item.name] ?? ""}
                                  placeholder={
                                    item.placeholder ??
                                    (service.set_fields.includes(item.name) ? "Leave blank to keep saved value" : "")
                                  }
                                  onInput={(event) =>
                                    setValues({ ...values(), [item.name]: event.currentTarget.value })
                                  }
                                />
                              }
                            >
                              <textarea
                                autocomplete="off"
                                spellcheck={false}
                                disabled={saving()}
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
                      <div class="credential-form-actions max-w-full flex-wrap">
                        <Button type="submit" size="small" variant="primary" disabled={saving() || !ready(service)}>
                          {saving() ? "Saving…" : "Save credential"}
                        </Button>
                        <Button
                          type="button"
                          size="small"
                          variant="ghost"
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
        </Show>
      </Show>

      <Show when={props.custom}>
        <Show
          when={custom()}
          fallback={
            <button
              class="settings-add-row inline-flex items-center gap-1.5"
              type="button"
              disabled={loading() || saving()}
              onClick={() => setCustom(true)}
            >
              <Icon name="plus" size="small" />
              Add custom credential
            </button>
          }
        >
          <form
            class="credential-form credential-form--custom settings-card min-w-0"
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
            <p class="break-words">OpenScience will make this available as SERVICE_NAME_ENVIRONMENT_FIELD.</p>
            <div class="credential-form-actions max-w-full flex-wrap">
              <Button
                type="submit"
                size="small"
                variant="primary"
                disabled={saving() || !secret().trim() || !customCredentialIdentity(name(), field()).ok}
              >
                {saving() ? "Saving…" : "Save credential"}
              </Button>
              <Button type="button" size="small" variant="ghost" disabled={saving()} onClick={() => setCustom(false)}>
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
