import { renderToString } from "react-dom/server"
import App, { ROUTES } from "./App"
import { rendered } from "./components/Meta"

export { ROUTES }
export { CANONICAL, GITHUB, INSTALL_SCRIPT, NPM, SYNTHETIC_SCIENCES, X } from "./data/links"

export function render(path: string) {
  rendered.meta = undefined
  const html = renderToString(<App path={path} />)
  return { html, meta: rendered.meta }
}
