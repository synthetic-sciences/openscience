import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { Icon } from "@synsci/ui/icon"
import stripAnsi from "strip-ansi"
import type { Message, Part, ToolPart } from "@synsci/sdk/v2/client"

interface SessionShellTabProps {
  scrollTo?: string
}

export function SessionShellTab(props: SessionShellTabProps) {
  const params = useParams()
  const sync = useSync()
  const language = useLanguage()
  let container: HTMLDivElement | undefined

  const bashParts = createMemo(() => {
    const id = params.id
    if (!id) return []

    const messages = (sync.data.message[id] ?? []) as Message[]
    const parts: { part: ToolPart; messageIndex: number }[] = []

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role !== "assistant") continue

      const msgParts = (sync.data.part[msg.id] ?? []) as Part[]
      for (const part of msgParts) {
        if (part.type === "tool" && part.tool === "bash") {
          parts.push({ part: part as ToolPart, messageIndex: i })
        }
      }
    }

    return parts
  })

  const formatDuration = (start: number, end: number) => {
    const ms = end - start
    if (ms < 1000) return `${ms}ms`
    const s = Math.round(ms / 100) / 10
    return `${s}s`
  }

  const getOutput = (part: ToolPart) => {
    const s = part.state
    if (s.status === "completed") return stripAnsi(s.output || "")
    if (s.status === "error") return s.error
    if (s.status === "running") return stripAnsi((s.metadata?.output as string) || "")
    return ""
  }

  const getCommand = (part: ToolPart) => {
    const s = part.state
    return (s.input?.command as string) ?? ""
  }

  const getDescription = (part: ToolPart) => {
    const s = part.state
    return (s.input?.description as string) ?? ""
  }

  // Auto-scroll to latest running command or scroll target
  createEffect(
    on(
      () => [bashParts().length, props.scrollTo],
      () => {
        if (!container) return

        requestAnimationFrame(() => {
          if (props.scrollTo) {
            const target = container!.querySelector(`[data-part-id="${props.scrollTo}"]`)
            if (target) {
              target.scrollIntoView({ behavior: "smooth", block: "start" })
              return
            }
          }

          // Scroll to the last running command, or to the bottom
          const running = container!.querySelector('[data-status="running"]')
          if (running) {
            running.scrollIntoView({ behavior: "smooth", block: "start" })
            return
          }

          container!.scrollTop = container!.scrollHeight
        })
      },
    ),
  )

  return (
    <div ref={container} class="h-full overflow-y-auto no-scrollbar pb-10">
      <Show
        when={bashParts().length > 0}
        fallback={
          <div class="h-full flex flex-col items-center justify-center text-center gap-4 px-6">
            <Icon name="console" class="text-text-weaker opacity-30" />
            <div class="text-13-regular text-text-weak max-w-56">
              No shell commands have been run in this session yet.
            </div>
          </div>
        }
      >
        <div class="flex flex-col gap-0.5 px-4 pt-3">
          <For each={bashParts()}>
            {(entry) => {
              const part = () => entry.part
              const status = () => part().state.status
              const output = createMemo(() => getOutput(part()))
              const command = createMemo(() => getCommand(part()))
              const description = createMemo(() => getDescription(part()))
              const duration = createMemo(() => {
                const s = part().state
                if (s.status === "completed") return formatDuration(s.time.start, s.time.end)
                if (s.status === "error") return formatDuration(s.time.start, s.time.end)
                if (s.status === "running") {
                  const elapsed = Date.now() - s.time.start
                  if (elapsed < 1000) return "<1s"
                  return `${Math.round(elapsed / 1000)}s`
                }
                return ""
              })

              return (
                <div data-part-id={part().id} data-status={status()} class="rounded-md overflow-hidden">
                  {/* Command header */}
                  <div class="flex items-center gap-2 px-3 py-2 bg-surface-base">
                    <div class="flex items-center gap-1.5 min-w-0 flex-1">
                      {/* Status indicator */}
                      <Show when={status() === "running"}>
                        <div class="size-2 rounded-full bg-syntax-success animate-pulse shrink-0" />
                      </Show>
                      <Show when={status() === "completed"}>
                        <div class="size-2 rounded-full bg-syntax-success shrink-0" />
                      </Show>
                      <Show when={status() === "error"}>
                        <div class="size-2 rounded-full bg-syntax-critical shrink-0" />
                      </Show>
                      <Show when={status() === "pending"}>
                        <div class="size-2 rounded-full bg-text-weaker shrink-0" />
                      </Show>

                      <code class="text-12-medium text-text-strong truncate">$ {command()}</code>
                    </div>

                    <div class="flex items-center gap-2 shrink-0">
                      <Show when={description()}>
                        <span class="text-11-regular text-text-weaker truncate max-w-48">{description()}</span>
                      </Show>
                      <Show when={duration()}>
                        <span class="text-11-regular text-text-weaker tabular-nums">{duration()}</span>
                      </Show>
                    </div>
                  </div>

                  {/* Output */}
                  <Show when={output()}>
                    <div class="bg-background-base border-t border-border-weak-base">
                      <pre class="px-3 py-2 text-12-regular text-text-base font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-80 overflow-y-auto no-scrollbar">
                        {output()}
                      </pre>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
