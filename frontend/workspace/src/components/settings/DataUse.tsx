import { Show, createSignal, onMount } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { Switch } from "@synsci/ui/switch"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { Card, Row, RowCopy, Section } from "./_shared"
import { settingsApi } from "./api"
import { type ResearchToolsStatus, userOwnedSharingDetail, userOwnedSharingEnabled } from "./research-tools-state"

export function DataUse() {
  const platform = usePlatform()
  const server = useServer()
  const [state, setState] = createSignal<ResearchToolsStatus>()
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)
  const fetcher = () => platform.fetch ?? fetch
  const load = async () => {
    setError(undefined)
    setState(await settingsApi<ResearchToolsStatus>(server.url, fetcher(), "/settings/research-tools"))
  }

  const update = async (userOwnedContentEnabled: boolean) => {
    if (saving()) return
    setSaving(true)
    setError(undefined)
    const result = await settingsApi<ResearchToolsStatus>(server.url, fetcher(), "/settings/research-tools/telemetry", {
      method: "PUT",
      body: JSON.stringify({ userOwnedContentEnabled }),
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    if (result) setState(result)
    setSaving(false)
  }

  onMount(() => void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))))

  return (
    <Section
      title="Data & privacy"
      description="Ace records its managed service activity. You control sharing from routes that use your own credentials."
    >
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
          <span class="settings-preference-icon" data-tone="success" aria-hidden="true">
            <Icon name="activity" size="small" />
          </span>
          <RowCopy
            title="OpenScience Ace traces"
            description="Managed prompts, provider-visible reasoning, tool results, outputs, tokens, and spend are recorded as part of the Ace service."
          />
          <span class="settings-preference-status" data-tone="success">
            Always on
          </span>
        </Row>
        <Row>
          <span class="settings-preference-icon" aria-hidden="true">
            <Icon name="shield" size="small" />
          </span>
          <RowCopy
            title="Share user-owned routes"
            description={state() ? userOwnedSharingDetail(state()!) : "Loading your preference…"}
          />
          <Switch
            hideLabel
            checked={state() ? userOwnedSharingEnabled(state()!) : false}
            disabled={!state() || saving()}
            onChange={(value) => void update(value)}
          >
            Share user-owned routes
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
