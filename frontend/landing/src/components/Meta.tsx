import { useEffect } from "react"
import { SITE } from "@/data/links"

/* Per-route document metadata. The site is a single HTML file behind a
   catch-all rewrite, so each page sets its own title, description, and
   canonical URL on mount and restores the defaults on unmount. */
export function useMeta({ title, description, path }: { title: string; description: string; path: string }) {
  useEffect(() => {
    const previousTitle = document.title
    const url = `${SITE}${path}`
    const entries = [
      ["name", "description", description],
      ["property", "og:title", title],
      ["property", "og:description", description],
      ["property", "og:url", url],
      ["name", "twitter:title", title],
      ["name", "twitter:description", description],
    ] as const
    const restore = entries.map(([attribute, key, content]) => {
      const found = document.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`)
      const node = found ?? document.createElement("meta")
      const previous = node.getAttribute("content")
      if (!found) {
        node.setAttribute(attribute, key)
        document.head.append(node)
      }
      node.content = content
      return () => {
        if (!found) node.remove()
        else if (previous === null) node.removeAttribute("content")
        else node.content = previous
      }
    })
    const canonicalNode = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    const canonical = canonicalNode ?? document.createElement("link")
    const previousCanonical = canonical.getAttribute("href")
    if (!canonicalNode) {
      canonical.rel = "canonical"
      document.head.append(canonical)
    }
    canonical.href = url
    document.title = title

    return () => {
      document.title = previousTitle
      restore.forEach((undo) => undo())
      if (!canonicalNode) canonical.remove()
      else if (previousCanonical === null) canonical.removeAttribute("href")
      else canonical.href = previousCanonical
    }
  }, [title, description, path])
}
