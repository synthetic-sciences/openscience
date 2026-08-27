import { Show, createMemo, createSignal, onMount } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { Switch } from "@synsci/ui/switch"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { Card, Row, RowCopy, Section } from "./_shared"
import { settingsApi } from "./api"
import { dataSharingDetail, dataSharingEnabled, type ResearchToolsStatus } from "./research-tools-state"

export function DataUse() {
  const platform = usePlatform()
  const server = useServer()
  const [state, setState] = createSignal<ResearchToolsStatus>()
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)
  const fetcher = () => platform.fetch ?? fetch
  const enabled = createMemo(() => (state() ? dataSharingEnabled(state()!) : false))

  const load = async () => {
    setError(undefined)
    setState(await settingsApi<ResearchToolsStatus>(server.url, fetcher(), "/settings/research-tools"))
  }

  const update = async (body: { analyticsEnabled?: boolean; userOwnedContentEnabled?: boolean }) => {
    if (saving()) return
    setSaving(true)
    setError(undefined)
    const result = await settingsApi<ResearchToolsStatus>(server.url, fetcher(), "/settings/research-tools/telemetry", {
      method: "PUT",
      body: JSON.stringify(body),
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    if (result) setState(result)
    setSaving(false)
  }

  onMount(() => void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))))

  return (
    <Section title="Data & privacy" description="Control exactly which OpenScience traces leave this device.">
      <Show when={error()}>
        <div class="settings-alert" data-tone="critical" role="alert">
          <span>{error()}</span>
          <button type="button" class="settings-preference-action" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </Show>
      <Card>
        <Row>
          <span class="settings-preference-icon" data-tone={enabled() ? "success" : undefined} aria-hidden="true">
            <Icon name="activity" size="small" />
          </span>
          <RowCopy
            title="Improve OpenScience with my activity"
            description={state() ? dataSharingDetail(state()!) : "Loading your preference…"}
          />
          <Switch
            hideLabel
            checked={enabled()}
            disabled={!state() || saving()}
            onChange={(value) => void update({ analyticsEnabled: value })}
          >
            Improve OpenScience with my activity
          </Switch>
        </Row>
        <Row>
          <span class="settings-preference-icon" aria-hidden="true">
            <Icon name="shield" size="small" />
          </span>
          <RowCopy
            title="Include user-owned routes"
            description="Include prompts, traces, tool results, and final answers from API keys, ChatGPT/Codex or provider subscriptions, and local models. Ace is covered by the main switch."
          />
          <Switch
            hideLabel
            checked={state()?.telemetry.userOwnedContentEnabled ?? false}
            disabled={!state() || saving() || !enabled()}
            onChange={(value) => void update({ userOwnedContentEnabled: value })}
          >
            Include user-owned routes
          </Switch>
        </Row>
        <Row>
          <span
            class="settings-preference-icon"
            data-tone={state()?.telemetry.quarantinedEvents ? "warning" : "success"}
            aria-hidden="true"
          >
            <Icon name="cloud" size="small" />
          </span>
          <RowCopy
            title="Delivery"
            description={`${state()?.telemetry.queuedEvents ?? 0} queued · ${state()?.telemetry.quarantinedEvents ?? 0} need attention`}
          />
          <span
            class="settings-preference-status"
            data-tone={state()?.telemetry.quarantinedEvents ? "warning" : "success"}
          >
            {state()?.telemetry.quarantinedEvents ? "Needs attention" : "Healthy"}
          </span>
        </Row>
      </Card>
    </Section>
  )
}
