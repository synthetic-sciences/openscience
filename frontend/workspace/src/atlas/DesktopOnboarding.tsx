import { For, Show, createSignal, onMount, type ParentProps } from "solid-js"
import { Button } from "@synsci/ui/button"
import { TextField } from "@synsci/ui/text-field"
import { settingsApi } from "@/components/settings/api"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import "./DesktopOnboarding.css"

type Route = "ace" | "api" | "local" | "chatgpt"
type Compute = "modal" | "own" | "later"

const routes: Array<{ id: Route; title: string; detail: string; tag?: string }> = [
  {
    id: "ace",
    title: "OpenScience Ace",
    detail: "Pay as you go. Unlock scientific schematics and enhanced Firecrawl research search.",
    tag: "Recommended",
  },
  { id: "api", title: "My API key", detail: "Use an OpenAI, Anthropic, or OpenRouter key from this device." },
  { id: "local", title: "Local models", detail: "Use Ollama or LM Studio without sending inference to Ace." },
  { id: "chatgpt", title: "ChatGPT / Codex", detail: "Use your existing ChatGPT subscription through Codex." },
]

const providers = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
]

export function DesktopOnboarding(props: ParentProps) {
  const desktop = new URLSearchParams(window.location.search).get("desktop") === "1"
  const [complete, setComplete] = createSignal(!desktop)
  const [ready, setReady] = createSignal(!desktop)
  const [step, setStep] = createSignal<1 | 2>(1)
  const [route, setRoute] = createSignal<Route>("ace")
  const [compute, setCompute] = createSignal<Compute>("modal")
  const [provider, setProvider] = createSignal("anthropic")
  const [key, setKey] = createSignal("")
  const [modal, setModal] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const server = useServer()
  const platform = usePlatform()
  const fetcher = () => platform.fetch ?? fetch

  onMount(() => {
    if (!desktop) return
    void settingsApi<{ desktop_onboarding_version: number }>(server.url, fetcher(), "/settings/preferences")
      .then((value) => setComplete(value.desktop_onboarding_version >= 1))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setReady(true))
  })

  const finish = async () => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    await (async () => {
      await settingsApi(server.url, fetcher(), "/account/billing-mode", {
        method: "POST",
        body: JSON.stringify({ mode: route() === "ace" ? "managed" : "byok" }),
      })
      if (route() === "api") {
        if (!key().trim()) throw new Error("Enter the provider API key to continue.")
        await settingsApi(server.url, fetcher(), `/auth/${encodeURIComponent(provider())}`, {
          method: "PUT",
          body: JSON.stringify({ type: "api", key: key().trim() }),
        })
      }
      if (compute() === "modal" && modal().trim()) {
        await settingsApi(server.url, fetcher(), "/settings/compute/provider/modal", {
          method: "POST",
          body: JSON.stringify({ key: modal().trim() }),
        })
      }
      await settingsApi(server.url, fetcher(), "/settings/preferences", {
        method: "PATCH",
        body: JSON.stringify({ desktop_onboarding_version: 1 }),
      })
      setComplete(true)
    })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    setBusy(false)
  }

  return (
    <Show when={ready()} fallback={<main class="desktop-onboarding" aria-label="Loading desktop setup" />}>
      <Show
        when={complete()}
        fallback={
          <main class="desktop-onboarding" aria-labelledby="desktop-onboarding-title">
            <section class="desktop-onboarding__shell">
              <header>
                <span>OpenScience</span>
                <small>Setup {step()} of 2</small>
              </header>
              <Show
                when={step() === 1}
                fallback={
                  <>
                    <div class="desktop-onboarding__intro">
                      <p>Compute</p>
                      <h1 id="desktop-onboarding-title">Where should experiments run?</h1>
                      <span>Inference works without remote compute. You can change this anytime.</span>
                    </div>
                    <div class="desktop-onboarding__choices desktop-onboarding__choices--three">
                      <button type="button" data-selected={compute() === "modal"} onClick={() => setCompute("modal")}>
                        <strong>
                          Modal <em>Recommended</em>
                        </strong>
                        <span>Serverless GPU jobs with durable volumes.</span>
                      </button>
                      <button type="button" data-selected={compute() === "own"} onClick={() => setCompute("own")}>
                        <strong>Another provider</strong>
                        <span>Configure RunPod, Lambda, SSH, AWS, GCP, or Azure later.</span>
                      </button>
                      <button type="button" data-selected={compute() === "later"} onClick={() => setCompute("later")}>
                        <strong>Not now</strong>
                        <span>Start locally and add compute from Settings.</span>
                      </button>
                    </div>
                    <Show when={compute() === "modal"}>
                      <label class="desktop-onboarding__field">
                        <span>
                          Modal token <small>optional</small>
                        </span>
                        <TextField
                          hideLabel
                          type="password"
                          value={modal()}
                          onChange={setModal}
                          placeholder="ak-… : as-…"
                        />
                      </label>
                    </Show>
                  </>
                }
              >
                <div class="desktop-onboarding__intro">
                  <p>Inference</p>
                  <h1 id="desktop-onboarding-title">Choose how models run</h1>
                  <span>Start with Ace or connect an account you already pay for.</span>
                </div>
                <div class="desktop-onboarding__choices">
                  <For each={routes}>
                    {(item) => (
                      <button type="button" data-selected={route() === item.id} onClick={() => setRoute(item.id)}>
                        <strong>
                          {item.title}
                          {item.tag && <em>{item.tag}</em>}
                        </strong>
                        <span>{item.detail}</span>
                      </button>
                    )}
                  </For>
                </div>
                <Show when={route() === "api"}>
                  <div class="desktop-onboarding__credentials">
                    <label>
                      <span>Provider</span>
                      <select value={provider()} onChange={(event) => setProvider(event.currentTarget.value)}>
                        <For each={providers}>{(item) => <option value={item.id}>{item.label}</option>}</For>
                      </select>
                    </label>
                    <label class="desktop-onboarding__field">
                      <span>API key</span>
                      <TextField hideLabel type="password" value={key()} onChange={setKey} placeholder="Paste key" />
                    </label>
                  </div>
                </Show>
                <Show when={route() === "chatgpt" || route() === "local"}>
                  <p class="desktop-onboarding__note">
                    We’ll open the workspace next. Finish this connection from Settings → Models; no terminal is
                    required.
                  </p>
                </Show>
              </Show>
              <Show when={error()}>
                <p class="desktop-onboarding__error" role="alert">
                  {error()}
                </p>
              </Show>
              <footer>
                <Button variant="secondary" size="small" disabled={step() === 1 || busy()} onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  size="small"
                  disabled={busy()}
                  onClick={() => (step() === 1 ? setStep(2) : void finish())}
                >
                  {busy() ? "Saving…" : step() === 1 ? "Continue" : "Open workspace"}
                </Button>
              </footer>
            </section>
          </main>
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}
