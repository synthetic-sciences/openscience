// Skills — the catalog of playbooks agents load on demand, in the tiers the
// agent itself uses: the Core toolkit first, the user's own skills, then the
// library by subject with each shelf folded until it is wanted. Data,
// selection, authoring and sources all go through the real APIs.
import {
  For,
  Show,
  Switch as Branch,
  Match,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { Switch } from "@synsci/ui/switch"
import { createStore } from "solid-js/store"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useGlobalSync } from "@/context/global-sync"
import type { Config } from "@synsci/sdk/v2/client"
import { installFromGit } from "./skills-settings"
import {
  setSkillPinned,
  skillCatalogSnapshot,
  skillAction,
  skillPreferences,
  SKILL_PREFERENCES_EVENT,
} from "./skill-permissions"
import "./skills-page.css"
import { SearchInput, AddMenu, EmptyState, FormField, FormButton } from "@/components/settings/_shared"
import { skillIconFor } from "./skill-icon"
import {
  compareCore,
  coreSkill,
  selectedSkills,
  skillCatalogKey,
  skillSelection,
  skillSource,
  type SkillSource,
  type SkillView,
} from "./skill-selection"

export { skillIconFor } from "./skill-icon"

export interface Skill {
  name: string
  description?: string
  summary?: string
  location: string
  origin?: SkillSource
  category?: string
  tags?: string[]
  entry?: boolean
  permission_action?: "allow" | "ask" | "deny"
  recommended?: boolean
  enabled?: boolean
  disabled_by?: "server" | "project"
  catalog_status?: string
}

export interface SkillRoot {
  path: string
  kind: "bundled" | "project" | "user" | "installed" | "config" | "runtime"
  skills: number
  shadowed: number
}

export interface SkillRoots {
  roots: SkillRoot[]
  shadowed: Array<{ name: string; location: string; by: string }>
}

const memorySkillCache = new Map<string, Skill[]>()
const skillCatalogRequests = new Map<string, Promise<Skill[]>>()
const FLAT_ROWS = 120

function cachedSkills(key: string) {
  if (memorySkillCache.has(key)) return memorySkillCache.get(key)!
  if (typeof sessionStorage === "undefined") return []
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? "null") as { skills?: Skill[] } | null
    if (!Array.isArray(parsed?.skills)) return []
    memorySkillCache.set(key, parsed.skills)
    return parsed.skills
  } catch {
    return []
  }
}

function rememberSkills(key: string, skills: Skill[]) {
  memorySkillCache.set(key, skills)
  if (typeof sessionStorage === "undefined") return
  try {
    sessionStorage.setItem(key, JSON.stringify({ skills }))
  } catch {
    // The in-memory cache still makes later Settings visits immediate.
  }
}

function loadSkillCatalog(key: string, load: () => Promise<Skill[]>) {
  const pending = skillCatalogRequests.get(key)
  if (pending) return pending
  const request = load()
    .then((skills) => {
      if (skillCatalogRequests.get(key) === request) rememberSkills(key, skills)
      return skills
    })
    .finally(() => {
      if (skillCatalogRequests.get(key) === request) skillCatalogRequests.delete(key)
    })
  skillCatalogRequests.set(key, request)
  return request
}

type Form =
  { kind: "list" } | { kind: "scratch" } | { kind: "github" } | { kind: "folder" } | { kind: "edit"; name: string }

export function displayLabel(value: string) {
  const words = value.replace(/[-_]+/g, " ").trim()
  if (/^(ml|llm|ai)\b/i.test(words)) return words.replace(/^(ml|llm|ai)\b/i, (m) => m.toUpperCase())
  const label = /[A-Z]/.test(words) && words === words.toUpperCase() ? words.toLowerCase() : words
  return label ? label[0]!.toUpperCase() + label.slice(1) : value
}

const SOURCE_LABEL: Record<SkillSource, string> = {
  default: "Default",
  installed: "Installed",
  user: "Personal",
  project: "Project",
}

const ROOT_LABEL: Record<SkillRoot["kind"], string> = {
  bundled: "Bundled",
  project: "Project",
  user: "Personal",
  installed: "Installed",
  config: "Configured",
  runtime: "Registered",
}

/** One line under a title: the summary when the author wrote one, otherwise
 * the first sentence of the description. */
export function blurb(skill: Pick<Skill, "summary" | "description">) {
  const text = (skill.summary || skill.description || "").trim()
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? ""
  return first.replace(/[.!]$/, "")
}

export type SkillsPageServices = {
  server: string
  load: () => Promise<Skill[]>
  disabled: () => readonly string[]
  permission: () => unknown
  select: (names: string[], enabled: boolean) => Promise<readonly string[]>
  create: (name: string, content: string) => Promise<unknown>
  read: (name: string) => Promise<string>
  remove: (name: string) => Promise<unknown>
  install: (url: string) => Promise<{ installed: unknown[]; rejected: unknown[] }>
  roots: () => Promise<SkillRoots>
  addRoot: (path: string, persist?: "global" | "project") => Promise<SkillRoot>
  removeRoot: (path: string, persist?: "global" | "project") => Promise<unknown>
  watch?: (refresh: () => void) => () => void
}

