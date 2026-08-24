import { Match, Show, Switch, createSignal, onCleanup, onMount, type ParentProps } from "solid-js"
import { Button } from "@synsci/ui/button"
import { TextField } from "@synsci/ui/text-field"
import { settingsApi } from "@/components/settings/api"
import { URLS } from "@/config/urls"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { fetchSetupSession } from "./setup-session"
import { AsciiSpinner } from "./shared/AsciiSpinner"
import "./AccountGate.css"

type State = "checking" | "signed-in" | "signed-out" | "unavailable"

export function AccountGate(props: ParentProps) {
  const server = useServer()
  const platform = usePlatform()
  const [state, setState] = createSignal<State>("checking")
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const fetchFn = () => platform.fetch ?? fetch

  const check = async (showProgress = true) => {
    if (showProgress) setState("checking")
    setError(undefined)
    try {
      setState((await fetchSetupSession(server.url, fetchFn())) ? "signed-in" : "signed-out")
    } catch {
      // Keep already-authenticated local work mounted across a transient
      // status-check failure. Initial startup still fails closed.
      if (state() !== "signed-in") setState("unavailable")
    }
  }

  const connect = async () => {
    const value = key().trim()
    if (!value || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await settingsApi<{ ok: boolean; error?: string }>(server.url, fetchFn(), "/account/login-key", {
        method: "POST",
        body: JSON.stringify({ key: value }),
      })
      if (!result.ok) {
        setError(result.error || "That key was not accepted. Check it and try again.")
        return
      }
      setKey("")
      setState("signed-in")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect this device.")
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    void check()
    const refresh = () => void check(false)
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh()
    }
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener("openscience:account-changed", refresh)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => {
      window.clearInterval(timer)
      window.removeEventListener("openscience:account-changed", refresh)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", onVisibility)
    })
  })

  return (
    <Show
      when={state() === "signed-in"}
      fallback={
        <main class="account-gate" aria-labelledby="account-gate-title">
          <section class="account-gate__panel">
            <div class="account-gate__brand">OpenScience</div>
            <Switch>
              <Match when={state() === "checking"}>
                <div class="account-gate__loading">
                  <AsciiSpinner label="checking account…" color="var(--color-text-faint)" />
                </div>
              </Match>
              <Match when={state() === "unavailable"}>
                <h1 id="account-gate-title">OpenScience is not responding</h1>
                <p>Reconnect to the local OpenScience service, then try again.</p>
                <div class="account-gate__actions">
                  <Button variant="primary" size="small" onClick={() => void check()}>
                    Retry
                  </Button>
                </div>
              </Match>
              <Match when={state() === "signed-out"}>
                <h1 id="account-gate-title">Sign in to continue</h1>
                <p>
                  Connect a free Synthetic Sciences account once. This device stays signed in with a revocable API key.
                </p>
                <p class="account-gate__disclosure">
                  Use my data is on by default for connected accounts and shares a redacted complete research
                  trajectory. Turn it off anytime in Settings.
                </p>
                <div class="account-gate__actions">
                  <Button variant="primary" size="small" onClick={() => platform.openLink(URLS.dashboardCli)}>
                    Open Synthetic Sciences
                  </Button>
                </div>
                <div class="account-gate__divider">
                  <span>then paste your key</span>
                </div>
                <label class="account-gate__field">
                  <span>Synthetic Sciences API key</span>
                  <TextField
                    type="password"
                    hideLabel
                    placeholder="thk_…"
                    value={key()}
                    disabled={busy()}
                    onChange={setKey}
                    onKeyDown={(event: KeyboardEvent) => {
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      void connect()
                    }}
                  />
                </label>
                <Show when={error()}>
                  <p class="account-gate__error" role="status">
                    {error()}
                  </p>
                </Show>
                <div class="account-gate__actions account-gate__actions--end">
                  <Button
                    variant="primary"
                    size="small"
                    disabled={busy() || !key().trim()}
                    onClick={() => void connect()}
                  >
                    {busy() ? "Connecting…" : "Continue"}
                  </Button>
                </div>
                <p class="account-gate__note">You only need to do this once on this device.</p>
              </Match>
            </Switch>
          </section>
        </main>
      }
    >
      {props.children}
    </Show>
  )
}
