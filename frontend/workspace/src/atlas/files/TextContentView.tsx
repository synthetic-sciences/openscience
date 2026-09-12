import { Match, Switch, type JSX } from "solid-js"
import { DataTableView } from "@/data/DataTableView"
import { MarkdownDocument } from "../MarkdownDocument"
import { NotebookDocument } from "./NotebookDocument"
import type { ViewerResolution } from "./viewer-registry"
import "../FilePreview.css"

export function TextContentView(props: { name: string; text: string; viewer: ViewerResolution }): JSX.Element {
  return (
    <Switch fallback={<pre class="remote-view__text">{props.text}</pre>}>
      <Match when={props.viewer.kind === "markdown"}>
        <MarkdownDocument name={props.name} text={props.text} />
      </Match>
      <Match when={props.viewer.kind === "table" && props.viewer.table}>
        <DataTableView text={props.text} format={props.viewer.table!} name={props.name} />
      </Match>
      <Match when={props.viewer.kind === "notebook"}>
        <NotebookDocument name={props.name} text={props.text} format={props.viewer.extension} />
      </Match>
    </Switch>
  )
}
