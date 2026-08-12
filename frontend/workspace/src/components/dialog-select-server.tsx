import { createResource, createEffect, createMemo, onCleanup, Show, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useDialog } from "@synsci/ui/context/dialog"
import { Dialog } from "@synsci/ui/dialog"
import { List } from "@synsci/ui/list"
import { Button } from "@synsci/ui/button"
import { IconButton } from "@synsci/ui/icon-button"
import { TextField } from "@synsci/ui/text-field"
import { normalizeServerUrl, serverDisplayName, useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { createOpenScienceClient } from "@synsci/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { DropdownMenu } from "@synsci/ui/dropdown-menu"
import { Tooltip } from "@synsci/ui/tooltip"
import { showToast } from "@synsci/ui/toast"
import "./dialog-select-server.css"

type ServerStatus = { healthy: boolean; version?: string }

function serverVersionLabel(value: string) {
  return value.trim().toLocaleLowerCase() === "local" ? "Local" : value
}

interface AddRowProps {
  value: string
  label: string
  placeholder: string
  adding: boolean
  error: string
  status: boolean | undefined
  saveLabel: string
  cancelLabel: string
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onSave: () => void
  onCancel: () => void
}

interface EditRowProps {
  value: string
  label: string
  placeholder: string
  busy: boolean
  error: string
  status: boolean | undefined
  saveLabel: string
  cancelLabel: string
  canSave: boolean
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onSave: () => void
  onCancel: () => void
}

async function checkHealth(url: string, platform: ReturnType<typeof usePlatform>): Promise<ServerStatus> {
  const signal = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout?.(3000)
  const sdk = createOpenScienceClient({
    baseUrl: url,
    fetch: platform.fetch,
    signal,
  })
  return sdk.global
    .health()
    .then((x) => ({ healthy: x.data?.healthy === true, version: x.data?.version }))
    .catch(() => ({ healthy: false }))
}

function AddRow(props: AddRowProps) {
  return (
    <form
      class="server-dialog__form"
      aria-label={props.label}
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave()
      }}
    >
      <div class="server-dialog__form-field [&_[data-slot=input-wrapper]]:relative">
        <div
          classList={{
            "size-1.5 rounded-full absolute left-3 top-1/2 -translate-y-1/2 z-10 pointer-events-none": true,
            "bg-icon-success-base": props.status === true,
            "bg-icon-critical-base": props.status === false,
            "bg-border-weak-base": props.status === undefined,
          }}
          ref={(el) => {
            // Position relative to input-wrapper
            requestAnimationFrame(() => {
              const wrapper = el.parentElement?.querySelector('[data-slot="input-wrapper"]')
              if (wrapper instanceof HTMLElement) {
                wrapper.appendChild(el)
              }
            })
          }}
        />
        <TextField
          type="text"
          label={props.label}
          hideLabel
          placeholder={props.placeholder}
          value={props.value}
          autofocus
          validationState={props.error ? "invalid" : "valid"}
          error={props.error}
          disabled={props.adding}
          onChange={props.onChange}
          onKeyDown={props.onKeyDown}
          class="pl-7"
        />
      </div>
      <div class="server-dialog__form-actions">
        <Button type="button" size="normal" variant="ghost" disabled={props.adding} onClick={props.onCancel}>
          {props.cancelLabel}
        </Button>
        <Button type="submit" size="normal" variant="primary" disabled={props.adding || !props.value.trim()}>
          {props.saveLabel}
        </Button>
      </div>
    </form>
  )
}

