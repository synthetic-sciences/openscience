import { For, Show, createSignal, onMount } from "solid-js"
import { currentDirectory } from "@/utils/base64"
import { Icon } from "@synsci/ui/icon"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"

// Persistent notes/instructions the agent recalls across sessions. Wired to a
// real backend store: GET/PUT /settings/memory (backend/cli/src/settings/memory.ts).
// Two scopes — Global (all projects) and This project. When enabled the notes
// are injected into agent context on every turn (session/prompt.ts recall()).
// Each scope is bounded by a character budget (the capacity gauge below); the
// agent writes through the memory tool and its notes carry an "agent" badge.
// The search box is full-text keyword search (backend FTS5 BM25) over notes
// and past session messages — GET /settings/memory/search.

type Note = { id: string; text: string; createdAt: number; updatedAt?: number; source?: "user" | "agent" }
type Category = { id: string; name: string; notes: Note[] }
type Capacity = { used: number; max: number; gauge: string }
type Doc = { enabled: boolean; categories: Category[]; budget?: number; capacity?: Capacity }
type Scope = "global" | "project"
type Hit = {
  kind: "note" | "session"
  text: string
  score: number
  created: number
  scope?: Scope
  category?: string
  sessionID?: string
  messageID?: string
  role?: string
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)

export function searchEndpoint(base: string, q: string, directory: string) {
  const u = new URL(`${base}/settings/memory/search`)
  u.searchParams.set("q", q)
  u.searchParams.set("directory", directory)
  return u.toString()
}

export function usage(capacity?: Capacity) {
  if (!capacity || capacity.max <= 0) return 0
  return Math.min(100, Math.round((capacity.used / capacity.max) * 100))
}

