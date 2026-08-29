import { Button } from "@synsci/ui/button"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { EmptyState, FilterMenu, PanelBody, PanelHeader, PanelScroll, SearchInput, Toolbar } from "./_shared"
import { settingsApi } from "./api"
import {
  capabilityState,
  filterScientificCapabilities,
  type CapabilityEvidenceRecord,
  type ScientificCapabilityRecord,
  type ScientificToolFilter,
  type ScientificToolsResponse,
} from "./scientific-tools-state"
import "./scientific-tools.css"

export default function ScientificTools() {
  const sdk = useGlobalSDK()
  const server = useServer()
  const platform = usePlatform()
  const [state, setState] = createSignal<ScientificToolsResponse>()
  const [problem, setProblem] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<ScientificToolFilter>("all")
  const [expanded, setExpanded] = createSignal<string>()
  const fetchFn = () => platform.fetch ?? fetch

  async function load() {
    if (loading() && state()) return
    setLoading(true)
    setProblem("")
    try {
      setState(await settingsApi<ScientificToolsResponse>(server.url, fetchFn(), "/settings/scientific-tools"))
      setProblem("")
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  const records = createMemo(() => state()?.capabilities ?? [])
  const visible = createMemo(() => filterScientificCapabilities(records(), query(), filter()))
  const evidenceFor = (id: string) =>
    Object.values(state()?.evidence ?? {}).filter((entry) => entry.capability.id === id)
  const filterOptions = createMemo(() => [
    { id: "all", label: "All", count: records().length },
    { id: "packaged", label: "Packaged", count: records().filter((item) => item.runtime).length },
    { id: "hosted", label: "Hosted", count: records().filter((item) => item.hosted).length },
    {
      id: "setup",
      label: "Setup needed",
      count: records().filter(
        (item) =>
          item.current_availability.local === "setup_needed" || item.current_availability.hosted === "setup_needed",
      ).length,
    },
    { id: "blocked", label: "Blocked", count: records().filter((item) => item.maturity === "blocked").length },
  ])

  return (
    <PanelScroll>
      <div class="scientific-tools-panel">
        <PanelHeader
          title="Scientific tools"
          description="A truthful executable inventory: packaged runtimes, hosted previews, setup requirements, blockers, and release evidence."
          toolbar={
            <Toolbar>
              <SearchInput value={query()} onInput={setQuery} placeholder="Search 54 capabilities" />
              <FilterMenu
                options={filterOptions()}
                value={filter()}
                onSelect={(value) => setFilter(value as ScientificToolFilter)}
                ariaLabel="Filter scientific capabilities"
              />
            </Toolbar>
          }
        />
        <PanelBody>
          <Show when={problem()}>
            <div class="settings-alert" data-tone="critical" role="alert">
              <span>
                {state() ? "Refresh failed; showing the last loaded catalog." : "Scientific tools are unavailable."}{" "}
                {problem()}
              </span>
              <Button size="small" variant="secondary" disabled={loading()} onClick={() => void load()}>
                Retry
              </Button>
            </div>
          </Show>

          <Show when={loading() && !state()}>
            <div class="scientific-tools-loading" role="status" aria-live="polite">
              Loading capability evidence…
            </div>
          </Show>

          <Show when={state()}>
            {(value) => (
              <dl class="scientific-tools-metrics" aria-label="Scientific capability coverage">
                <Metric label="Inventoried" value={value().counts.total} />
                <Metric label="Packaged" value={value().counts.packaged} />
                <Metric label="Hosted adapters" value={value().counts.hosted} />
                <Metric label="Release-verified" value={value().counts.verified} />
              </dl>
            )}
          </Show>

          <Show when={state()}>
            <section
              class="scientific-tools-inventory"
              aria-busy={loading()}
              aria-label="Scientific capability inventory"
            >
              <div class="scientific-tools-inventory__heading">
                <div>
                  <h3>Capability inventory</h3>
                  <p>Instructional presence and upstream availability never count as an OpenScience executor.</p>
                </div>
                <span aria-live="polite">{visible().length}</span>
              </div>
              <Show when={!loading() || visible().length > 0}>
                <Show
                  when={visible().length > 0}
                  fallback={
                    <EmptyState icon="flask" title="No matching capabilities" hint="Change the search or filter." />
                  }
                >
                  <div class="scientific-tools-list" role="list">
                    <For each={visible()}>
                      {(record) => (
                        <CapabilityRow
                          record={record}
                          evidence={evidenceFor(record.id)}
                          expanded={expanded() === record.id}
                          onToggle={() => setExpanded(expanded() === record.id ? undefined : record.id)}
                          onOpenSource={() => platform.openLink(record.source.reference)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </section>

            <p class="scientific-tools-footnote">
              Use <code>scientific_capability</code> in Research to run doctor, setup, plan, bounded smoke, lifecycle,
              and verification actions. Setup and remote execution still require their normal approval.
            </p>
          </Show>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

function Metric(props: { label: string; value: number }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  )
}

function CapabilityRow(props: {
  record: ScientificCapabilityRecord
  evidence: CapabilityEvidenceRecord[]
  expanded: boolean
  onToggle: () => void
  onOpenSource: () => void
}) {
  const status = () => capabilityState(props.record, props.evidence)
  return (
    <article class="scientific-tool-row" data-expanded={props.expanded ? "true" : undefined} role="listitem">
      <button type="button" class="scientific-tool-row__toggle" aria-expanded={props.expanded} onClick={props.onToggle}>
        <span class="scientific-tool-row__copy">
          <span class="scientific-tool-row__title">
            <strong>{props.record.name}</strong>
            <small>{categoryLabel(props.record.category)}</small>
          </span>
          <span>{props.record.summary}</span>
        </span>
        <span class="scientific-tool-row__availability">
          <small>Local {availabilityLabel(props.record.current_availability.local)}</small>
          <small>Hosted {availabilityLabel(props.record.current_availability.hosted)}</small>
        </span>
        <span class="scientific-tool-status" data-tone={status().tone}>
          {status().label}
        </span>
        <span class="scientific-tool-row__disclosure" aria-hidden="true">
          {props.expanded ? "−" : "+"}
        </span>
      </button>
      <Show when={props.expanded}>
        <div class="scientific-tool-row__details">
          <p>{props.record.basis}</p>
          <dl>
            <div>
              <dt>Upstream</dt>
              <dd>
                {props.record.source.name} {props.record.source.version}
              </dd>
            </div>
            <Show when={props.record.source.license}>
              <div>
                <dt>License</dt>
                <dd>{props.record.source.license}</dd>
              </div>
            </Show>
            <Show when={props.record.runtime}>
              <div>
                <dt>Runtime</dt>
                <dd>
                  Python {props.record.runtime?.python} · exact {props.record.runtime?.packages.length}-package graph
                </dd>
              </div>
            </Show>
            <Show when={props.record.hosted}>
              <div>
                <dt>Hosted path</dt>
                <dd>BYOK NVIDIA NIM · no shared credential</dd>
              </div>
            </Show>
          </dl>
          <Show when={props.record.blocker}>
            <p class="scientific-tool-row__blocker">{props.record.blocker}</p>
          </Show>
          <Show when={props.record.setup?.requirements.length}>
            <ul>
              <For each={props.record.setup?.requirements ?? []}>{(requirement) => <li>{requirement}</li>}</For>
            </ul>
          </Show>
          <Show when={props.evidence.length > 0}>
            <div class="scientific-tool-evidence">
              <For each={props.evidence}>
                {(entry) => (
                  <span>
                    {entry.target} smoke · {new Date(entry.verified_at).toLocaleDateString()}
                  </span>
                )}
              </For>
            </div>
          </Show>
          <div class="scientific-tool-row__actions">
            <Button size="small" variant="secondary" onClick={props.onOpenSource}>
              Open upstream source
            </Button>
          </div>
        </div>
      </Show>
    </article>
  )
}

function availabilityLabel(value: ScientificCapabilityRecord["availability"]["local"]) {
  if (value === "configured") return "configured · not live-tested"
  if (value === "setup_needed") return "setup"
  if (value === "not_applicable") return "n/a"
  return value
}

function categoryLabel(value: string) {
  const label = value.replaceAll("_", " ")
  return label.charAt(0).toUpperCase() + label.slice(1)
}
