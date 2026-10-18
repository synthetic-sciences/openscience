import { Show, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { Card, Row, RowCopy, Section } from "./_shared"
import type { SettingsUsageLoggingGetResponses, SettingsUsageLoggingHealthResponses } from "@synsci/sdk/v2/client"
import { ServerLoggingHealth } from "./ServerLoggingHealth"
import { settingsApi } from "./api"

type Status = SettingsUsageLoggingGetResponses[200]

type Services = {
  sdk: Pick<ReturnType<typeof useGlobalSDK>, "url">
  platform: Pick<ReturnType<typeof usePlatform>, "fetch">
}

export function UsageLogging(props: { services?: Services } = {}) {
  const sdk = props.services?.sdk ?? useGlobalSDK()
  const platform = props.services?.platform ?? usePlatform()
  const [state, setState] = createStore<{ status?: Status; busy: boolean; error?: string; revision: number }>({
    busy: false,
    revision: 0,
  })
  const load = (enabled?: boolean) => {
    if (state.busy) return
    const revision = state.revision
    setState({ busy: true, error: undefined })
    void settingsApi<Status>(
      sdk.url,
      platform.fetch ?? fetch,
      "/settings/usage-logging",
      enabled === undefined ? undefined : { method: "PUT", body: JSON.stringify({ enabled }) },
    )
      .then((status) => {
        if (revision === state.revision) setState("status", reconcile(status))
      })
      .catch(() => {
        if (revision === state.revision) setState({ error: "Could not read or save trace sharing. Please retry." })
      })
      .finally(() => {
        if (revision === state.revision) setState({ busy: false })
      })
  }
  const accountChanged = () => {
    setState({ revision: state.revision + 1, status: undefined, busy: false, error: undefined })
    load()
  }
  onMount(() => {
    load()
    window.addEventListener("openscience:account-changed", accountChanged)
  })
  onCleanup(() => window.removeEventListener("openscience:account-changed", accountChanged))

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
            title="Logging health"
            description={
              !state.status
                ? "Loading…"
                : !state.status.enabled
                  ? "Sharing is off. Queued records have been cleared."
                  : !state.status.signedIn
                    ? "Sign in to share traces. No records are sent while signed out."
                    : `${state.status.queued} queued · ${state.status.delivered} acknowledged · ${state.status.quarantined} need attention`
            }
          />
          <button type="button" class="settings-preference-action" disabled={state.busy} onClick={() => load()}>
            Refresh
          </button>
        </Row>
        <Show when={state.status}>
          {(status) => (
            <>
              <Row>
                <RowCopy
                  title="Last acknowledgement"
                  description={status().lastDelivery ?? "No delivery has been acknowledged on this device yet."}
                />
              </Row>
              <Show when={status().oldestQueuedAt}>
                <Row>
                  <RowCopy
                    title="Oldest queued record"
                    description={`${status().oldestQueuedAt}${status().stalled ? " · waiting more than five minutes for acknowledgement" : ""}`}
                  />
                </Row>
              </Show>
              <Show when={status().lastAttempt}>
                {(attempt) => (
                  <Row>
                    <RowCopy
                      title="Last delivery attempt"
                      description={`${attempt().startedAt} · ${attempt().state}${attempt().httpStatus === undefined ? "" : ` · HTTP ${attempt().httpStatus}`} · ${attempt().deliveryID}`}
                    />
                  </Row>
                )}
              </Show>
              <Show when={status().rejection}>
                {(rejection) => (
                  <Row>
                    <RowCopy
                      title="Latest rejected record"
                      description={`${rejection().eventID} · ${rejection().reason === "local_size_limit" ? "Record exceeds the delivery size limit" : /^http_[1-5][0-9]{2}$/.test(rejection().reason) ? `HTTP ${rejection().reason.slice(5)}` : "Reason unavailable"}`}
                    />
                  </Row>
                )}
              </Show>
              <Show when={status().quarantined > 0}>
                <Row>
                  <RowCopy
                    title="Rejected records"
                    description={`${status().quarantined} rejected records are kept on this device and are not retried automatically. Turning off sharing discards queued and rejected records.`}
                  />
                </Row>
              </Show>
              <Row>
                <RowCopy
                  title="What this checks"
                  description="These counts describe trace delivery from this device. Acknowledgement does not verify complete model usage or agreement with Ace charges. Check server reads stored evidence separately; it cannot see records still queued or rejected on this device, or requests rejected before a receipt. Refresh reads device status; it does not retry uploads."
                />
              </Row>
            </>
          )}
        </Show>
      </Card>
      <ServerLoggingHealth
        signedIn={state.status?.signedIn ?? false}
        queued={state.status?.queued ?? 0}
        quarantined={state.status?.quarantined ?? 0}
        check={() =>
          settingsApi<SettingsUsageLoggingHealthResponses[200]>(
            sdk.url,
            platform.fetch ?? fetch,
            "/settings/usage-logging/health",
          )
        }
      />
      <Show when={state.status?.error}>
        <p role="alert">{state.status?.error}</p>
      </Show>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
    </Section>
  )
}
