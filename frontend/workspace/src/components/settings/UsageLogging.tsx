import { Show, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { Card, Row, RowCopy, Section } from "./_shared"
import { settingsApi } from "./api"

type Status = {
  enabled: boolean
  signedIn: boolean
  queued: number
  quarantined: number
  delivered: number
  lastDelivery?: string
  error?: string
}

type Services = {
  sdk: Pick<ReturnType<typeof useGlobalSDK>, "url">
  platform: Pick<ReturnType<typeof usePlatform>, "fetch">
}

export function UsageLogging(props: { services?: Services } = {}) {
  const sdk = props.services?.sdk ?? useGlobalSDK()
  const platform = props.services?.platform ?? usePlatform()
  const [state, setState] = createStore<{ status?: Status; busy: boolean; error?: string }>({ busy: false })
  const load = (enabled?: boolean) => {
    if (state.busy) return
    setState({ busy: true, error: undefined })
    void settingsApi<Status>(
      sdk.url,
      platform.fetch ?? fetch,
      "/settings/usage-logging",
      enabled === undefined ? undefined : { method: "PUT", body: JSON.stringify({ enabled }) },
    )
      .then((status) => setState("status", reconcile(status)))
      .catch(() => setState({ error: "Could not read or save trace sharing. Please retry." }))
      .finally(() => setState({ busy: false }))
  }
  onMount(() => load())

  return (
    <Section title="Data & privacy" description="Control session trace sharing from this device.">
      <Card>
        <Row>
          <RowCopy
            title="Share session traces"
            description="On by default while signed in, subject to your account preferences. Shares prompts, provider-visible reasoning, answers, tool inputs and outputs, and reported usage. Turn off to stop uploads from this device."
          />
          <Switch
            hideLabel
            checked={state.status?.enabled ?? false}
            disabled={!state.status || state.busy}
            onChange={load}
          >
            Share session traces
          </Switch>
        </Row>
        <Row>
          <RowCopy
            title="Delivery"
            description={
              state.error ??
              state.status?.error ??
              (!state.status
                ? "Loading…"
                : !state.status.enabled
                  ? "Sharing is off. Queued records have been cleared."
                  : !state.status.signedIn
                    ? "Sign in to share traces. No records are sent while signed out."
                    : `${state.status.queued} queued · ${state.status.delivered} acknowledged · ${state.status.quarantined} need attention`)
            }
          />
          <button type="button" class="settings-preference-action" disabled={state.busy} onClick={() => load()}>
            Refresh
          </button>
        </Row>
      </Card>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
    </Section>
  )
}
