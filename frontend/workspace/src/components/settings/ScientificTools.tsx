import { Button } from "@synsci/ui/button"
import { IconButton } from "@synsci/ui/icon-button"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { EmptyState, PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import { useSettingsNav } from "./nav"
import {
  actionableScientificCapabilities,
  capabilityState,
  scientificCapabilityTarget,
  type ScientificCapabilityRecord,
  type ScientificToolsResponse,
} from "./scientific-tools-state"
import { loadScientificTools, setupScientificTool } from "./scientific-tools-loader"
import { ScientificToolLogo } from "./ScientificToolLogo"
import "./scientific-tools.css"

export default function ScientificTools() {
  const server = useServer()
  const platform = usePlatform()
  const navigate = useSettingsNav()
  const [state, setState] = createSignal<ScientificToolsResponse>()
  const [problem, setProblem] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [installing, setInstalling] = createSignal<string>()
  const fetchFn = () => platform.fetch ?? fetch

  async function load(refresh = false) {
    setLoading(true)
    if (!refresh) setProblem("")
    try {
      setState(await loadScientificTools(server.url, fetchFn(), refresh))
      setProblem("")
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  async function install(record: ScientificCapabilityRecord) {
    setInstalling(record.id)
    setProblem("")
    setNotice("")
    try {
      await setupScientificTool(server.url, fetchFn(), record.id)
      await load(true)
      setNotice(`${record.name} is ready. The packaged environment is shared by all five local tools.`)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setInstalling(undefined)
    }
  }

  onMount(() => void load())

  const records = createMemo(() => actionableScientificCapabilities(state()?.capabilities ?? []))
  const local = createMemo(() => records().filter((record) => scientificCapabilityTarget(record) === "local"))
  const hosted = createMemo(() =>
    records().filter((record) => {
      const target = scientificCapabilityTarget(record)
      return target === "nvidia" || target === "modal"
    }),
  )

  return (
    <PanelScroll>
      <div class="scientific-tools-panel">
        <PanelHeader title="Tools" description="Scientific tools you can run here or connect with your own account." />
        <PanelBody>
          <Show when={problem()}>
            <div class="settings-alert" data-tone="critical" role="alert">
              <span>{problem()}</span>
              <Show when={!state()}>
                <Button size="small" variant="secondary" disabled={loading()} onClick={() => void load(true)}>
                  Retry
                </Button>
              </Show>
            </div>
          </Show>

          <Show when={notice()}>
            <div class="scientific-tools-notice" role="status" aria-live="polite">
              {notice()}
            </div>
          </Show>

          <Show when={loading() && !state()}>
            <div class="scientific-tools-loading" role="status" aria-live="polite">
              Loading tools…
            </div>
          </Show>

          <Show when={state()}>
            <Show
              when={records().length > 0}
              fallback={
                <EmptyState
                  icon="flask"
                  title="No runnable tools for this device"
                  hint="OpenScience only lists tools with a real packaged runtime or a supported connection path."
                />
              }
            >
              <Show when={local().length > 0}>
                <Section
                  id="scientific-tools-local"
                  title="Local science"
                  count={local().length}
                  description="One exact Python environment powers these tools on this device. Install it once."
                >
                  <div class="settings-card scientific-tools-list" role="list">
                    <For each={local()}>
                      {(record) => (
                        <CapabilityRow
                          record={record}
                          busy={Boolean(installing())}
                          active={installing() === record.id}
                          onAction={() => void install(record)}
                          onOpenSource={() => platform.openLink(record.source.reference)}
                        />
                      )}
                    </For>
                  </div>
                </Section>
              </Show>

              <Show when={hosted().length > 0}>
                <Section
                  id="scientific-tools-connected"
                  title="Connected science"
                  count={hosted().length}
                  description="Run supported scientific adapters with credentials stored on this device."
                >
                  <div class="settings-card scientific-tools-list" role="list">
                    <For each={hosted()}>
                      {(record) => {
                        const target = () => scientificCapabilityTarget(record)
                        return (
                          <CapabilityRow
                            record={record}
                            busy={false}
                            active={false}
                            onAction={() => navigate(target() === "modal" ? "compute" : "credentials")}
                            onOpenSource={() => platform.openLink(record.source.reference)}
                          />
                        )
                      }}
                    </For>
                  </div>
                </Section>
              </Show>
            </Show>

            <p class="scientific-tools-footnote">
              Only executable adapters are listed. Runs use this device or a service you connect directly.
            </p>
          </Show>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

function CapabilityRow(props: {
  record: ScientificCapabilityRecord
  busy: boolean
  active: boolean
  onAction: () => void
  onOpenSource: () => void
}) {
  const status = () => capabilityState(props.record)
  const target = () => scientificCapabilityTarget(props.record)
  const actionLabel = () => {
    if (props.active) return "Installing…"
    if (status().action === "setup") return status().tone === "warning" ? "Repair" : "Install"
    if (status().action === "credentials") return status().tone === "warning" ? "Review" : "Connect"
    if (status().action === "compute") return "Configure"
    return undefined
  }
  return (
    <article class="settings-row scientific-tool-row" data-target={target()} role="listitem">
      <ScientificToolLogo id={props.record.id} name={props.record.name} hosted={target() === "nvidia"} />
      <span class="scientific-tool-row__copy">
        <span class="scientific-tool-row__title">
          <strong>{props.record.name}</strong>
          <small>{categoryLabel(props.record.category)}</small>
        </span>
        <span>{props.record.summary}</span>
      </span>
      <span class="scientific-tool-row__actions">
        <span class="scientific-tool-status" data-tone={status().tone}>
          <Show when={status().tone === "success"}>
            <span class="scientific-tool-status__dot" aria-hidden="true" />
          </Show>
          {status().label}
        </span>
        <Show when={actionLabel()}>
          {(label) => (
            <Button
              class="scientific-tool-action"
              size="small"
              variant="secondary"
              disabled={props.busy}
              onClick={props.onAction}
            >
              {label()}
            </Button>
          )}
        </Show>
        <IconButton
          class="scientific-tool-source"
          icon="link"
          variant="ghost"
          aria-label={`Open ${props.record.name} source`}
          title={`Open ${props.record.name} source`}
          onClick={props.onOpenSource}
        />
      </span>
    </article>
  )
}

function categoryLabel(value: string) {
  const label = value.replaceAll("_", " ")
  return label.charAt(0).toUpperCase() + label.slice(1)
}
