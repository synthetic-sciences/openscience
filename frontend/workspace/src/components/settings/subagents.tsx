import type { Config } from "@synsci/sdk/v2/client"
import { For, Show, createEffect, on, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { Card, Row, RowCopy, Section } from "./_shared"

type Settings = {
  model?: string
  usd?: number
  tokens?: number
  deadlineMs?: number
  usdIncrease?: number
  tokenIncrease?: number
}

type Fields = {
  model: string
  usd: string
  tokens: string
  minutes: string
  usdIncrease: string
  tokenIncrease: string
}

type Services = Pick<ReturnType<typeof useGlobalSDK>, "client">

export function Subagents(props: { services?: Services } = {}) {
  const sdk = props.services ?? useGlobalSDK()
  const [state, setState] = createStore<{
    fields: Fields
    models: { id: string; label: string }[]
    loaded: boolean
    loading: boolean
    saving: boolean
    saved: boolean
    error?: string
    modelError?: string
  }>({
    fields: { model: "", usd: "", tokens: "", minutes: "10", usdIncrease: "", tokenIncrease: "" },
    models: [],
    loaded: false,
    loading: false,
    saving: false,
    saved: false,
  })

  const apply = (config: Config & { subagents?: Settings }) => {
    const value = config.subagents
    setState("fields", {
      model: value?.model ?? "",
      usd: value?.usd?.toString() ?? "",
      tokens: value?.tokens?.toString() ?? "",
      minutes: ((value?.deadlineMs ?? 600000) / 60000).toString(),
      usdIncrease: value?.usdIncrease?.toString() ?? "",
      tokenIncrease: value?.tokenIncrease?.toString() ?? "",
    })
  }

  const load = () => {
    if (state.loading) return
    setState({ loading: true, error: undefined })
    void sdk.client.global.config
      .get()
      .then((response) => {
        if (!response.data) throw new Error("Missing configuration")
        apply(response.data)
        setState("loaded", true)
      })
      .catch(() => setState("error", "Subagent defaults could not be loaded. Please retry."))
      .finally(() => setState("loading", false))
  }

  onMount(() => {
    load()
    void sdk.client.provider
      .list()
      .then((response) => {
        if (!response.data) throw new Error("Missing models")
        const connected = response.data.connected
        setState(
          "models",
          response.data.all
            .filter((provider) => connected.includes(provider.id))
            .flatMap((provider) =>
              Object.values(provider.models)
                .filter((model) => model.status !== "deprecated")
                .map((model) => ({ id: `${provider.id}/${model.id}`, label: `${model.name} · ${provider.name}` })),
            )
            .toSorted((a, b) => a.label.localeCompare(b.label)),
        )
      })
      .catch(() => setState("modelError", "Available models could not be loaded. Your saved model is retained."))
  })

  const edit = (key: keyof Fields, value: string) => {
    setState("fields", key, value)
    setState({ saved: false, error: undefined })
  }

  const save = () => {
    if (!state.loaded || state.saving) return
    const fields = state.fields
    const entries = [
      { value: fields.usd, label: "Paid allowance", integer: false },
      { value: fields.tokens, label: "Subscription allowance", integer: true },
      { value: fields.usdIncrease, label: "USD increase amount", integer: false },
      { value: fields.tokenIncrease, label: "Token increase amount", integer: true },
    ]
    const invalid = entries.find(
      (entry) =>
        entry.value.trim() !== "" &&
        (!Number.isFinite(Number(entry.value)) ||
          Number(entry.value) <= 0 ||
          (entry.integer && !Number.isSafeInteger(Number(entry.value)))),
    )
    if (invalid) {
      setState({
        saved: false,
        error: `${invalid.label} must be a positive ${invalid.integer ? "whole number within the supported range" : "number"}, or left blank.`,
      })
      return
    }
    const deadlineMs = Number(fields.minutes) * 60000
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
      setState({ saved: false, error: "Assignment deadline must be a positive number of minutes." })
      return
    }
    const settings: Settings = {
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields.usd.trim() ? { usd: Number(fields.usd) } : {}),
      ...(fields.tokens.trim() ? { tokens: Number(fields.tokens) } : {}),
      deadlineMs,
      ...(fields.usdIncrease.trim() ? { usdIncrease: Number(fields.usdIncrease) } : {}),
      ...(fields.tokenIncrease.trim() ? { tokenIncrease: Number(fields.tokenIncrease) } : {}),
    }
    const config: Config & { subagents: Settings } = { subagents: settings }
    setState({ saving: true, saved: false, error: undefined })
    void sdk.client.global.config
      .update({ config })
      .then((response) => {
        if (!response.data) throw new Error("Missing saved configuration")
        apply(response.data)
        setState("saved", true)
      })
      .catch(() => setState("error", "Subagent defaults could not be saved. Your edits are kept; please retry."))
      .finally(() => setState("saving", false))
  }

  const field = (key: Exclude<keyof Fields, "model">, label: string, description: string, integer = false) => (
    <Row>
      <RowCopy title={label} description={description} />
      <input
        aria-label={label}
        class="settings-field w-32 max-w-full"
        type="text"
        inputmode={integer ? "numeric" : "decimal"}
        value={state.fields[key]}
        disabled={!state.loaded || state.saving}
        placeholder={key === "minutes" ? undefined : "Not configured"}
        onInput={(event) => edit(key, event.currentTarget.value)}
      />
    </Row>
  )

  return (
    <Section
      title="Subagents"
      description="Global defaults for delegated work across your projects. The main agent has no spending limit here."
    >
      <Card>
        <Row>
          <RowCopy
            title="Subagent model"
            description="Applies to new assignments. Active assignments keep their model and access route."
          />
          <select
            aria-label="Subagent model"
            class="settings-field max-w-full"
            ref={(element) =>
              // Replacing the saved fallback option with a late catalog option resets native selection.
              createEffect(
                on(
                  () => [state.fields.model, state.models] as const,
                  ([model]) => {
                    element.value = model
                  },
                ),
              )
            }
            disabled={!state.loaded || state.saving}
            onChange={(event) => edit("model", event.currentTarget.value)}
          >
            <option value="">Same as calling agent</option>
            <Show when={state.fields.model && !state.models.some((model) => model.id === state.fields.model)}>
              <option value={state.fields.model}>{state.fields.model} (saved model)</option>
            </Show>
            <For each={state.models}>{(model) => <option value={model.id}>{model.label}</option>}</For>
          </select>
        </Row>
        {field(
          "usd",
          "Paid allowance (USD)",
          "One shared pool per conversation for paid BYOK and Ace subagent calls. Blank leaves paid delegation unconfigured.",
        )}
        {field(
          "tokens",
          "Subscription allowance (tokens)",
          "One shared pool of model tokens per conversation, not your account quota or a dollar charge. Blank leaves subscription delegation unconfigured.",
          true,
        )}
        {field(
          "minutes",
          "Assignment deadline (minutes)",
          "Time allowed for each assignment, including queue and permission waits.",
        )}
        {field(
          "usdIncrease",
          "USD increase amount",
          "Amount offered when you explicitly approve an increase to a conversation’s paid pool.",
        )}
        {field(
          "tokenIncrease",
          "Token increase amount",
          "Tokens offered when you explicitly approve an increase to a conversation’s subscription pool.",
          true,
        )}
      </Card>
      <p class="text-12-regular text-text-weak mt-3">
        Allowances cover model inference only. Search, compute and other paid tools keep their own controls. Defaults
        initialize new conversation pools; saving does not reset, refill or increase existing pools.
      </p>
      <Show when={state.modelError}>
        <p class="text-12-regular text-text-weak mt-2">{state.modelError}</p>
      </Show>
      <Show when={state.error}>
        <p role="alert" class="settings-alert text-12-regular mt-3" data-tone="critical">
          {state.error}
        </p>
      </Show>
      <div class="flex flex-wrap items-center gap-3 mt-3">
        <Show
          when={state.loaded}
          fallback={
            <button type="button" class="settings-button" disabled={state.loading} onClick={load}>
              {state.loading ? "Loading subagent defaults…" : "Retry loading subagent defaults"}
            </button>
          }
        >
          <button type="button" class="settings-button" disabled={state.saving} onClick={save}>
            {state.saving ? "Saving…" : "Save subagent defaults"}
          </button>
        </Show>
        <Show when={state.saved}>
          <p role="status" class="text-12-regular text-text-weak">
            Saved for new conversation pools and assignments.
          </p>
        </Show>
      </div>
    </Section>
  )
}
