import { createMemo, For, Show, type ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Markdown } from "@synsci/ui/markdown"
import { Popover } from "@synsci/ui/popover"
import { splitAlignedMarkdown } from "./FilePreviewMarkdown"
import {
  documentDefaults,
  readDocumentPreferences,
  writeDocumentPreferences,
  type DocumentPreferences,
} from "./document-preferences"
import "./FilePreview.css"

/** Document-only presentation. Source bytes, sanitization and authorized
 * image/file resolution remain the shared Markdown renderer's responsibility. */
export function MarkdownDocument(
  props: Pick<ComponentProps<typeof Markdown>, "text" | "resolveImage" | "resolveFile" | "onOpenFile"> & {
    name?: string
  },
) {
  const [reading, setReading] = createStore(readDocumentPreferences())
  const markdown = createMemo(() => splitAlignedMarkdown(props.text))
  const change = (next: Partial<DocumentPreferences>) => {
    setReading(next)
    writeDocumentPreferences({ ...reading })
  }
  const content = (text: string) => (
    <Markdown
      class="atlas-md"
      text={text}
      resolveImage={props.resolveImage}
      resolveFile={props.resolveFile}
      onOpenFile={props.onOpenFile}
    />
  )

  return (
    <article
      class="atlas-file-document atlas-markdown-document"
      aria-label={props.name ? `${props.name} preview` : "Markdown preview"}
      data-reading-font={reading.font}
      data-reading-width={reading.width}
      style={{ "--document-font-size": `${reading.size}px` }}
    >
      <div class="atlas-document-tools">
        <Popover
          title="Reading options"
          description="Saved on this device. Your file stays unchanged."
          placement="bottom-end"
          class="atlas-reading-options"
          triggerAs="button"
          triggerProps={{
            type: "button",
            class: "atlas-file-button atlas-reading-trigger",
            "aria-label": "Reading options",
            title: "Reading options",
          }}
          trigger={<span aria-hidden="true">Aa</span>}
        >
          <fieldset>
            <legend>Text size</legend>
            <div class="atlas-reading-choices" role="group" aria-label="Document text size">
              <For each={[13, 15, 17, 19]}>
                {(size) => (
                  <button
                    type="button"
                    aria-label={`${size} pixels`}
                    aria-pressed={reading.size === size}
                    onClick={() => change({ size })}
                  >
                    {size}
                  </button>
                )}
              </For>
            </div>
          </fieldset>
          <fieldset>
            <legend>Typeface</legend>
            <div class="atlas-reading-choices" role="group" aria-label="Document typeface">
              <button type="button" aria-pressed={reading.font === "sans"} onClick={() => change({ font: "sans" })}>
                Sans
              </button>
              <button type="button" aria-pressed={reading.font === "serif"} onClick={() => change({ font: "serif" })}>
                Serif
              </button>
            </div>
          </fieldset>
          <fieldset>
            <legend>Page width</legend>
            <div class="atlas-reading-choices" role="group" aria-label="Document page width">
              <button
                type="button"
                aria-pressed={reading.width === "readable"}
                onClick={() => change({ width: "readable" })}
              >
                Readable
              </button>
              <button type="button" aria-pressed={reading.width === "full"} onClick={() => change({ width: "full" })}>
                Full width
              </button>
            </div>
          </fieldset>
          <button type="button" class="atlas-reading-reset" onClick={() => change(documentDefaults)}>
            Reset reading options
          </button>
        </Popover>
      </div>
      <Show when={markdown().lead} fallback={content(props.text)}>
        {(lead) => (
          <div class="atlas-file-document-lead" data-align={lead().alignment}>
            {content(lead().text)}
          </div>
        )}
      </Show>
      <Show when={markdown().lead && markdown().rest}>{(rest) => content(rest())}</Show>
    </article>
  )
}
