export const HTML_STYLESHEET_LIMIT = 16
export const HTML_STYLESHEET_BYTES = 2 * 1024 * 1024

type Options = {
  stylesheets?: ReadonlyMap<string, string>
  resolveStylesheet?: (stylesheet: string, value: string) => string
  resolveStylesheetPath?: (stylesheet: string, value: string) => string | undefined
}

const imports = /@import\s+(?:url\(\s*(?:(["'])([^"'\r\n]+)\1|([^)]*?))\s*\)|(["'])([^"'\r\n]+)\4)\s*([^;]*);/gi

/** Find stylesheets that need an authenticated read before srcdoc can use them. */
export function htmlStylesheets(source: string) {
  if (typeof DOMParser === "undefined") return []
  const document = new DOMParser().parseFromString(source, "text/html")
  return Array.from(document.querySelectorAll("link[href]"))
    .filter((link) => (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet"))
    .map((link) => link.getAttribute("href")?.trim())
    .filter((href): href is string => !!href)
    .filter((href, index, values) => values.indexOf(href) === index)
}

/** Load local stylesheet text in bounded batches; stale callers can abort through the supplied reader. */
export async function loadHtmlStylesheets(
  source: string,
  read: (href: string) => Promise<string | undefined>,
  include: (href: string) => boolean = () => true,
  resolve?: (stylesheet: string, value: string) => string | undefined,
) {
  const refs = htmlStylesheets(source).filter(include)
  const result = new Map<string, string>()
  const seen = new Set(refs)
  const count = { value: 0 }
  while (refs.length && count.value < HTML_STYLESHEET_LIMIT) {
    const batch = refs.splice(0, Math.min(4, HTML_STYLESHEET_LIMIT - count.value))
    count.value += batch.length
    const loaded = await Promise.all(batch.map(async (href) => [href, await read(href)] as const))
    for (const [href, css] of loaded) {
      if (css === undefined) continue
      result.set(href, css)
      if (!resolve) continue
      for (const target of cssStylesheets(css)) {
        const path = resolve(href, target)
        if (!path || seen.has(path) || !include(path)) continue
        seen.add(path)
        refs.push(path)
      }
    }
  }
  return result
}

/** Discover local candidates referenced by CSS imports without interpreting their media conditions. */
export function cssStylesheets(source: string) {
  return Array.from(source.matchAll(imports), (match) => (match[2] ?? match[3] ?? match[5] ?? "").trim())
    .filter(Boolean)
    .filter((href, index, values) => values.indexOf(href) === index)
}

/** Rewrite local CSS references while leaving remote, embedded, and fragment URLs to the resolver. */
export function rewriteCssAssets(source: string, resolve: (value: string) => string) {
  const imports = source.replace(
    /(@import\s+)(["'])([^"'\r\n]+)\2/gi,
    (match, prefix: string, quote: string, value: string) => {
      const target = value.trim()
      if (!target) return match
      return `${prefix}${quote}${resolve(target)}${quote}`
    },
  )
  return imports.replace(
    /url\(\s*(?:(["'])([\s\S]*?)\1|([^)]*?))\s*\)/gi,
    (match, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const target = (quoted ?? bare ?? "").trim()
      if (!target) return match
      const mark = quote ?? ""
      return `url(${mark}${resolve(target)}${mark})`
    },
  )
}

/**
 * Prepare untrusted HTML for a sandboxed srcdoc preview. A filesystem-relative
 * base URL cannot work inside srcdoc, so local media and CSS are routed through
 * the authorized raw-file endpoint before the document enters the iframe.
 */
export function rewriteHtmlAssets(source: string, resolve: (value: string) => string, options?: Options) {
  if (typeof DOMParser === "undefined") return source
  const document = new DOMParser().parseFromString(source, "text/html")
  for (const base of document.querySelectorAll("base")) base.remove()
  const resources = [
    { selector: "img[src]", attributes: ["src"] },
    { selector: "img[srcset]", attributes: ["srcset"] },
    { selector: "source[src]", attributes: ["src"] },
    { selector: "source[srcset]", attributes: ["srcset"] },
    { selector: "video[src], video[poster]", attributes: ["src", "poster"] },
    { selector: "audio[src], track[src], embed[src]", attributes: ["src"] },
    { selector: "object[data]", attributes: ["data"] },
    { selector: "image[href]", attributes: ["href"] },
  ]
  for (const resource of resources) {
    for (const element of document.querySelectorAll(resource.selector)) {
      for (const attribute of resource.attributes) {
        const value = element.getAttribute(attribute)
        if (!value) continue
        element.setAttribute(attribute, attribute === "srcset" ? rewriteSrcset(value, resolve) : resolve(value))
      }
    }
  }
  for (const element of document.querySelectorAll("[style]")) {
    const value = element.getAttribute("style")
    if (value) element.setAttribute("style", rewriteCssAssets(value, resolve))
  }
  for (const style of document.querySelectorAll("style")) {
    style.textContent = rewriteCssAssets(style.textContent ?? "", resolve)
  }
  for (const link of document.querySelectorAll("link[href]")) {
    const relations = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/)
    if (!relations.includes("stylesheet")) continue
    const href = link.getAttribute("href")?.trim()
    if (!href) continue
    const css = options?.stylesheets?.get(href)
    if (css === undefined) {
      link.setAttribute("href", resolve(href))
      continue
    }
    const style = document.createElement("style")
    for (const attribute of ["media", "title"]) {
      const value = link.getAttribute(attribute)
      if (value) style.setAttribute(attribute, value)
    }
    style.textContent = rewriteStylesheet(css, href, resolve, options, new Set([href]))
    link.replaceWith(style)
  }
  return `<!doctype html>\n${document.documentElement.outerHTML}`
}

function rewriteStylesheet(
  source: string,
  href: string,
  resolve: (value: string) => string,
  options: Options | undefined,
  stack: ReadonlySet<string>,
) {
  const blocks: string[] = []
  const masked = source.replace(imports, (match, _quote, quoted, bare, _mark, direct, condition) => {
    const target = String(quoted ?? bare ?? direct ?? "").trim()
    const key = options?.resolveStylesheetPath?.(href, target)
    const css = key ? options?.stylesheets?.get(key) : undefined
    const media = String(condition ?? "").trim()
    if (css === undefined || !key || stack.has(key) || /^(?:layer|supports)\b/i.test(media)) return match
    const next = new Set(stack)
    next.add(key)
    const nested = rewriteStylesheet(css.replace(/^\s*@charset\s+[^;]+;/i, ""), key, resolve, options, next)
    blocks.push(media ? `@media ${media} {\n${nested}\n}` : nested)
    return `/*__openscience_css_import_${blocks.length - 1}__*/`
  })
  const rewritten = rewriteCssAssets(masked, (value) => options?.resolveStylesheet?.(href, value) ?? resolve(value))
  return rewritten.replace(
    /\/\*__openscience_css_import_(\d+)__\*\//g,
    (match, index: string) => blocks[Number(index)] ?? match,
  )
}

function rewriteSrcset(value: string, resolve: (value: string) => string) {
  // Data URLs contain a structural comma, so preserve the full declaration
  // instead of guessing at candidate boundaries. Ordinary responsive image
  // candidates are comma-delimited and keep their density/width descriptors.
  if (/\bdata:/i.test(value)) return value
  return value
    .split(",")
    .map((candidate) => {
      const match = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate)
      if (!match) return candidate
      return `${match[1]}${resolve(match[2]!)}${match[3]}`
    })
    .join(",")
}