export default function Memory() {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const doFetch = platform.fetch ?? fetch

  const [scope, setScope] = createSignal<Scope>("global")
  const [doc, setDoc] = createSignal<Doc>({ enabled: true, categories: [] })
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [newCategory, setNewCategory] = createSignal("")
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [term, setTerm] = createSignal("")
  const [hits, setHits] = createSignal<Hit[]>()
  const [searching, setSearching] = createSignal(false)

  function endpoint() {
    const u = new URL(`${sdk.url}/settings/memory`)
    u.searchParams.set("scope", scope())
    u.searchParams.set("directory", currentDirectory())
    return u.toString()
  }

  async function load() {
    setLoading(true)
    setError(undefined)
    try {
      const res = await doFetch(endpoint())
      if (!res.ok) throw new Error(await res.text())
      setDoc((await res.json()) as Doc)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function persist(next: Doc) {
    const previous = doc()
    setDoc(next)
    setSaving(true)
    setError(undefined)
    try {
      const res = await doFetch(endpoint(), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      })
      if (!res.ok) throw new Error(await res.text())
      setDoc((await res.json()) as Doc)
    } catch (e) {
      setDoc(previous)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function search() {
    const q = term().trim()
    if (!q) {
      setHits(undefined)
      return
    }
    setSearching(true)
    setError(undefined)
    try {
      const res = await doFetch(searchEndpoint(sdk.url, q, currentDirectory()))
      if (!res.ok) throw new Error(await res.text())
      const body = (await res.json()) as { results: Hit[] }
      setHits(body.results)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  function selectScope(next: Scope) {
    if (next === scope()) return
    setScope(next)
    void load()
  }

  function toggleEnabled(enabled: boolean) {
    void persist({ ...doc(), enabled })
  }

  function clearAll() {
    if (!window.confirm(`Clear all ${scope() === "global" ? "global" : "project"} memory? This cannot be undone.`))
      return
    void persist({ ...doc(), categories: [] })
  }

  function addCategory() {
    const name = newCategory().trim()
    if (!name) return
    setNewCategory("")
    void persist({ ...doc(), categories: [...doc().categories, { id: uid(), name, notes: [] }] })
  }

  function removeCategory(id: string) {
    void persist({ ...doc(), categories: doc().categories.filter((c) => c.id !== id) })
  }

  function addNote(categoryId: string) {
    const text = (drafts()[categoryId] ?? "").trim()
    if (!text) return
    setDrafts((d) => ({ ...d, [categoryId]: "" }))
    void persist({
      ...doc(),
      categories: doc().categories.map((c) =>
        c.id === categoryId
          ? { ...c, notes: [...c.notes, { id: uid(), text, createdAt: Date.now(), source: "user" as const }] }
          : c,
      ),
    })
  }

  function removeNote(categoryId: string, noteId: string) {
    void persist({
      ...doc(),
      categories: doc().categories.map((c) =>
        c.id === categoryId ? { ...c, notes: c.notes.filter((n) => n.id !== noteId) } : c,
      ),
    })
  }

  const noteCount = () => doc().categories.reduce((sum, c) => sum + c.notes.length, 0)

  onMount(() => void load())

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">Research memory</h2>
          <p class="text-13-regular text-text-weak">
            Keep a small, private brain for your preferences and a separate brain for this project. When memory is on,
            relevant notes are added to the agent's context on every turn.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-5 px-4 pb-10 sm:px-8 max-w-[760px]">
        {/* Scope selector */}
        <div class="inline-flex self-start rounded-xs border border-border-weak-base bg-surface-base/40 p-0.5">
          <For
            each={
              [
                { id: "global", label: "Personal brain" },
                { id: "project", label: "Project brain" },
              ] as const
            }
          >
            {(opt) => (
              <button
                type="button"
                class="h-7 px-3 rounded-xs text-12-medium transition-colors"
                classList={{
                  "bg-surface-raised-base-active text-text-strong": scope() === opt.id,
                  "text-text-weak hover:text-text-strong": scope() !== opt.id,
                }}
                onClick={() => selectScope(opt.id)}
              >
                {opt.label}
              </button>
            )}
          </For>
        </div>

        <Show when={error()}>
          <div class="rounded-xs border border-border-weak-base bg-surface-base/40 px-3 py-2 text-12-regular text-text-danger">
            {error()}
          </div>
        </Show>

        {/* Master toggle + clear all */}
        <div class="flex flex-col gap-3 rounded-[4px] border border-border-weak-base bg-surface-base/40 px-4 py-3">
          <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="text-13-medium text-text-strong">
                {scope() === "global" ? "Personal memory enabled" : "Project memory enabled"}
              </span>
              <span class="text-12-regular text-text-weak">
                {doc().enabled ? "Notes are recalled into agent context." : "Notes are saved but not recalled."}
              </span>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0">
              <Show when={noteCount() > 0}>
                <button
                  type="button"
                  class="h-8 px-3 rounded-xs text-12-medium text-text-danger hover:bg-surface-raised-base/60 transition-colors"
                  disabled={saving()}
                  onClick={clearAll}
                >
                  clear all
                </button>
              </Show>
              <Switch checked={doc().enabled} onChange={toggleEnabled} />
            </div>
          </div>

          {/* Capacity gauge — value comes from the backend (GET /settings/memory) */}
          <Show when={doc().capacity}>
            {(cap) => (
              <div class="flex flex-col gap-1">
                <div class="h-2 rounded-full overflow-hidden bg-surface-base">
                  <div
                    class="h-full rounded-full"
                    style={{
                      width: `${usage(cap())}%`,
                      background:
                        cap().used >= cap().max
                          ? "var(--color-error)"
                          : "var(--color-text-interactive-base, var(--icon-strong-base))",
                    }}
                  />
                </div>
                <span class="text-11-regular text-text-weak">
                  {cap().used.toLocaleString()} of {cap().max.toLocaleString()} characters used ({usage(cap())}%). When
                  full, the agent must consolidate notes before adding more.
                </span>
              </div>
            )}
          </Show>
        </div>

        {/* Full-text search over notes + past sessions */}
        <div class="flex flex-col gap-2 rounded-[4px] border border-border-weak-base bg-surface-base/40 px-4 py-3">
          <div class="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search notes and past sessions…"
              value={term()}
              class="flex-1 h-9 px-3 rounded-xs border border-border-weak-base bg-surface-raised-base/40 text-13-regular text-text-strong placeholder:text-text-weak/60 outline-none focus:border-border-base"
              onInput={(e) => setTerm(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && void search()}
            />
            <button
              type="button"
              class="h-9 px-4 rounded-xs text-13-medium bg-surface-raised-base-active text-text-strong hover:opacity-90 transition-opacity disabled:opacity-50"
              disabled={searching() || !term().trim()}
              onClick={() => void search()}
            >
              {searching() ? "searching…" : "search"}
            </button>
          </div>
          <span class="text-11-regular text-text-weak">
            Full-text keyword search over memory notes and this project's past sessions.
          </span>
          <Show when={hits()}>
            {(results) => (
              <div class="flex flex-col">
                <For
                  each={results()}
                  fallback={<span class="py-2 text-12-regular text-text-weak/70">No matches.</span>}
                >
                  {(hit) => (
                    <div class="flex items-start gap-2 py-2 border-b border-border-weak-base/60 last:border-b-0">
                      <span class="flex-shrink-0 px-1.5 py-0.5 rounded-xs border border-border-weak-base text-11-regular text-text-weak">
                        {hit.kind === "note" ? `note · ${hit.scope}` : "session"}
                      </span>
                      <div class="flex flex-col gap-0.5 min-w-0">
                        <span class="text-12-regular text-text-base break-words">{hit.text}</span>
                        <span class="text-11-regular text-text-weak/70">
                          {hit.kind === "note" ? hit.category : `${hit.role} · ${hit.sessionID}`} ·{" "}
                          {new Date(hit.created).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            )}
          </Show>
        </div>

        <Show when={!loading()} fallback={<div class="text-13-regular text-text-weak py-6 text-center">Loading…</div>}>
          {/* Categories */}
          <div class="flex flex-col gap-4">
            <For each={doc().categories}>
              {(category) => (
                <div class="rounded-[4px] border border-border-weak-base bg-surface-base/40 overflow-hidden">
                  <div class="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border-weak-base">
                    <span class="text-13-medium text-text-strong truncate">{category.name}</span>
                    <button
                      type="button"
                      class="flex items-center justify-center size-7 rounded-xs text-icon-weak-base hover:text-text-danger hover:bg-surface-raised-base/60 transition-colors"
                      disabled={saving()}
                      onClick={() => removeCategory(category.id)}
                      aria-label={`Remove ${category.name}`}
                    >
                      <Icon name="trash" size="small" />
                    </button>
                  </div>
                  <div class="flex flex-col">
                    <For
                      each={category.notes}
                      fallback={<span class="px-4 py-3 text-12-regular text-text-weak/70">No notes yet.</span>}
                    >
                      {(note) => (
                        <div class="group flex items-start gap-2 px-4 py-2.5 border-b border-border-weak-base/60 last:border-b-0">
                          <Icon name="dot-grid" size="small" class="text-icon-weak-base mt-0.5 flex-shrink-0" />
                          <span class="flex-1 text-13-regular text-text-base whitespace-pre-wrap break-words">
                            {note.text}
                          </span>
                          <Show when={note.source === "agent"}>
                            <span
                              class="flex-shrink-0 px-1.5 py-0.5 rounded-xs border border-border-weak-base text-11-regular text-text-weak"
                              title="Saved by the agent via the memory tool"
                            >
                              agent
                            </span>
                          </Show>
                          <button
                            type="button"
                            class="flex items-center justify-center size-6 rounded-xs text-icon-weak-base hover:text-text-danger opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                            disabled={saving()}
                            onClick={() => removeNote(category.id, note.id)}
                            aria-label="Remove note"
                          >
                            <Icon name="close-small" size="small" />
                          </button>
                        </div>
                      )}
                    </For>
                    <div class="flex items-center gap-2 px-3 py-2.5">
                      <input
                        type="text"
                        placeholder="Add a note…"
                        value={drafts()[category.id] ?? ""}
                        disabled={saving()}
                        class="flex-1 h-9 px-3 rounded-xs border border-border-weak-base bg-surface-raised-base/40 text-13-regular text-text-strong placeholder:text-text-weak/60 outline-none focus:border-border-base"
                        onInput={(e) => setDrafts((d) => ({ ...d, [category.id]: e.currentTarget.value }))}
                        onKeyDown={(e) => e.key === "Enter" && addNote(category.id)}
                      />
                      <button
                        type="button"
                        class="h-9 px-4 rounded-xs text-13-medium bg-surface-raised-base-active text-text-strong hover:opacity-90 transition-opacity disabled:opacity-50"
                        disabled={saving() || !(drafts()[category.id] ?? "").trim()}
                        onClick={() => addNote(category.id)}
                      >
                        add
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>

          {/* New category */}
          <div class="flex items-center gap-2">
            <input
              type="text"
              placeholder="New category"
              value={newCategory()}
              disabled={saving()}
              class="flex-1 h-9 px-3 rounded-xs border border-border-weak-base bg-surface-base/40 text-13-regular text-text-strong placeholder:text-text-weak/60 outline-none focus:border-border-base"
              onInput={(e) => setNewCategory(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && addCategory()}
            />
            <button
              type="button"
              class="flex items-center gap-1.5 h-9 px-4 rounded-xs text-13-medium border border-border-weak-base text-text-strong hover:bg-surface-raised-base/60 transition-colors disabled:opacity-50"
              disabled={saving() || !newCategory().trim()}
              onClick={addCategory}
            >
              <Icon name="plus" size="small" />
              add category
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}