export default function SkillsPage(props: { embedded?: boolean; services?: SkillsPageServices }): JSX.Element {
  const service =
    props.services ??
    (() => {
      const sdk = useGlobalSDK()
      const platform = usePlatform()
      const sync = useGlobalSync()
      type SelectionConfig = Config & { skills?: { paths?: string[]; disabled?: string[] } }
      return {
        server: sdk.url,
        load: async () => (await sdk.client.app.skills()).data ?? [],
        disabled: () => (sync.data.config as SelectionConfig).skills?.disabled ?? [],
        permission: () => sync.data.config.permission,
        select: async (names: string[], enabled: boolean) => {
          // Re-read before a queued edit so selections made elsewhere survive.
          const current = (await sdk.client.global.config.get()).data as SelectionConfig
          const disabled = skillSelection(current.skills?.disabled ?? [], names, enabled)
          const saved = (await sync.updateConfig({ skills: { disabled } } as SelectionConfig)).data as
            SelectionConfig | undefined
          if (
            !saved?.skills?.disabled ||
            JSON.stringify([...saved.skills.disabled].sort()) !== JSON.stringify([...disabled].sort())
          ) {
            throw new Error("This server did not confirm the selection. Update the OpenScience server and try again.")
          }
          sync.set("config", "skills", { ...sync.data.config.skills, disabled } as SelectionConfig["skills"])
          return disabled
        },
        create: (name: string, content: string) => sdk.client.app.skill.write({ name, content }),
        read: async (name: string) => {
          const result = await sdk.client.app.skill.content({ name })
          if (!result.data) throw new Error("This skill could not be read.")
          return result.data.content
        },
        remove: (name: string) => sdk.client.app.skill.delete({ name }),
        install: (url: string) => installFromGit(platform.fetch ?? fetch, sdk.url, url),
        roots: async () => {
          const result = await sdk.client.settings.skills.roots()
          if (!result.data) throw new Error("Skill sources could not be read.")
          return result.data
        },
        addRoot: async (path: string, persist?: "global" | "project") => {
          const result = await sdk.client.settings.skills.addRoot({ path, persist })
          if (!result.data) {
            const error = result.error as { error?: string } | undefined
            throw new Error(error?.error ?? "This folder could not be added.")
          }
          return result.data
        },
        removeRoot: (path: string, persist?: "global" | "project") =>
          sdk.client.settings.skills.removeRoot({ path, persist }),
        watch: (refresh: () => void) =>
          sdk.event.listen((event) => {
            if (event.details?.type === "skill.updated") refresh()
          }),
      } satisfies SkillsPageServices
    })()

  const cacheKey = skillCatalogKey(service.server)
  const initialSkills = cachedSkills(cacheKey)
  const [skills, skillsCtl] = createResource(() => loadSkillCatalog(cacheKey, service.load), {
    initialValue: initialSkills,
  })
  const [roots, rootsCtl] = createResource(() => service.roots().catch(() => undefined))
  const refresh = () => {
    skillCatalogRequests.delete(cacheKey)
    void skillsCtl.refetch()
    void rootsCtl.refetch()
  }
  if (service.watch) onCleanup(service.watch(refresh))

  const [search, setSearch] = createSignal("")
  const [form, setForm] = createSignal<Form>({ kind: "list" })
  const [busy, setBusy] = createSignal(false)
  const [flatRows, setFlatRows] = createSignal(FLAT_ROWS)
  const [openShelves, setOpenShelves] = createSignal<ReadonlySet<string>>(new Set())
  const storage = typeof localStorage === "undefined" ? undefined : localStorage
  const [preferences, setPreferences] = createStore({
    view: "all" as SkillView,
    feedback: "",
    changes: {} as Record<string, { enabled: boolean; version: number }>,
  })
  const initialPreferences = skillPreferences(storage)
  const [pinned, setPinned] = createSignal(initialPreferences.pinned)
  const [permissionPending, setPermissionPending] = createSignal<Record<string, number>>({})
  const permissionVersions = new Map<string, number>()
  let permissionWrites = Promise.resolve()
  let fileInput: HTMLInputElement | undefined

  // Selection never changes permission or re-enables a security-blocked skill.
  const catalog = createMemo(() =>
    skillCatalogSnapshot(
      (skills() ?? initialSkills).map((skill) => ({
        ...skill,
        enabled:
          skill.disabled_by === "project"
            ? false
            : (preferences.changes[skill.name]?.enabled ?? skill.enabled ?? !service.disabled().includes(skill.name)),
        permission_action: skill.permission_action ?? skillAction(service.permission(), skill.name),
      })),
      { pinned: pinned() },
    ),
  )
  const activeNames = createMemo(() => new Set(catalog().allowed.map((skill) => skill.name)))
  const enabled = (name: string) => activeNames().has(name)
  // When most active skills ask first, that is the permission mode, said
  // once in the summary; rows only mark the exceptions.
  const asksEverywhere = createMemo(() => {
    const allowed = catalog().allowed
    if (!allowed.length) return false
    const asking = allowed.filter((skill) => catalog().action(skill.name) === "ask").length
    return asking * 2 > allowed.length
  })

  function markPermissionPending(name: string, delta: number) {
    setPermissionPending((current) => {
      const next = { ...current }
      const count = (next[name] ?? 0) + delta
      if (count > 0) next[name] = count
      else delete next[name]
      return next
    })
  }

  function toggle(names: string[], next: boolean) {
    if (!names.length) return
    const versions = names.map((name) => {
      const version = (permissionVersions.get(name) ?? 0) + 1
      permissionVersions.set(name, version)
      setPreferences("changes", name, { enabled: next, version })
      markPermissionPending(name, 1)
      return [name, version] as const
    })
    setPreferences("feedback", "Saving selection…")

    const persist = async () => {
      try {
        await service.select(names, next)
        const changed = new Set(names)
        skillsCtl.mutate((current) =>
          (current ?? []).map((skill) =>
            changed.has(skill.name) && skill.disabled_by !== "project"
              ? { ...skill, enabled: next, disabled_by: next ? undefined : "server" }
              : skill,
          ),
        )
        setPreferences(
          "feedback",
          `${names.length === 1 ? "Skill" : `${names.length} skills`} ${next ? "activated" : "turned off"}.`,
        )
      } catch (error) {
        setPreferences("feedback", "Selection could not be saved. Your previous settings are unchanged.")
        showToast({ variant: "error", title: "Could not save skill selection", description: message(error) })
      } finally {
        for (const [name, version] of versions) {
          if (permissionVersions.get(name) === version) setPreferences("changes", name, undefined!)
          markPermissionPending(name, -1)
        }
      }
    }
    permissionWrites = permissionWrites.then(persist, persist)
  }

  const all = createMemo(() => catalog().library)
  const enabledCount = createMemo(() => catalog().allowed.length)
  const pinnedNames = createMemo(() => new Set(pinned()))
  const query = createMemo(() => search().trim().toLowerCase())

  const matches = (skill: Skill) => {
    const q = query()
    if (!q) return true
    return [skill.name, skill.description ?? "", skill.summary ?? "", skill.category ?? "", ...(skill.tags ?? [])].some(
      (value) => value.toLowerCase().includes(q),
    )
  }
  const filtered = createMemo(() =>
    selectedSkills(all(), { view: preferences.view, active: activeNames() })
      .filter(matches)
      .sort((a, b) => {
        const core = Number(coreSkill(b)) - Number(coreSkill(a))
        return core || (coreSkill(a) ? compareCore(a, b) : a.name.localeCompare(b.name))
      }),
  )

  // Sections carry the empty-search browse; a search or the Off view is a
  // flat list so every match is in view at once.
  const flat = createMemo(() => !!query() || preferences.view === "off")
  const core = createMemo(() => filtered().filter(coreSkill))
  const personal = createMemo(() => filtered().filter((skill) => !coreSkill(skill) && skillSource(skill) !== "default"))
  const shelves = createMemo(() => {
    const by = new Map<string, Skill[]>()
    for (const skill of filtered()) {
      if (coreSkill(skill) || skillSource(skill) !== "default") continue
      const category = skill.category ?? "other"
      if (!by.has(category)) by.set(category, [])
      by.get(category)!.push(skill)
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })
  const counts = createMemo(() => ({
    core: all().filter(coreSkill).length,
    library: all().filter((skill) => !coreSkill(skill) && skillSource(skill) === "default").length,
    personal: all().filter((skill) => skillSource(skill) !== "default").length,
    off: all().length - enabledCount(),
  }))
  const visibleFlat = createMemo(() => filtered().slice(0, flatRows()))

  const shelfOpen = (category: string) => openShelves().has(category)
  const toggleShelf = (category: string) =>
    setOpenShelves((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })

  createEffect(() => {
    all().length
    query()
    preferences.view
    setFlatRows(FLAT_ROWS)
  })

  onMount(() => {
    const updatePreferences = () => setPinned(skillPreferences(storage).pinned)
    globalThis.addEventListener(SKILL_PREFERENCES_EVENT, updatePreferences)
    onCleanup(() => globalThis.removeEventListener(SKILL_PREFERENCES_EVENT, updatePreferences))
  })

  const row = (skill: Skill, subject?: boolean) => (
    <SkillRow
      skill={skill}
      on={enabled(skill.name)}
      pinned={pinnedNames().has(skill.name)}
      saving={Boolean(permissionPending()[skill.name])}
      action={catalog().action(skill.name)}
      quietAsk={asksEverywhere()}
      disabled={skills.loading || !!skills.error}
      subject={subject && !coreSkill(skill) ? displayLabel(skill.category ?? "other") : undefined}
      onToggle={(value) => toggle([skill.name], value)}
      onPin={(value) => {
        setSkillPinned(skill.name, value, storage)
        setPinned(skillPreferences(storage).pinned)
      }}
      onEdit={skillSource(skill) === "user" ? () => setForm({ kind: "edit", name: skill.name }) : undefined}
      onDelete={skillSource(skill) === "user" ? () => void removeSkill(skill.name) : undefined}
    />
  )

  const activatable = (items: Skill[]) =>
    items
      .filter(
        (skill) =>
          !enabled(skill.name) &&
          skill.disabled_by !== "project" &&
          catalog().action(skill.name) !== "deny" &&
          skill.catalog_status !== "blocked",
      )
      .map((skill) => skill.name)
  const deactivatable = (items: Skill[]) => items.filter((skill) => enabled(skill.name)).map((skill) => skill.name)

  return (
    <div class="skills-workspace" data-layout={props.embedded ? "settings" : "workspace"}>
      <div class="skills-workspace__header">
        <div class="skills-workspace__heading">
          <div class="skills-workspace__heading-copy">
            <Show when={!props.embedded} fallback={<h2>Skills</h2>}>
              <h1>Skills</h1>
            </Show>
            <p>Playbooks the agent loads on demand. Core is always in the / menu; the library is one search away.</p>
          </div>
          <div class="skills-workspace__summary" aria-live="polite">
            <span>{enabledCount()} active</span>
            <span aria-hidden="true">·</span>
            <span>{all().length} in library</span>
            <Show when={asksEverywhere()}>
              <span aria-hidden="true">·</span>
              <span title="The agent asks before loading any skill. Change this under Permissions.">Ask first</span>
            </Show>
          </div>
        </div>

        <Show when={form().kind === "list"}>
          <div class="skills-workspace__toolbar">
            <div class="skills-workspace__views" role="group" aria-label="Skill library views">
              <For
                each={
                  [
                    { id: "all", label: "All", count: all().length },
                    { id: "core", label: "Core", count: counts().core },
                    { id: "library", label: "Library", count: counts().library },
                    { id: "personal", label: "Personal", count: counts().personal },
                    { id: "off", label: "Off", count: counts().off },
                  ] as const
                }
              >
                {(tab) => (
                  <button
                    type="button"
                    aria-pressed={preferences.view === tab.id}
                    onClick={() => setPreferences("view", tab.id)}
                  >
                    {tab.label}
                    <span>{tab.count}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="settings-toolbar skills-workspace__toolbar-controls">
              <SearchInput value={search()} onInput={setSearch} placeholder="Search skills" ariaLabel="Search skills" />
              <AddMenu
                label="Add skill"
                items={[
                  {
                    icon: "pencil-line",
                    label: "Write from scratch",
                    description: "Author a new SKILL.md in the editor",
                    onSelect: () => setForm({ kind: "scratch" }),
                  },
                  {
                    icon: "cloud-upload",
                    label: "Upload a skill",
                    description: "Import a SKILL.md file from disk",
                    onSelect: () => fileInput?.click(),
                  },
                  {
                    icon: "folder",
                    label: "Add a local folder",
                    description: "Register a directory of skills, no restart",
                    onSelect: () => setForm({ kind: "folder" }),
                  },
                  {
                    icon: "github",
                    label: "Import from GitHub",
                    description: "Install from a public git repo URL",
                    onSelect: () => setForm({ kind: "github" }),
                  },
                ]}
              />
            </div>
            <Show when={preferences.feedback}>
              <p class="skills-workspace__feedback" role="status">
                {preferences.feedback}
              </p>
            </Show>
          </div>
        </Show>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".md,text/markdown"
        class="hidden"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ""
          if (file) void uploadSkill(file)
        }}
      />

      <div class="atlas-scroll skills-workspace__body">
        <div class="skills-workspace__content">
          <Branch>
            <Match when={form().kind === "scratch"}>
              <ScratchForm
                busy={busy()}
                onCancel={() => setForm({ kind: "list" })}
                onCreate={async (name, description, body) => {
                  await save(name, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "created")
                }}
              />
            </Match>
            <Match when={form().kind === "edit" ? (form() as { name: string }).name : undefined}>
              {(name) => (
                <EditForm
                  name={name()}
                  busy={busy()}
                  load={() => service.read(name())}
                  onCancel={() => setForm({ kind: "list" })}
                  onSave={(content) => save(name(), content, "saved")}
                />
              )}
            </Match>
            <Match when={form().kind === "github"}>
              <GithubForm
                busy={busy()}
                onCancel={() => setForm({ kind: "list" })}
                onInstall={async (url) => {
                  setBusy(true)
                  try {
                    const res = await service.install(url)
                    refresh()
                    const n = res.installed.length
                    const r = res.rejected.length
                    showToast({
                      variant: n > 0 ? "success" : "error",
                      title: n > 0 ? `Installed ${n} skill${n === 1 ? "" : "s"}` : "No skills installed",
                      description: r > 0 ? `${r} rejected by security review` : undefined,
                    })
                    if (n > 0) setForm({ kind: "list" })
                  } catch (err) {
                    showToast({ variant: "error", title: "Install failed", description: message(err) })
                  } finally {
                    setBusy(false)
                  }
                }}
              />
            </Match>
            <Match when={form().kind === "folder"}>
              <FolderForm
                busy={busy()}
                onCancel={() => setForm({ kind: "list" })}
                onAdd={async (path, persist) => {
                  setBusy(true)
                  try {
                    const root = await service.addRoot(path, persist)
                    refresh()
                    showToast({
                      variant: "success",
                      title: `Added ${root.skills} skill${root.skills === 1 ? "" : "s"} from ${shortPath(root.path)}`,
                    })
                    setForm({ kind: "list" })
                  } catch (err) {
                    showToast({ variant: "error", title: "Could not add folder", description: message(err) })
                  } finally {
                    setBusy(false)
                  }
                }}
              />
            </Match>
            <Match when={form().kind === "list"}>
              <Show when={skills.error && all().length > 0}>
                <div class="skills-workspace__catalog-warning" role="alert">
                  <span>The saved catalog is shown. Reconnect before changing active skills.</span>
                  <button type="button" onClick={refresh}>
                    Retry
                  </button>
                </div>
              </Show>
              <Show
                when={!skills.loading || all().length > 0}
                fallback={<CatalogState icon="refresh" title="Loading skills" hint="Fetching the latest catalog…" />}
              >
                <Show
                  when={!skills.error || all().length > 0}
                  fallback={
                    <CatalogState
                      icon="alert-circle"
                      title="Skills could not be loaded"
                      hint={message(skills.error)}
                      action="Try again"
                      onAction={refresh}
                    />
                  }
                >
                  <Show
                    when={filtered().length > 0}
                    fallback={
                      <Show
                        when={!!query() || preferences.view !== "all"}
                        fallback={
                          <EmptyState
                            icon="brain"
                            title="No skills yet"
                            hint="Write one from scratch, upload a SKILL.md, add a local folder, or import from GitHub."
                          />
                        }
                      >
                        <CatalogState
                          icon="magnifying-glass"
                          title="No matching skills"
                          hint="Try another search or view."
                          action="Clear search"
                          onAction={() => {
                            setSearch("")
                            setPreferences("view", "all")
                          }}
                        />
                      </Show>
                    }
                  >
                    <Show
                      when={!flat()}
                      fallback={
                        <section class="skills-workspace__group" aria-label="Matching skills">
                          <ul class="skills-workspace__rows">
                            <For each={visibleFlat()}>{(skill) => row(skill, true)}</For>
                          </ul>
                          <Show when={flatRows() < filtered().length}>
                            <button
                              type="button"
                              class="skills-workspace__more"
                              onClick={() => setFlatRows((current) => current + FLAT_ROWS)}
                            >
                              Show more skills
                            </button>
                          </Show>
                        </section>
                      }
                    >
                      <div class="skills-workspace__list">
                        <Show when={core().length > 0}>
                          <section class="skills-workspace__group" aria-labelledby="skills-group-core">
                            <div class="skills-workspace__group-heading">
                              <h3 id="skills-group-core">Core</h3>
                              <p>The research toolkit, always in the / menu and the agent's index.</p>
                            </div>
                            <ul class="skills-workspace__rows">
                              <For each={core()}>{(skill) => row(skill)}</For>
                            </ul>
                          </section>
                        </Show>

                        <Show when={personal().length > 0}>
                          <section class="skills-workspace__group" aria-labelledby="skills-group-personal">
                            <div class="skills-workspace__group-heading">
                              <h3 id="skills-group-personal">Personal</h3>
                              <p>Skills you wrote, installed, or keep in this project.</p>
                            </div>
                            <ul class="skills-workspace__rows">
                              <For each={personal()}>{(skill) => row(skill)}</For>
                            </ul>
                          </section>
                        </Show>

                        <Show when={shelves().length > 0}>
                          <section class="skills-workspace__group" aria-labelledby="skills-group-library">
                            <div class="skills-workspace__group-heading">
                              <h3 id="skills-group-library">Library</h3>
                              <p>
                                By subject. The agent finds these by search or exact name; open a shelf to curate it.
                              </p>
                            </div>
                            <div class="skills-workspace__shelves">
                              <For each={shelves()}>
                                {([category, items]) => {
                                  const on = () => items.filter((skill) => enabled(skill.name)).length
                                  return (
                                    <section
                                      class="skills-workspace__shelf"
                                      data-open={shelfOpen(category) ? "true" : "false"}
                                      aria-label={displayLabel(category)}
                                    >
                                      <div class="skills-workspace__shelf-head">
                                        <button
                                          type="button"
                                          class="skills-workspace__shelf-toggle"
                                          aria-expanded={shelfOpen(category)}
                                          onClick={() => toggleShelf(category)}
                                        >
                                          <Icon name="chevron-right" size="small" />
                                          <span class="skills-workspace__skill-icon" aria-hidden="true">
                                            <Icon name={skillIconFor({ name: category, category })} size="small" />
                                          </span>
                                          <strong>{displayLabel(category)}</strong>
                                          <span>
                                            {items.length} skill{items.length === 1 ? "" : "s"}
                                            <Show when={on() < items.length}>{` · ${items.length - on()} off`}</Show>
                                          </span>
                                        </button>
                                        <div class="skills-workspace__shelf-actions">
                                          <Show
                                            when={on() < items.length}
                                            fallback={
                                              <button
                                                type="button"
                                                disabled={
                                                  !deactivatable(items).length || skills.loading || !!skills.error
                                                }
                                                onClick={() => toggle(deactivatable(items), false)}
                                              >
                                                Turn off all
                                              </button>
                                            }
                                          >
                                            <button
                                              type="button"
                                              disabled={!activatable(items).length || skills.loading || !!skills.error}
                                              onClick={() => toggle(activatable(items), true)}
                                            >
                                              Activate all
                                            </button>
                                          </Show>
                                        </div>
                                      </div>
                                      <Show when={shelfOpen(category)}>
                                        <ul class="skills-workspace__rows">
                                          <For each={items}>{(skill) => row(skill)}</For>
                                        </ul>
                                      </Show>
                                    </section>
                                  )
                                }}
                              </For>
                            </div>
                          </section>
                        </Show>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </Show>

              <Show when={!flat() && preferences.view === "all" && roots()}>
                {(sources) => (
                  <section
                    class="skills-workspace__group skills-workspace__sources"
                    aria-labelledby="skills-group-sources"
                  >
                    <div class="skills-workspace__group-heading">
                      <h3 id="skills-group-sources">Sources</h3>
                      <p>
                        Where the catalog comes from. A later source wins a name collision; the loser is listed here.
                      </p>
                    </div>
                    <ul class="skills-workspace__rows">
                      <For each={sources().roots}>
                        {(root) => (
                          <li class="skills-workspace__source" data-kind={root.kind}>
                            <span class="skills-workspace__skill-icon" aria-hidden="true">
                              <Icon name={root.kind === "bundled" ? "archive" : "folder"} size="small" />
                            </span>
                            <div class="skills-workspace__source-copy">
                              <strong>{ROOT_LABEL[root.kind]}</strong>
                              <code title={root.path}>{shortPath(root.path)}</code>
                            </div>
                            <span class="skills-workspace__source-count">
                              {root.skills} skill{root.skills === 1 ? "" : "s"}
                              <Show when={root.shadowed > 0}>{` · ${root.shadowed} shadowed`}</Show>
                            </span>
                            <Show when={root.kind === "runtime" || root.kind === "config"}>
                              <button
                                type="button"
                                class="skills-workspace__source-remove"
                                aria-label={`Remove ${root.path}`}
                                title="Remove this folder from the catalog"
                                onClick={() => void removeRoot(root)}
                              >
                                <Icon name="trash" size="small" />
                              </button>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show when={sources().shadowed.length > 0}>
                      <ul class="skills-workspace__shadowed" aria-label="Shadowed skills">
                        <For each={sources().shadowed}>
                          {(entry) => (
                            <li>
                              <code>/{entry.name}</code> at{" "}
                              <code title={entry.location}>{shortPath(entry.location)}</code> loses to{" "}
                              <code title={entry.by}>{shortPath(entry.by)}</code>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </section>
                )}
              </Show>
            </Match>
          </Branch>
        </div>
      </div>
    </div>
  )

  async function save(name: string, content: string, verb: "created" | "saved") {
    setBusy(true)
    try {
      await service.create(name, content)
      refresh()
      showToast({ variant: "success", title: `Skill "${name}" ${verb}` })
      setForm({ kind: "list" })
    } catch (err) {
      showToast({ variant: "error", title: `Could not save skill`, description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  async function removeSkill(name: string) {
    if (typeof confirm === "function" && !confirm(`Delete the skill "${name}"? This removes its SKILL.md.`)) return
    try {
      await service.remove(name)
      refresh()
      showToast({ variant: "success", title: `Skill "${name}" deleted` })
    } catch (err) {
      showToast({ variant: "error", title: "Could not delete skill", description: message(err) })
    }
  }

  async function removeRoot(root: SkillRoot) {
    try {
      await service.removeRoot(root.path, root.kind === "config" ? "global" : undefined)
      refresh()
      showToast({ variant: "success", title: `Removed ${shortPath(root.path)}` })
    } catch (err) {
      showToast({ variant: "error", title: "Could not remove folder", description: message(err) })
    }
  }

  async function uploadSkill(file: File) {
    setBusy(true)
    try {
      const content = await file.text()
      const name = frontmatterName(content)
      if (!name) {
        throw new Error("The SKILL.md must start with a frontmatter block containing `name:` and `description:`.")
      }
      await service.create(name, content)
      refresh()
      showToast({ variant: "success", title: `Skill "${name}" uploaded` })
    } catch (err) {
      showToast({ variant: "error", title: "Upload failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }
}

function SkillRow(props: {
  skill: Skill
  on: boolean
  pinned: boolean
  saving: boolean
  action: "allow" | "ask" | "deny"
  quietAsk?: boolean
  disabled: boolean
  subject?: string
  onToggle: (v: boolean) => void
  onPin: (v: boolean) => void
  onEdit?: () => void
  onDelete?: () => void
}): JSX.Element {
  const source = () => skillSource(props.skill)
  const blocked = () => props.skill.catalog_status === "blocked" || props.action === "deny"
  const state = () => {
    if (props.skill.disabled_by === "project") return "Off in this project"
    if (blocked()) return "Blocked by policy"
    if (props.on && props.action === "ask" && !props.quietAsk) return "Ask first"
    return undefined
  }
  return (
    <li
      class="skills-workspace__row"
      data-enabled={props.on ? "true" : "false"}
      data-source={source()}
      data-saving={props.saving ? "true" : undefined}
      aria-busy={props.saving ? "true" : undefined}
    >
      <span class="skills-workspace__skill-icon" aria-hidden="true">
        <Icon name={skillIconFor(props.skill)} size="small" />
      </span>
      <div class="skills-workspace__identity">
        <strong title={props.skill.name}>{displayLabel(props.skill.name)}</strong>
        <span>
          <code>/{props.skill.name}</code>
          <Show when={source() !== "default"}>
            <span aria-hidden="true">·</span>
            {SOURCE_LABEL[source()]}
          </Show>
          <Show when={props.subject}>
            <span aria-hidden="true">·</span>
            {props.subject}
          </Show>
        </span>
      </div>
      <div class="skills-workspace__details" title={props.skill.description}>
        {blurb(props.skill) || "No description provided."}
      </div>
      <Show when={state()}>
        {(value) => (
          <span
            class="skills-workspace__state"
            data-state={blocked() || props.skill.disabled_by === "project" ? "blocked" : "ask"}
            title={
              props.action === "ask"
                ? "The agent asks before loading this skill."
                : props.action === "deny"
                  ? "Disabled by a permission rule. Selection does not override policy."
                  : undefined
            }
          >
            {value()}
          </span>
        )}
      </Show>
      <div class="skills-workspace__actions">
        <Show when={props.onEdit}>
          <button type="button" aria-label={`Edit ${props.skill.name}`} title="Edit" onClick={props.onEdit}>
            <Icon name="pencil-line" size="small" />
          </button>
        </Show>
        <Show when={props.onDelete}>
          <button type="button" aria-label={`Delete ${props.skill.name}`} title="Delete" onClick={props.onDelete}>
            <Icon name="trash" size="small" />
          </button>
        </Show>
        <button
          type="button"
          class="skills-workspace__pin"
          data-pinned={props.pinned ? "true" : "false"}
          aria-pressed={props.pinned}
          aria-label={`${props.pinned ? "Unpin" : "Pin"} ${props.skill.name}`}
          title={props.pinned ? "Unpin from the / menu" : "Pin near the top of the / menu"}
          onClick={() => props.onPin(!props.pinned)}
        >
          <Icon name={props.pinned ? "pin-filled" : "pin"} size="small" />
        </button>
        <Switch
          data-action="skill-toggle"
          checked={props.on}
          onChange={props.onToggle}
          disabled={props.disabled || blocked() || props.skill.disabled_by === "project"}
          hideLabel
        >
          {props.on ? `Turn off ${props.skill.name}` : `Activate ${props.skill.name}`}
        </Switch>
      </div>
    </li>
  )
}

function FormShell(props: {
  icon: "pencil-line" | "github" | "folder"
  title: string
  hint: string
  children: JSX.Element
}) {
  return (
    <div class="skills-workspace__form">
      <div class="skills-workspace__form-heading">
        <div class="skills-workspace__form-icon" aria-hidden="true">
          <Icon name={props.icon} size="small" />
        </div>
        <div>
          <h3>{props.title}</h3>
          <p>{props.hint}</p>
        </div>
      </div>
      <div class="skills-workspace__form-fields">{props.children}</div>
    </div>
  )
}

function ScratchForm(props: {
  busy: boolean
  onCancel: () => void
  onCreate: (name: string, description: string, body: string) => void
}): JSX.Element {
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [body, setBody] = createSignal("")
  const valid = () => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name().trim()) && description().trim().length > 0
  return (
    <FormShell
      icon="pencil-line"
      title="Write a new skill"
      hint="A focused playbook the agent loads when it is relevant."
    >
      <FormField label="Name" value={name()} onInput={setName} placeholder="my-skill (letters, digits, - and _)" />
      <FormField
        label="Description"
        value={description()}
        onInput={setDescription}
        placeholder="When should the agent load this skill?"
      />
      <FormField
        label="Instructions (Markdown)"
        value={body()}
        onInput={setBody}
        multiline
        mono
        placeholder="Step-by-step guidance, code examples, pitfalls…"
      />
      <div class="skills-workspace__form-actions">
        <FormButton
          label={props.busy ? "Creating…" : "Create skill"}
          disabled={props.busy || !valid()}
          onClick={() => props.onCreate(name().trim(), description().trim(), body())}
        />
        <FormButton label="Cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
      </div>
    </FormShell>
  )
}

function EditForm(props: {
  name: string
  busy: boolean
  load: () => Promise<string>
  onCancel: () => void
  onSave: (content: string) => void
}): JSX.Element {
  const [content] = createResource(() => props.load())
  const [draft, setDraft] = createSignal<string>()
  const text = () => draft() ?? content() ?? ""
  return (
    <FormShell icon="pencil-line" title={`Edit /${props.name}`} hint="The whole SKILL.md, frontmatter included.">
      <Show when={!content.loading} fallback={<p class="skills-workspace__form-note">Loading…</p>}>
        <Show when={!content.error} fallback={<p class="skills-workspace__form-note">{message(content.error)}</p>}>
          <FormField label="SKILL.md" value={text()} onInput={setDraft} multiline mono />
        </Show>
      </Show>
      <div class="skills-workspace__form-actions">
        <FormButton
          label={props.busy ? "Saving…" : "Save skill"}
          disabled={props.busy || content.loading || !!content.error || !text().trim()}
          onClick={() => props.onSave(text())}
        />
        <FormButton label="Cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
      </div>
    </FormShell>
  )
}

function GithubForm(props: { busy: boolean; onCancel: () => void; onInstall: (url: string) => void }): JSX.Element {
  const [url, setUrl] = createSignal("")
  return (
    <FormShell icon="github" title="Import from GitHub" hint="Install one or more skills from a public repository.">
      <FormField label="Repository URL" value={url()} onInput={setUrl} placeholder="https://github.com/owner/repo" />
      <p class="skills-workspace__form-note">
        <Icon name="shield" size="small" />
        Skills are fetched, screened by a multi-layer security review, and only installed if they pass.
      </p>
      <div class="skills-workspace__form-actions">
        <FormButton
          label={props.busy ? "Installing…" : "Install"}
          disabled={props.busy || !url().trim()}
          onClick={() => props.onInstall(url().trim())}
        />
        <FormButton label="Cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
      </div>
    </FormShell>
  )
}

function FolderForm(props: {
  busy: boolean
  onCancel: () => void
  onAdd: (path: string, persist?: "global" | "project") => void
}): JSX.Element {
  const [path, setPath] = createSignal("")
  const [persist, setPersist] = createSignal<"session" | "global" | "project">("global")
  return (
    <FormShell
      icon="folder"
      title="Add a local folder"
      hint="A directory of <name>/SKILL.md folders, nested however you like. Its skills join the catalog at once."
    >
      <FormField
        label="Folder path"
        value={path()}
        onInput={setPath}
        placeholder="/data/team-skills or ~/skills"
        mono
      />
      <label class="skills-workspace__form-choice">
        <span>Keep it</span>
        <select
          aria-label="How long to keep this folder"
          value={persist()}
          onChange={(event) => setPersist(event.currentTarget.value as "session" | "global" | "project")}
        >
          <option value="global">Always (saved to your config)</option>
          <option value="project">For this project (saved to the project config)</option>
          <option value="session">Until the server restarts</option>
        </select>
      </label>
      <p class="skills-workspace__form-note">
        <Icon name="shield" size="small" />A same-named skill in this folder wins over the bundled and personal copies.
      </p>
      <div class="skills-workspace__form-actions">
        <FormButton
          label={props.busy ? "Adding…" : "Add folder"}
          disabled={props.busy || !path().trim()}
          onClick={() => {
            const scope = persist()
            props.onAdd(path().trim(), scope === "session" ? undefined : scope)
          }}
        />
        <FormButton label="Cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
      </div>
    </FormShell>
  )
}

function CatalogState(props: {
  icon: "refresh" | "alert-circle" | "magnifying-glass"
  title: string
  hint: string
  action?: string
  onAction?: () => void
}): JSX.Element {
  return (
    <div class="skills-workspace__empty" role={props.icon === "alert-circle" ? "alert" : "status"}>
      <div class="settings-empty-state__icon skills-workspace__empty-icon" aria-hidden="true">
        <Icon name={props.icon} size="normal" />
      </div>
      <strong>{props.title}</strong>
      <p>{props.hint}</p>
      <Show when={props.action && props.onAction}>
        <button type="button" class="settings-button" data-variant="ghost" onClick={props.onAction}>
          {props.action}
        </button>
      </Show>
    </div>
  )
}

export function shortPath(value: string) {
  const home = typeof value === "string" && value.match(/^\/(?:Users|home)\/[^/]+/)
  const short = home ? `~${value.slice(home[0].length)}` : value
  return short.length > 60 ? `…${short.slice(-58)}` : short
}

function frontmatterName(content: string): string | undefined {
  const match = content.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/)
  if (!match) return undefined
  const line = match[1].split(/\r?\n/).find((l) => /^name\s*:/.test(l))
  return line
    ?.split(":")
    .slice(1)
    .join(":")
    .trim()
    .replace(/^["']|["']$/g, "")
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
