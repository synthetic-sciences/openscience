import { DocumentationPage } from "./DocsApp"

export function App({ initialPath }: { initialPath?: string } = {}) {
  return <DocumentationPage initialPath={initialPath} />
}
