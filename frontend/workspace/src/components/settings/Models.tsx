import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSync } from "@/context/global-sync"
import { useModels, type ModelKey } from "@/context/models"
import { displayProviderForModel } from "@/context/model-catalog"
import { CodexConnection } from "./CodexConnection"
import { ManagedInference } from "./ManagedInference"
import { ProviderKeys } from "./ProviderKeys"
import { MODEL_GROUPS, modelGroup } from "../model-groups"

type Option = {
  key: ModelKey
  label: string
  latest: boolean
  provider: string
  group: ReturnType<typeof modelGroup>
  pinned: boolean
  value: string
}

export default function Models() {
  const sync = useGlobalSync()
  const models = useModels()
  const [query, setQuery] = createSignal("")
  const [error, setError] = createSignal<string>()

  const options = createMemo<Option[]>(() => {
    models.pinned.list()
    return models
      .list()
      .map((item) => {
        const key = { providerID: item.provider.id, modelID: item.id }
        const pinned = models.pinned.has(key)
        return {
          group: modelGroup(item, pinned),
          key,
          label: item.name,
          latest: item.latest,
          pinned,
          provider: displayProviderForModel(item.provider, item.id).name,
          value: `${item.provider.id}/${item.id}`,
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  })
  const filtered = createMemo(() => {
    const value = query().trim().toLowerCase()
    if (!value) return options()
    return options().filter((model) => model.label.toLowerCase().includes(value))
  })
  const primary = () => options().find((model) => model.value === sync.data.config.model)
  const background = () => options().find((model) => model.value === sync.data.config.small_model)
  const groups = createMemo(() =>
    MODEL_GROUPS.map((group) => ({
      ...group,
      models: filtered().filter((model) => model.group === group.id),
    })).filter((group) => group.models.length > 0),
  )
  const [notice, setNotice] = createSignal("Pinned models stay at the top of every model picker.")

  const togglePin = (model: Option) => {
    const result = models.pinned.toggle(model.key)
    if (result.limited) {
      setNotice("Three models are already pinned. Unpin one before adding another.")
      return
    }
    if (result.pinned) models.setVisibility(model.key, true)
    setNotice(result.pinned ? `${model.label} pinned.` : `${model.label} unpinned.`)
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex max-w-[760px] flex-col gap-1 px-4 py-8 sm:px-8">
          <h2 class="text-16-medium text-text-strong">Models</h2>
          <p class="text-13-regular text-text-weak">
            Choose the models used for research and which ones appear in the composer.
          </p>
        </div>
      </div>

      <div class="flex max-w-[760px] flex-col gap-8 px-4 pb-12 sm:px-8">
        <Show when={error()}>
          <div
            class="rounded-[4px] px-3 py-2 text-12-regular"
            style={{
              color: "var(--color-error)",
              border: "1px solid var(--color-error-muted)",
            }}
          >
            {error()}
          </div>
        </Show>
        <section class="flex flex-col gap-3" aria-labelledby="managed-inference">
          <div class="flex flex-col gap-0.5">
            <h3 id="managed-inference" class="text-13-medium text-text-weak">
              Managed inference
            </h3>
            <p class="text-12-regular text-text-weak">
              Route model calls through OpenScience credits, your own keys, or automatic credential detection.
            </p>
          </div>
          <ManagedInference onError={setError} />
        </section>

        <section class="flex flex-col gap-3" aria-labelledby="model-access">
          <div class="flex flex-col gap-0.5">
            <h3 id="model-access" class="text-13-medium text-text-weak">
              ChatGPT / Codex
            </h3>
            <p class="text-12-regular text-text-weak">
              Use supported OpenAI models through your existing ChatGPT plan. OAuth tokens stay in owner-only local
              storage.
            </p>
          </div>
          <CodexConnection onError={setError} />
        </section>

        <section class="flex flex-col gap-3" aria-labelledby="provider-keys">
          <div class="flex flex-col gap-0.5">
            <h3 id="provider-keys" class="text-13-medium text-text-weak">
              Provider keys
            </h3>
            <p class="text-12-regular text-text-weak">
              Bring your own model-provider key. Keys stay in an owner-only local auth file, not the system keychain,
              and the provider bills you directly.
            </p>
          </div>
          <ProviderKeys onError={setError} />
        </section>

        <section class="flex flex-col gap-3" aria-labelledby="model-defaults">
          <div class="flex flex-col gap-0.5">
            <h3 id="model-defaults" class="text-13-medium text-text-weak">
              Defaults
            </h3>
            <p class="text-12-regular text-text-weak">
              Effort and speed stay attached to the selected model in the composer.
            </p>
          </div>
          <div class="overflow-hidden rounded-[4px] border border-border-weak-base bg-surface-base/40">
            <Row title="Research model" detail="Used when a new session starts.">
              <Select
                options={options()}
                current={primary()}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => option && void sync.updateConfig({ model: option.value })}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                placeholder="Auto"
              />
            </Row>
            <Row title="Background model" detail="Used for titles and compact background work.">
              <Select
                options={options()}
                current={background()}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => option && void sync.updateConfig({ small_model: option.value })}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                placeholder="Auto"
              />
            </Row>
          </div>
        </section>

        <section class="flex flex-col gap-3" aria-labelledby="model-visibility">
          <div class="flex flex-col gap-0.5">
            <h3 id="model-visibility" class="text-13-medium text-text-weak">
              Composer models
            </h3>
            <p class="text-12-regular text-text-weak">
              Pin up to three models for quick access. Hidden models remain available here.
            </p>
          </div>
          <div class="flex items-center justify-between gap-3">
            <p class="text-11-regular text-text-weak" aria-live="polite">
              {notice()}
            </p>
            <span class="shrink-0 rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-weak">
              {models.pinned.list().length}/3 pinned
            </span>
          </div>
          <input
            type="search"
            aria-label="Filter models"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter models"
            class="h-8 rounded-[4px] border border-border-weak-base bg-surface-base px-3 text-13-regular text-text-strong outline-none placeholder:text-text-weak focus:border-border-strong-base"
          />
          <div class="overflow-hidden rounded-[6px] border border-border-weak-base bg-surface-base/40">
            <For each={groups()}>
              {(group) => (
                <section aria-labelledby={`composer-models-${group.id}`}>
                  <div class="flex min-h-8 items-center border-b border-border-weak-base bg-surface-raised-base/70 px-4">
                    <h4
                      id={`composer-models-${group.id}`}
                      class="text-11-medium uppercase tracking-[0.045em] text-text-weaker"
                    >
                      {group.label}
                    </h4>
                  </div>
                  <For each={group.models}>
                    {(model) => (
                      <div class="flex min-h-12 items-center justify-between gap-3 border-b border-border-weak-base px-4 py-2.5 last:border-none">
                        <div class="flex min-w-0 flex-1 items-center gap-2">
                          <span class="truncate text-13-medium text-text-strong">{model.label}</span>
                          <span class="shrink-0 rounded-[4px] border border-border-weak-base px-1.5 py-0.5 text-11-medium text-text-weak">
                            {model.provider}
                          </span>
                          <Show when={model.latest}>
                            <span class="shrink-0 rounded-[4px] bg-surface-raised-base px-1.5 py-0.5 text-11-medium text-text-weak">
                              latest
                            </span>
                          </Show>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            class="flex size-7 items-center justify-center rounded-[5px] text-text-weak hover:bg-surface-raised-base hover:text-text-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong"
                            data-pinned={model.pinned ? "true" : undefined}
                            aria-pressed={model.pinned}
                            aria-label={`${model.pinned ? "Unpin" : "Pin"} ${model.label}`}
                            title={model.pinned ? "Remove from quick models" : "Pin to quick models"}
                            onClick={() => togglePin(model)}
                          >
                            <Icon name={model.pinned ? "pin-filled" : "pin"} size="small" />
                          </button>
                          <Switch
                            hideLabel
                            checked={models.visible(model.key)}
                            onChange={(checked) => models.setVisibility(model.key, checked)}
                          >
                            {`${models.visible(model.key) ? "Hide" : "Show"} ${model.label}`}
                          </Switch>
                        </div>
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
            <Show when={filtered().length === 0}>
              <p class="px-4 py-6 text-center text-12-regular text-text-weak">No models match this filter.</p>
            </Show>
          </div>
        </section>
      </div>
    </div>
  )
}

function Row(props: { title: string; detail: string; children: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-border-weak-base px-4 py-3 last:border-none">
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-13-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.detail}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}
