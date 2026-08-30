import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { EmptyState, FilterMenu, PanelBody, PanelHeader, PanelScroll, SearchInput, Section } from "./_shared"
import {
  capabilityState,
  filterScientificCapabilities,
  type ScientificCapabilityRecord,
  type ScientificToolFilter,
  type ScientificToolsResponse,
} from "./scientific-tools-state"
import { loadScientificTools } from "./scientific-tools-loader"
import { ProviderLogo } from "./ProviderLogo"
import "./scientific-tools.css"

const PAGE_SIZE = 24

export default function ScientificTools() {
  const server = useServer()
  const platform = usePlatform()
  const [state, setState] = createSignal<ScientificToolsResponse>()
  const [problem, setProblem] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<ScientificToolFilter>("all")
  const [expanded, setExpanded] = createSignal<string>()
  const fetchFn = () => platform.fetch ?? fetch

  async function load(refresh = false) {
    if (loading() && state()) return
    setLoading(true)
    setProblem("")
    try {
      setState(await loadScientificTools(server.url, fetchFn(), refresh))
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
  const [limit, setLimit] = createSignal(PAGE_SIZE)
  const shown = createMemo(() => visible().slice(0, limit()))
  createEffect(() => {
    query()
    filter()
    setLimit(PAGE_SIZE)
  })
  const filterOptions = createMemo(() => [
    { id: "all", label: "All", count: records().length },
    { id: "packaged", label: "Available", count: records().filter((item) => item.runtime).length },
    {
      id: "setup",
      label: "Setup needed",
      count: records().filter((item) => item.current_availability.local === "setup_needed").length,
    },
    {
      id: "blocked",
      label: "Unavailable",
      count: records().filter(
        (item) => item.maturity === "blocked" || item.current_availability.local === "unavailable",
      ).length,
    },
  ])

  return (
    <PanelScroll>
      <div class="scientific-tools-panel">
        <PanelHeader title="Tools" description="Scientific runtimes available through this OpenScience installation." />
        <PanelBody>
          <Show when={problem()}>
            <div class="settings-alert" data-tone="critical" role="alert">
              <span>
                {state() ? "Refresh failed; showing the last loaded catalog." : "Scientific tools are unavailable."}{" "}
                {problem()}
              </span>
              <Button size="small" variant="secondary" disabled={loading()} onClick={() => void load(true)}>
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
            <Section
              id="scientific-tools-inventory"
              title="Tool catalog"
              count={visible().length}
              description="Search the local catalog, then open a row only when you need setup or source details."
            >
              <div class="scientific-tools-toolbar">
                <SearchInput value={query()} onInput={setQuery} placeholder="Search tools" ariaLabel="Search tools" />
                <FilterMenu
                  options={filterOptions()}
                  value={filter()}
                  onSelect={(value) => setFilter(value as ScientificToolFilter)}
                  ariaLabel="Filter scientific tools"
                />
              </div>
              <Show when={!loading() || visible().length > 0}>
                <Show
                  when={visible().length > 0}
                  fallback={
                    <EmptyState icon="flask" title="No matching capabilities" hint="Change the search or filter." />
                  }
                >
                  <div class="settings-card scientific-tools-list" role="list">
                    <For each={shown()}>
                      {(record) => (
                        <CapabilityRow
                          record={record}
                          expanded={expanded() === record.id}
                          onToggle={() => setExpanded(expanded() === record.id ? undefined : record.id)}
                          onOpenSource={() => platform.openLink(record.source.reference)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
              <Show when={limit() < visible().length}>
                <div class="scientific-tools-more">
                  <span>
                    Showing {shown().length} of {visible().length}
                  </span>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => setLimit((current) => Math.min(visible().length, current + PAGE_SIZE))}
                  >
                    Show more
                  </Button>
                </div>
              </Show>
            </Section>

            <p class="scientific-tools-footnote">
              Setup and execution use this device and any provider credentials you configure.
            </p>
          </Show>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

function CapabilityRow(props: {
  record: ScientificCapabilityRecord
  expanded: boolean
  onToggle: () => void
  onOpenSource: () => void
}) {
  const status = () => capabilityState(props.record)
  const logo = () => (props.record.source.kind === "github" ? "github" : props.record.id)
  return (
    <article class="scientific-tool-row" data-expanded={props.expanded ? "true" : undefined} role="listitem">
      <button type="button" class="scientific-tool-row__toggle" aria-expanded={props.expanded} onClick={props.onToggle}>
        <ProviderLogo id={logo()} label={props.record.name} size="small" />
        <span class="scientific-tool-row__copy">
          <span class="scientific-tool-row__title">
            <strong>{props.record.name}</strong>
            <small>{categoryLabel(props.record.category)}</small>
          </span>
          <span>{props.record.summary}</span>
        </span>
        <span class="scientific-tool-status" data-tone={status().tone}>
          {status().label}
        </span>
        <span class="scientific-tool-row__disclosure" aria-hidden="true">
          <Icon name={props.expanded ? "chevron-down" : "chevron-right"} size="small" />
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
          </dl>
          <Show when={props.record.blocker}>
            <p class="scientific-tool-row__blocker">{props.record.blocker}</p>
          </Show>
          <Show when={props.record.setup?.requirements.length}>
            <ul>
              <For each={props.record.setup?.requirements ?? []}>{(requirement) => <li>{requirement}</li>}</For>
            </ul>
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

function categoryLabel(value: string) {
  const label = value.replaceAll("_", " ")
  return label.charAt(0).toUpperCase() + label.slice(1)
}