function EditRow(props: EditRowProps) {
  return (
    <form
      class="server-dialog__form"
      aria-label={props.label}
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave()
      }}
    >
      <div
        classList={{
          "server-dialog__status mt-[13px]": true,
          "bg-icon-success-base": props.status === true,
          "bg-icon-critical-base": props.status === false,
          "bg-border-weak-base": props.status === undefined,
        }}
      />
      <div class="server-dialog__form-field">
        <TextField
          type="text"
          label={props.label}
          hideLabel
          placeholder={props.placeholder}
          value={props.value}
          autofocus
          validationState={props.error ? "invalid" : "valid"}
          error={props.error}
          disabled={props.busy}
          onChange={props.onChange}
          onKeyDown={props.onKeyDown}
        />
      </div>
      <div class="server-dialog__form-actions">
        <Button type="button" size="normal" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          {props.cancelLabel}
        </Button>
        <Button type="submit" size="normal" variant="primary" disabled={props.busy || !props.canSave}>
          {props.saveLabel}
        </Button>
      </div>
    </form>
  )
}

export function DialogSelectServer() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const [store, setStore] = createStore({
    status: {} as Record<string, ServerStatus | undefined>,
    addServer: {
      url: "",
      adding: false,
      error: "",
      showForm: false,
      status: undefined as boolean | undefined,
    },
    editServer: {
      id: undefined as string | undefined,
      value: "",
      error: "",
      busy: false,
      status: undefined as boolean | undefined,
    },
  })
  const [defaultUrl, defaultUrlActions] = createResource(
    async () => {
      try {
        const url = await platform.getDefaultServerUrl?.()
        if (!url) return null
        return normalizeServerUrl(url) ?? null
      } catch (err) {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },
    { initialValue: null },
  )
  const canDefault = createMemo(() => !!platform.getDefaultServerUrl && !!platform.setDefaultServerUrl)

  const looksComplete = (value: string) => {
    const normalized = normalizeServerUrl(value)
    if (!normalized) return false
    const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
    if (!host) return false
    if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
    return host.includes(".") || host.includes(":")
  }

  const previewStatus = async (value: string, setStatus: (value: boolean | undefined) => void) => {
    setStatus(undefined)
    if (!looksComplete(value)) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) return
    const result = await checkHealth(normalized, platform)
    setStatus(result.healthy)
  }

  const resetAdd = () => {
    setStore("addServer", {
      url: "",
      error: "",
      showForm: false,
      status: undefined,
    })
  }

  const resetEdit = () => {
    setStore("editServer", {
      id: undefined,
      value: "",
      error: "",
      status: undefined,
      busy: false,
    })
  }

  const replaceServer = (original: string, next: string) => {
    const active = server.url
    const nextActive = active === original ? next : active

    server.add(next)
    if (nextActive) server.setActive(nextActive)
    server.remove(original)
  }

  const items = createMemo(() => {
    const current = server.url
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const current = createMemo(() => items().find((x) => x === server.url) ?? items()[0])

  const sortedItems = createMemo(() => {
    const list = items()
    if (!list.length) return list
    const active = current()
    const order = new Map(list.map((url, index) => [url, index] as const))
    const rank = (value?: ServerStatus) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff = rank(store.status[a]) - rank(store.status[b])
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  async function refreshHealth() {
    const results: Record<string, ServerStatus> = {}
    await Promise.all(
      items().map(async (url) => {
        results[url] = await checkHealth(url, platform)
      }),
    )
    setStore("status", reconcile(results))
  }

  createEffect(() => {
    items()
    refreshHealth()
    const interval = setInterval(refreshHealth, 10_000)
    onCleanup(() => clearInterval(interval))
  })

  async function select(value: string, persist?: boolean) {
    if (!persist && store.status[value]?.healthy === false) return
    dialog.close()
    if (persist) {
      server.add(value)
      navigate("/")
      return
    }
    server.setActive(value)
    navigate("/")
  }

  const handleAddChange = (value: string) => {
    if (store.addServer.adding) return
    setStore("addServer", { url: value, error: "" })
    void previewStatus(value, (next) => setStore("addServer", { status: next }))
  }

  const scrollListToBottom = () => {
    const scroll = document.querySelector<HTMLDivElement>('[data-component="list"] [data-slot="list-scroll"]')
    if (!scroll) return
    requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight
    })
  }

  const handleEditChange = (value: string) => {
    if (store.editServer.busy) return
    setStore("editServer", { value, error: "" })
    void previewStatus(value, (next) => setStore("editServer", { status: next }))
  }

  async function handleAdd(value: string) {
    if (store.addServer.adding) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) {
      resetAdd()
      return
    }

    setStore("addServer", { adding: true, error: "" })

    const result = await checkHealth(normalized, platform)
    setStore("addServer", { adding: false })

    if (!result.healthy) {
      setStore("addServer", { error: language.t("dialog.server.add.error") })
      return
    }

    resetAdd()
    await select(normalized, true)
  }

  async function handleEdit(original: string, value: string) {
    if (store.editServer.busy) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) {
      resetEdit()
      return
    }

    if (normalized === original) {
      resetEdit()
      return
    }

    setStore("editServer", { busy: true, error: "" })

    const result = await checkHealth(normalized, platform)
    setStore("editServer", { busy: false })

    if (!result.healthy) {
      setStore("editServer", { error: language.t("dialog.server.add.error") })
      return
    }

    replaceServer(original, normalized)

    resetEdit()
  }

  const handleAddKey = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      resetAdd()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    handleAdd(store.addServer.url)
  }

  const handleEditKey = (event: KeyboardEvent, original: string) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      resetEdit()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    handleEdit(original, store.editServer.value)
  }

  async function handleRemove(url: string) {
    server.remove(url)
  }

  return (
    <Dialog
      title={language.t("dialog.server.title")}
      description={language.t("dialog.server.description")}
      class="server-dialog"
      fit
      transition
    >
      <div class="server-dialog__content">
        <List
          search={{ placeholder: language.t("dialog.server.search.placeholder"), autofocus: false }}
          noInitialSelection
          emptyMessage={language.t("dialog.server.empty")}
          items={sortedItems}
          key={(x) => x}
          onSelect={(x) => {
            if (x) select(x)
          }}
          onFilter={(value) => {
            if (value && store.addServer.showForm && !store.addServer.adding) {
              resetAdd()
            }
          }}
          itemWrapper={(item, node) => (
            <Show when={store.editServer.id === item} fallback={node}>
              <div data-slot="list-item-editor" data-key={item} class="server-dialog__editor">
                <EditRow
                  value={store.editServer.value}
                  label={language.t("dialog.server.add.url")}
                  placeholder={language.t("dialog.server.add.placeholder")}
                  busy={store.editServer.busy}
                  error={store.editServer.error}
                  status={store.editServer.status}
                  saveLabel={language.t("dialog.server.action.save")}
                  cancelLabel={language.t("dialog.server.action.cancel")}
                  canSave={Boolean(store.editServer.value.trim()) && store.editServer.value !== item}
                  onChange={handleEditChange}
                  onKeyDown={(event) => handleEditKey(event, item)}
                  onSave={() => void handleEdit(item, store.editServer.value)}
                  onCancel={resetEdit}
                />
              </div>
            </Show>
          )}
          divider={true}
          class="server-dialog__list"
          add={
            store.addServer.showForm
              ? {
                  render: () => (
                    <AddRow
                      value={store.addServer.url}
                      label={language.t("dialog.server.add.url")}
                      placeholder={language.t("dialog.server.add.placeholder")}
                      adding={store.addServer.adding}
                      error={store.addServer.error}
                      status={store.addServer.status}
                      saveLabel={
                        store.addServer.adding
                          ? language.t("dialog.server.add.checking")
                          : language.t("dialog.server.add.button")
                      }
                      cancelLabel={language.t("dialog.server.action.cancel")}
                      onChange={handleAddChange}
                      onKeyDown={handleAddKey}
                      onSave={() => void handleAdd(store.addServer.url)}
                      onCancel={resetAdd}
                    />
                  ),
                }
              : undefined
          }
        >
          {(i) => {
            const [truncated, setTruncated] = createSignal(false)
            let nameRef: HTMLSpanElement | undefined
            let versionRef: HTMLSpanElement | undefined

            const check = () => {
              const nameTruncated = nameRef ? nameRef.scrollWidth > nameRef.clientWidth : false
              const versionTruncated = versionRef ? versionRef.scrollWidth > versionRef.clientWidth : false
              setTruncated(nameTruncated || versionTruncated)
            }

            createEffect(() => {
              check()
              window.addEventListener("resize", check)
              onCleanup(() => window.removeEventListener("resize", check))
            })

            const tooltipValue = () => {
              const name = serverDisplayName(i)
              const version = store.status[i]?.version
              return (
                <span class="flex items-center gap-2">
                  <span>{name}</span>
                  <Show when={version}>
                    <span class="text-text-invert-base">{version}</span>
                  </Show>
                </span>
              )
            }

            return (
              <div class="server-dialog__row group/item">
                <Tooltip value={tooltipValue()} placement="top" inactive={!truncated()}>
                  <div class="server-dialog__identity" classList={{ "opacity-50": store.status[i]?.healthy === false }}>
                    <div
                      classList={{
                        "server-dialog__status": true,
                        "bg-icon-success-base": store.status[i]?.healthy === true,
                        "bg-icon-critical-base": store.status[i]?.healthy === false,
                        "bg-border-weak-base": store.status[i] === undefined,
                      }}
                    />
                    <span ref={nameRef} class="server-dialog__name">
                      {serverDisplayName(i)}
                    </span>
                    <Show when={store.status[i]?.version}>
                      {(version) => (
                        <span ref={versionRef} class="server-dialog__badge">
                          {serverVersionLabel(version())}
                        </span>
                      )}
                    </Show>
                    <Show when={defaultUrl() === i}>
                      <span class="server-dialog__badge">{language.t("dialog.server.status.default")}</span>
                    </Show>
                    <Show when={current() === i}>
                      <span class="server-dialog__badge server-dialog__badge--current">
                        {language.t("dialog.server.current")}
                      </span>
                    </Show>
                  </div>
                </Tooltip>
                <div class="server-dialog__actions">
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="more-horizontal"
                      variant="ghost"
                      class="server-dialog__menu-button"
                      aria-label={language.t("common.moreOptions")}
                      onClick={(e: MouseEvent) => e.stopPropagation()}
                      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => {
                            resetAdd()
                            setStore("editServer", {
                              id: i,
                              value: i,
                              error: "",
                              status: store.status[i]?.healthy,
                            })
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <Show when={canDefault() && defaultUrl() !== i}>
                          <DropdownMenu.Item
                            onSelect={async () => {
                              try {
                                await platform.setDefaultServerUrl?.(i)
                                defaultUrlActions.mutate(i)
                              } catch (err) {
                                showToast({
                                  variant: "error",
                                  title: language.t("common.requestFailed"),
                                  description: err instanceof Error ? err.message : String(err),
                                })
                              }
                            }}
                          >
                            <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.default")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={canDefault() && defaultUrl() === i}>
                          <DropdownMenu.Item
                            onSelect={async () => {
                              try {
                                await platform.setDefaultServerUrl?.(null)
                                defaultUrlActions.mutate(null)
                              } catch (err) {
                                showToast({
                                  variant: "error",
                                  title: language.t("common.requestFailed"),
                                  description: err instanceof Error ? err.message : String(err),
                                })
                              }
                            }}
                          >
                            <DropdownMenu.ItemLabel>
                              {language.t("dialog.server.menu.defaultRemove")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          onSelect={() => handleRemove(i)}
                          class="text-text-on-critical-base hover:bg-surface-critical-weak"
                        >
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.delete")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>
            )
          }}
        </List>

        <Show when={!store.addServer.showForm}>
          <div class="server-dialog__footer">
            <Button
              variant="ghost"
              icon="plus-small"
              size="normal"
              onClick={() => {
                resetEdit()
                setStore("addServer", { showForm: true, url: "", error: "", status: undefined })
                scrollListToBottom()
              }}
              class="server-dialog__add-button"
            >
              {language.t("dialog.server.add.button")}
            </Button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
