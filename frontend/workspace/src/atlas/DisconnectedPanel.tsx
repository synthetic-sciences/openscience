import { Show, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { useServer } from "@/context/server"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { FONT_CODE, FONT_SANS } from "@/styles/tokens"

/**
 * Banner shown when the local openscience server is confirmed unreachable
 * (healthy() === false — never on the initial `undefined` checking state, to
 * avoid a flash on first load). The health probe re-polls every 10s, so the
 * banner clears itself on recovery.
 */
export function DisconnectedPanel(): JSX.Element {
  const server = useServer()
  const dialog = useDialog()

  return (
    <Show when={server.healthy() === false}>
      <div
        role="alert"
        aria-label="Server connection lost"
        style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          padding: "9px 18px",
          background: "var(--color-error-muted, rgba(239,68,68,0.15))",
          "border-bottom": "1px solid var(--color-error, #ef4444)",
          "flex-shrink": 0,
          "flex-wrap": "wrap",
        }}
      >
        <span
          style={{
            width: "7px",
            height: "7px",
            "border-radius": "50%",
            background: "var(--color-error, #ef4444)",
            "flex-shrink": 0,
          }}
        />
        <div style={{ flex: "1 1 320px", "min-width": 0 }}>
          <div
            style={{
              "font-family": FONT_SANS,
              "font-size": "12.5px",
              "font-weight": "var(--font-weight-medium)",
              color: "var(--color-text)",
            }}
          >
            Can't reach your local OpenScience server
          </div>
          <div
            style={{
              "font-family": FONT_SANS,
              "font-size": "11.5px",
              color: "var(--color-text-muted)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {server.name} ·{" "}
            <Show when={server.isLocal()} fallback="Check the server URL or switch servers">
              Start it with <code style={{ "font-family": FONT_CODE }}>openscience serve</code>
            </Show>
            <Show when={server.failures() > 1}> · {server.failures()} failed checks</Show>
          </div>
        </div>
        <Button
          type="button"
          size="large"
          variant="primary"
          disabled={server.checking()}
          onClick={() => void server.refresh()}
          style={{
            "flex-shrink": 0,
          }}
        >
          {server.checking() ? "Checking…" : "Retry Now"}
        </Button>
        <Button
          type="button"
          size="large"
          variant="secondary"
          onClick={() => dialog.show(() => <DialogSelectServer />)}
          style={{
            "flex-shrink": 0,
          }}
        >
          Switch Server
        </Button>
      </div>
    </Show>
  )
}
