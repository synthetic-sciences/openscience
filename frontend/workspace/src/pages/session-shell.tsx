import type { ParentProps } from "solid-js"
import { MarkedProvider } from "@synsci/ui/context/marked"
import { DiffComponentProvider } from "@synsci/ui/context/diff"
import { CodeComponentProvider } from "@synsci/ui/context/code"
import { Diff } from "@synsci/ui/diff"
import { Code } from "@synsci/ui/code"
import { usePlatform } from "@/context/platform"
// Side effect: registers the inline science-artifact tool renderer before the
// session page can dispatch a `metadata.artifact` envelope.
import "@/science/tool-renderer"
import SessionPage from "./session"

export function SessionRenderProviders(props: ParentProps) {
  const platform = usePlatform()
  return (
    <MarkedProvider nativeParser={platform.parseMarkdown}>
      <DiffComponentProvider component={Diff}>
        <CodeComponentProvider component={Code}>{props.children}</CodeComponentProvider>
      </DiffComponentProvider>
    </MarkedProvider>
  )
}

export default function SessionShell() {
  return (
    <SessionRenderProviders>
      <SessionPage />
    </SessionRenderProviders>
  )
}
