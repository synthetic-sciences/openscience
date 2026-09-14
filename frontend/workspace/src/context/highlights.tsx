import { createEffect, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@synsci/ui/context"
import { useDialog } from "@synsci/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { persisted } from "@/utils/persist"
import { DialogReleaseNotes, type Highlight } from "@/components/dialog-release-notes"
import { URLS } from "@/config/urls"

const CHANGELOG_URL = URLS.changelog

type Store = {
  version?: string
}

type ParsedRelease = {
  tag?: string
  highlights: Highlight[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    return text.length > 0 ? text : undefined
  }

  if (typeof value === "number") return String(value)
  return
}

function normalizeVersion(value: string | undefined) {
  const text = value?.trim()
  if (!text) return
  return text.startsWith("v") || text.startsWith("V") ? text.slice(1) : text
}

function parseMedia(value: unknown, alt: string): Highlight["media"] | undefined {
  if (!isRecord(value)) return
  const type = getText(value.type)?.toLowerCase()
  const src = getText(value.src) ?? getText(value.url)
  if (!src) return
  if (type !== "image" && type !== "video") return

  return { type, src, alt }
}

function parseHighlight(value: unknown): Highlight | undefined {
  if (!isRecord(value)) return

  const title = getText(value.title)
  if (!title) return

  const description = getText(value.description) ?? getText(value.shortDescription)
  if (!description) return

  const media = parseMedia(value.media, title)
  return { title, description, media }
}

/** One line of release Markdown as readable text: links keep their label,
 * emphasis marks go, and the trailing pull-request reference is dropped. */
export function cleanReleaseLine(line: string) {
  return line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\s*\(#\d+\)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A GitHub release body is Markdown: `## Section` headings over bullet lists,
 * plus HTML comments and release-process notes. Each section becomes one
 * highlight whose items are its bullets; paragraphs outside any section are
 * notes for the release page, not highlights. A body with no sections and no
 * bullets is shown as one paragraph.
 */
export function parseReleaseBody(body: string, version: string): Highlight[] {
  const text = body.replace(/<!--[\s\S]*?-->/g, "")
  const sections: { title: string; items: string[] }[] = []
  const loose: string[] = []
  const paragraphs: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      sections.push({ title: cleanReleaseLine(heading[1]), items: [] })
      continue
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line)
    if (bullet) {
      const item = cleanReleaseLine(bullet[1])
      if (!item) continue
      if (sections.length) sections.at(-1)!.items.push(item)
      else loose.push(item)
      continue
    }
    paragraphs.push(cleanReleaseLine(line))
  }
  const highlights = [
    ...(loose.length ? [{ title: version, description: "", items: loose }] : []),
    ...sections
      .filter((section) => section.items.length)
      .map((section) => ({
        title: section.title,
        description: "",
        items: section.items,
      })),
  ]
  if (highlights.length) return highlights
  const description = paragraphs.join(" ").trim()
  return description ? [{ title: version, description }] : []
}

function parseRelease(value: unknown): ParsedRelease | undefined {
  if (!isRecord(value)) return
  const tag = getText(value.tag) ?? getText(value.tag_name) ?? getText(value.name)

  if (!Array.isArray(value.highlights)) {
    const body = getText(value.body)
    if (!body) return { tag, highlights: [] }
    const version = getText(value.name) ?? tag ?? "OpenScience update"
    return {
      tag,
      highlights: parseReleaseBody(body, version).map((highlight) => ({ ...highlight, version })),
    }
  }

  const highlights = value.highlights.flatMap((group) => {
    if (!isRecord(group)) return []

    const source = getText(group.source)
    if (!source) return []
    if (!source.toLowerCase().includes("desktop")) return []

    if (Array.isArray(group.items)) {
      return group.items.map((item) => parseHighlight(item)).filter((item): item is Highlight => item !== undefined)
    }

    const item = parseHighlight(group)
    if (!item) return []
    return [item]
  })

  return { tag, highlights }
}

function parseChangelog(value: unknown): ParsedRelease[] | undefined {
  if (Array.isArray(value)) {
    return value.map(parseRelease).filter((release): release is ParsedRelease => release !== undefined)
  }

  if (!isRecord(value)) return
  if (!Array.isArray(value.releases)) return

  return value.releases.map(parseRelease).filter((release): release is ParsedRelease => release !== undefined)
}

function sliceHighlights(input: { releases: ParsedRelease[]; current?: string; previous?: string }) {
  const current = normalizeVersion(input.current)
  const previous = normalizeVersion(input.previous)
  const releases = input.releases

  const start = (() => {
    if (!current) return 0
    const index = releases.findIndex((release) => normalizeVersion(release.tag) === current)
    return index === -1 ? 0 : index
  })()

  const end = (() => {
    if (!previous) return releases.length
    const index = releases.findIndex((release, i) => i >= start && normalizeVersion(release.tag) === previous)
    return index === -1 ? releases.length : index
  })()

  const highlights = releases.slice(start, end).flatMap((release) => release.highlights)
  const seen = new Set<string>()
  const unique = highlights.filter((highlight) => {
    const key = [
      highlight.version ?? "",
      highlight.title,
      highlight.description,
      ...(highlight.items ?? []),
      highlight.media?.type ?? "",
      highlight.media?.src ?? "",
    ].join("\n")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.slice(0, 8)
}

export const { provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const dialog = useDialog()
    const settings = useSettings()
    const [store, setStore, _, ready] = persisted("highlights.v1", createStore<Store>({ version: undefined }))

    const [from, setFrom] = createSignal<string | undefined>(undefined)
    const [to, setTo] = createSignal<string | undefined>(undefined)
    const [timer, setTimer] = createSignal<ReturnType<typeof setTimeout> | undefined>(undefined)
    const state = { started: false }

    const markSeen = () => {
      if (!platform.version) return
      setStore("version", platform.version)
    }

    createEffect(() => {
      if (state.started) return
      if (!ready()) return
      if (!settings.ready()) return
      if (!platform.version) return
      state.started = true

      const previous = store.version
      if (!previous) {
        setStore("version", platform.version)
        return
      }

      if (previous === platform.version) return

      setFrom(previous)
      setTo(platform.version)

      if (!settings.general.releaseNotes()) {
        markSeen()
        return
      }

      const fetcher = platform.fetch ?? fetch
      const controller = new AbortController()
      onCleanup(() => {
        controller.abort()
        const id = timer()
        if (id === undefined) return
        clearTimeout(id)
      })

      fetcher(CHANGELOG_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .catch(() => undefined)
        .then((response) => (response?.ok ? (response.json() as Promise<unknown>) : undefined))
        .then((json) => {
          if (!json) return
          const releases = parseChangelog(json)
          if (!releases) return
          if (releases.length === 0) return
          const highlights = sliceHighlights({
            releases,
            current: platform.version,
            previous,
          })

          if (controller.signal.aborted) return

          if (highlights.length === 0) {
            markSeen()
            return
          }

          const timer = setTimeout(() => {
            markSeen()
            dialog.show(() => <DialogReleaseNotes highlights={highlights} version={platform.version} />)
          }, 500)
          setTimer(timer)
        })
        .catch(() => undefined)
    })

    return {
      ready,
      from,
      to,
      get last() {
        return store.version
      },
      markSeen,
    }
  },
})
