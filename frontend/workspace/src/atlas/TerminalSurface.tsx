import { createEffect, createMemo, For, on, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { preloadTerminal, Terminal, type TerminalController, type TerminalSearchResult } from "@/components/terminal"
import { useSDK } from "@/context/sdk"
import { useTerminal } from "@/context/terminal"
import { IconChevronLeft, IconChevronRight, IconPlus, IconSearch, IconX } from "@/atlas/shared/Icon"
import { terminalEndpointAvailable } from "@/atlas/terminal-endpoint"
import { useExecutionAuthority } from "@/atlas/use-execution-authority"

const EMPTY_RESULT: TerminalSearchResult = { current: 0, total: 0 }

export function TerminalSurface(): JSX.Element {
  preloadTerminal()
  const sdk = useSDK()
  const terminal = useTerminal()
  const authority = useExecutionAuthority("terminal")
  const [state, setState] = createStore({
    starting: false,
    connecting: false,
    error: "",
    searching: false,
    query: "",
    result: EMPTY_RESULT,
  })
  const available = createMemo(() => terminalEndpointAvailable(sdk.url))
  const active = createMemo(() => terminal.all().find((item) => item.id === terminal.active()))
  const controls = new Map<string, TerminalController>()
  const search = { input: undefined as HTMLInputElement | undefined }

  const control = () => {
    const id = active()?.id
    if (!id) return
    return controls.get(id)
  }

  const openSearch = () => {
    if (!control()) return
    setState("searching", true)
    queueMicrotask(() => search.input?.focus())
  }

  const closeSearch = () => {
    setState({ searching: false, query: "", result: EMPTY_RESULT })
    control()?.clearSelection()
    control()?.focus()
  }

  const find = (direction: "next" | "previous" = "next") => {
    const next = control()?.search(state.query, direction) ?? EMPTY_RESULT
    setState("result", next)
  }

  createEffect(() => {
    if (!terminal.ready() || terminal.active() || !terminal.all().length) return
    terminal.open(terminal.all()[0].id)
  })

  createEffect(
    on(
      () => active()?.id,
      () => setState("result", EMPTY_RESULT),
    ),
  )

  const launch = () => {
    if (!available() || state.starting) return
    if (!authority.allowed()) {
      setState("error", authority.message() ?? "This session cannot start a terminal.")
      return
    }
    setState({ starting: true, connecting: true, error: "" })
    void terminal
      .new()
      .then(() => setState("error", ""))
      .catch((cause: unknown) => {
        setState({
          connecting: false,
          error: cause instanceof Error ? cause.message : "OpenScience could not start the terminal.",
        })
      })
      .finally(() => setState("starting", false))
  }

  const autostart = { requested: false }
  createEffect(() => {
    if (autostart.requested || !available() || !terminal.ready() || terminal.all().length || state.starting) return
    if (!authority.allowed()) return
    autostart.requested = true
    launch()
  })

  return (
    <section class="terminal-surface" aria-label="Session terminal">
      <Show when={state.error}>
        {(message) => (
          <div class="terminal-surface__error" role="alert">
            {message()}
          </div>
        )}
      </Show>

      <Show when={available() ? authority.message() : undefined}>
        {(message) => (
          <div class="terminal-surface__authority" role={authority.decision.error ? "alert" : "status"}>
            {message()}
          </div>
        )}
      </Show>

      <Show
        when={available()}
        fallback={
          <div class="terminal-surface__empty">
            <span class="terminal-surface__empty-mark" aria-hidden="true">
              &gt;_
            </span>
            <strong>Local terminal unavailable</strong>
            <p>Connect OpenScience to a local server to run a shell inside this project.</p>
          </div>
        }
      >
        <Show
          when={terminal.ready()}
          fallback={
            <div class="terminal-surface__empty" aria-live="polite">
              <span class="terminal-surface__eyebrow">Preparing session shell…</span>
            </div>
          }
        >
          <Show
            when={terminal.all().length}
            fallback={
              <div class="terminal-surface__empty">
                <span class="terminal-surface__empty-mark" aria-hidden="true">
                  &gt;_
                </span>
                <strong>Run commands in this session</strong>
                <p>Start a persistent shell, then open more tabs whenever you need parallel work.</p>
                <button
                  type="button"
                  onClick={launch}
                  disabled={state.starting || !authority.allowed()}
                  title={authority.message()}
                  data-modal-initial-focus
                >
                  {state.starting ? "Starting…" : "Start terminal"}
                </button>
              </div>
            }
          >
            <div class="terminal-surface__tabs-row">
              <nav class="terminal-surface__tabs" role="tablist" aria-label="Open terminals">
                <For each={terminal.all()}>
                  {(pty) => (
                    <div class="terminal-surface__tab-shell" data-active={active()?.id === pty.id ? "true" : undefined}>
                      <button
                        type="button"
                        class="terminal-surface__tab"
                        role="tab"
                        aria-selected={active()?.id === pty.id}
                        aria-controls={`terminal-wrapper-${pty.id}`}
                        onClick={() => terminal.open(pty.id)}
                      >
                        {pty.title}
                      </button>
                      <button
                        type="button"
                        class="terminal-surface__close"
                        aria-label={`Close ${pty.title}`}
                        onClick={() => void terminal.close(pty.id)}
                      >
                        <IconX size={10} strokeWidth={1.7} />
                      </button>
                    </div>
                  )}
                </For>
              </nav>
              <button
                type="button"
                class="terminal-surface__new"
                onClick={launch}
                disabled={!available() || state.starting || !authority.allowed()}
                title={authority.message() ?? "New terminal"}
                aria-label={state.starting ? "Starting terminal" : "New terminal"}
              >
                <IconPlus size={12} strokeWidth={1.7} />
                <span>{state.starting ? "Starting…" : "New"}</span>
              </button>
            </div>

            <Show when={state.searching}>
              <form
                class="terminal-surface__search"
                role="search"
                onSubmit={(event) => {
                  event.preventDefault()
                  find("next")
                }}
              >
                <IconSearch size={12} strokeWidth={1.5} />
                <input
                  ref={(node) => (search.input = node)}
                  type="search"
                  value={state.query}
                  placeholder="Find in output"
                  aria-label="Find in terminal output"
                  autocomplete="off"
                  onInput={(event) => {
                    setState("query", event.currentTarget.value)
                    find()
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return
                    event.preventDefault()
                    closeSearch()
                  }}
                />
                <span class="terminal-surface__search-count" aria-live="polite">
                  {state.query ? `${state.result.current}/${state.result.total}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => find("previous")}
                  aria-label="Previous match"
                  title="Previous match"
                >
                  <IconChevronLeft size={12} strokeWidth={1.5} />
                </button>
                <button type="button" onClick={() => find("next")} aria-label="Next match" title="Next match">
                  <IconChevronRight size={12} strokeWidth={1.5} />
                </button>
                <button type="button" onClick={closeSearch} aria-label="Close search" title="Close search (Esc)">
                  <IconX size={11} strokeWidth={1.6} />
                </button>
              </form>
            </Show>

            <div class="terminal-surface__viewport">
              <Show when={state.connecting}>
                <div class="terminal-surface__connecting" role="status" aria-live="polite">
                  <span class="terminal-surface__connecting-mark" aria-hidden="true">
                    &gt;_
                  </span>
                  <span>Starting session shell…</span>
                </div>
              </Show>
              <For each={terminal.all()}>
                {(pty) => (
                  <div
                    id={`terminal-wrapper-${pty.id}`}
                    class="terminal-surface__terminal"
                    role="tabpanel"
                    aria-label={pty.title}
                    aria-hidden={active()?.id === pty.id ? undefined : "true"}
                    data-active={active()?.id === pty.id ? "true" : "false"}
                  >
                    <Terminal
                      pty={pty}
                      active={active()?.id === pty.id}
                      onReady={(controller) => {
                        if (controller) controls.set(pty.id, controller)
                        if (!controller) controls.delete(pty.id)
                      }}
                      onOpenSearch={openSearch}
                      onCleanup={(next) => terminal.update(next)}
                      onConnect={() => {
                        setState({ connecting: false, error: "" })
                      }}
                      onConnectError={(cause) => {
                        setState({ connecting: false, error: cause.message })
                      }}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
