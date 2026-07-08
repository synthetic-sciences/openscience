import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { latestTodos } from "@/thesis/store/todos"
import { FONT_MONO } from "@/styles/tokens"

const glyph = (status: string) =>
  status === "completed" ? "✓" : status === "in_progress" ? "◐" : status === "cancelled" ? "×" : "○"

export function TodoTracker(): JSX.Element {
  const sync = useSync()
  const params = useParams()
  const [expanded, setExpanded] = createSignal(false)

  const summary = createMemo(() => {
    const id = params.id
    if (!id || id === "new") return null
    return latestTodos(sync.data.message[id] ?? [], sync.data.part)
  })

  return (
    <Show when={summary()}>
      {(s) => (
        <div
          style={{
            "border-top": "1px solid var(--color-border)",
            background: "var(--color-bg-subtle)",
            "flex-shrink": 0,
          }}
        >
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              "align-items": "center",
              gap: "8px",
              width: "100%",
              "box-sizing": "border-box",
              padding: "8px 16px",
              "font-family": FONT_MONO,
              "font-size": "11px",
              color: "var(--color-text-muted)",
            }}
          >
            <span aria-hidden="true">☑</span>
            <span style={{ color: "var(--color-text)", "flex-shrink": 0 }}>
              To-dos · {s().completed}/{s().total}
            </span>
            <span
              style={{
                flex: 1,
                "min-width": 0,
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              · {s().active?.content ?? ""}
            </span>
            <span aria-hidden="true">{expanded() ? "▾" : "▸"}</span>
          </button>
          <Show when={expanded()}>
            <div class="thesis-scroll" style={{ "max-height": "160px", "overflow-y": "auto", padding: "0 16px 8px" }}>
              <For each={s().items}>
                {(todo) => (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      padding: "3px 0",
                      "font-family": FONT_MONO,
                      "font-size": "11px",
                      color: todo.status === "completed" ? "var(--color-text-faint)" : "var(--color-text)",
                    }}
                  >
                    <span aria-hidden="true" style={{ "flex-shrink": 0 }}>
                      {glyph(todo.status)}
                    </span>
                    <span style={{ "text-decoration": todo.status === "completed" ? "line-through" : "none" }}>
                      {todo.content}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
