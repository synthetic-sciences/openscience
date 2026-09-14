import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { useSettings } from "@/context/settings"
import "./dialog-release-notes.css"

export type Highlight = {
  /** Section or feature name, e.g. "Core". */
  title: string
  /** Prose shown when the release has no bullet list. */
  description: string
  /** Bullet items of a release section. */
  items?: string[]
  /** The release this highlight belongs to, e.g. "v2.0.96". */
  version?: string
  media?: {
    type: "image" | "video"
    src: string
    alt?: string
  }
}

export function DialogReleaseNotes(props: { highlights: Highlight[]; version?: string }) {
  const dialog = useDialog()
  const settings = useSettings()
  const [index, setIndex] = createSignal(0)

  const total = () => props.highlights.length
  const last = () => Math.max(0, total() - 1)
  const feature = () => props.highlights[index()] ?? props.highlights[last()]
  const isFirst = () => index() === 0
  const isLast = () => index() >= last()
  const paged = () => total() > 1
  const version = () => {
    const value = feature()?.version ?? props.version
    if (!value) return
    return value.startsWith("v") ? value : `v${value}`
  }
  // The section name doubles as the release name for single-paragraph bodies;
  // do not print it twice in that case.
  const section = () => {
    const title = feature()?.title
    if (!title) return
    return title === feature()?.version || title === version() ? undefined : title
  }

  function handleNext() {
    if (isLast()) return
    setIndex(index() + 1)
  }

  function handleBack() {
    if (isFirst()) return
    setIndex(index() - 1)
  }

  function handleClose() {
    dialog.close()
  }

  function handleDisable() {
    settings.general.setReleaseNotes(false)
    handleClose()
  }

  let focusTrap: HTMLDivElement | undefined

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      handleClose()
      return
    }

    if (!paged()) return
    if (e.key === "ArrowLeft") {
      e.preventDefault()
      handleBack()
    }
    if (e.key === "ArrowRight") {
      e.preventDefault()
      handleNext()
    }
  }

  onMount(() => {
    focusTrap?.focus()
    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  // Refocus the trap when index changes to ensure escape always works
  createEffect(() => {
    index() // track index
    focusTrap?.focus()
  })

  return (
    <Dialog
      title={version() ? `What's new in ${version()}` : "What's new"}
      description={
        paged()
          ? `${total()} updates since the version you were running.`
          : "Changes since the version you were running."
      }
      class="release-notes-dialog"
      fit
      transition
    >
      {/* Hidden element to capture initial focus and handle escape */}
      <div ref={focusTrap} tabindex="0" class="release-notes__focus-trap" />
      <div class="release-notes">
        <div class="release-notes__body">
          <Show when={section()}>
            <h3 class="release-notes__section">{section()}</h3>
          </Show>
          <Show
            when={feature()?.items?.length}
            fallback={<p class="release-notes__text">{feature()?.description ?? ""}</p>}
          >
            <ul class="release-notes__list">
              <For each={feature()?.items ?? []}>{(item) => <li>{item}</li>}</For>
            </ul>
          </Show>
          <Show when={feature()?.media}>
            {(media) => (
              <div class="release-notes__media">
                <Show
                  when={media().type === "image"}
                  fallback={<video src={media().src} autoplay loop muted playsinline />}
                >
                  <img src={media().src} alt={media().alt ?? feature()?.title ?? "Release preview"} />
                </Show>
              </div>
            )}
          </Show>
        </div>

        <div class="release-notes__footer">
          <Button variant="ghost" size="small" onClick={handleDisable}>
            Don't show release notes again
          </Button>
          <div class="release-notes__actions">
            <Show when={paged()}>
              <div class="release-notes__pager" role="tablist" aria-label="Release note pages">
                <For each={props.highlights}>
                  {(_, i) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={i() === index()}
                      aria-label={`Page ${i() + 1} of ${total()}`}
                      class="release-notes__dot"
                      data-active={i() === index() ? true : undefined}
                      onClick={() => setIndex(i())}
                    />
                  )}
                </For>
              </div>
            </Show>
            <Show when={paged() && !isFirst()}>
              <Button variant="secondary" size="normal" onClick={handleBack}>
                Back
              </Button>
            </Show>
            <Show
              when={isLast()}
              fallback={
                <Button variant="primary" size="normal" onClick={handleNext}>
                  Next
                </Button>
              }
            >
              <Button variant="primary" size="normal" onClick={handleClose}>
                Got it
              </Button>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
