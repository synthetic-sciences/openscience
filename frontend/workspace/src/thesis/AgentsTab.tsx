import { createMemo, For, Show, type JSX } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { activeSubagents } from "@/thesis/store/subagents"
import { StatusDot } from "@/thesis/shared/StatusDot"
import { AgentIcon } from "@/thesis/shared/AgentIcon"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"

export function AgentsTab(): JSX.Element {
  const sync = useSync()
  const params = useParams()
  const navigate = useNavigate()

  const rows = createMemo(() => {
    const id = params.id
    if (!id || id === "new") return []
    return activeSubagents(sync.data.session as any, sync.data.session_status ?? {}, id)
  })

  return (
    <div style={{ flex: 1, "min-height": 0, overflow: "auto", padding: "8px 10px" }} class="thesis-scroll">
      <Show
        when={rows().length > 0}
        fallback={
          <div style={{ padding: "24px 12px", "font-family": FONT_SANS, "font-size": "12px", color: "var(--color-text-faint)", "text-align": "center" }}>
            No subagents running in this session.
          </div>
        }
      >
        <For each={rows()}>
          {(row) => (
            <button
              type="button"
              onClick={() => navigate(`/${params.dir}/session/${row.sessionId}`)}
              style={{
                all: "unset",
                cursor: "pointer",
                display: "flex",
                "align-items": "center",
                gap: "8px",
                width: "100%",
                "box-sizing": "border-box",
                padding: "8px 8px",
                "border-radius": "4px",
                "border-bottom": "1px solid var(--color-border)",
                "font-family": FONT_MONO,
                "font-size": "11px",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-accent-subtle)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <StatusDot status={row.status} pulse={row.status === "active"} />
              <AgentIcon size={14} animated={row.status === "active"} />
              <span style={{ flex: 1, "min-width": 0, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "var(--color-text)" }}>
                {row.title}
              </span>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}
