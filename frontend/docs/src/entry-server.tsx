import { StrictMode } from "react"
import { renderToString } from "react-dom/server"
import { App } from "./App"

export { DOC_CONFIG, DOC_PAGES } from "./DocsApp"

export function render(path: string): string {
  return renderToString(
    <StrictMode>
      <App initialPath={path} />
    </StrictMode>,
  )
}
