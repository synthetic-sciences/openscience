// Skills — the reusable catalog of expert playbooks agents load on demand.
// Data + selection + add flows use the real app.skills / app.skill.write /
// skills.disabled APIs. The embedded presentation fits the Settings frame
// while preserving a useful catalog heading and clear controls.
import {
  For,
  Show,
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
import { SearchInput, FilterMenu, AddMenu, EmptyState, FormField, FormButton } from "@/components/settings/_shared"
import { skillIconFor } from "./skill-icon"
import { selectedSkills, skillCatalogKey, skillDensity, skillSelection, type SkillView } from "./skill-selection"

export { skillIconFor } from "./skill-icon"

export interface Skill {
  name: string
  description?: string
  location: string
  origin?: Source
  category?: string
  tags?: string[]
  entry?: boolean
  permission_action?: "allow" | "ask" | "deny"
  recommended?: boolean
  enabled?: boolean
  disabled_by?: "server" | "project"
  catalog_status?: string
}

const INITIAL_SKILL_ROWS = 56
const SKILL_ROW_BATCH = 56
const memorySkillCache = new Map<string, Skill[]>()
const skillCatalogRequests = new Map<string, Promise<Skill[]>>()

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

type View = "list" | "scratch" | "github"
type Source = "default" | "installed" | "user" | "project"
type SourceView = "all" | Source

function sourceOf(skill: Skill): Source {
  if (skill.origin) return skill.origin
  const location = skill.location.toLowerCase()
  if (location.includes("installed-skills") || location.includes(".claude/skills")) return "installed"
  if (location.includes("user-skills")) return "user"
  if (location.includes(".openscience/")) return "project"
  return "default"
}

function displayLabel(value: string) {
  const words = value.replace(/[-_]+/g, " ").trim()
  const label = /[A-Z]/.test(words) && words === words.toUpperCase() ? words.toLowerCase() : words
  return label ? label[0]!.toUpperCase() + label.slice(1) : value
}

const SOURCE_LABEL: Record<Source, string> = {
  default: "Default",
  installed: "Installed",
  user: "Personal",
  project: "Project",
}

export type SkillsPageServices = {
  server: string
  load: () => Promise<Skill[]>
  disabled: () => readonly string[]
  permission: () => unknown
  select: (names: string[], enabled: boolean) => Promise<readonly string[]>
  create: (name: string, content: string) => Promise<unknown>
  install: (url: string) => Promise<{ installed: unknown[]; rejected: unknown[] }>
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
            | SelectionConfig
            | undefined
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
        install: (url: string) => installFromGit(platform.fetch ?? fetch, sdk.url, url),
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
  if (service.watch)
    onCleanup(
      service.watch(() => {
        skillCatalogRequests.delete(cacheKey)
        void skillsCtl.refetch()
      }),
    )

  const [search, setSearch] = createSignal("")
  const [category, setCategory] = createSignal("all")
  const [source, setSource] = createSignal<SourceView>("all")
  const [view, setView] = createSignal<View>("list")
  const [busy, setBusy] = createSignal(false)
  const [visibleRows, setVisibleRows] = createSignal(INITIAL_SKILL_ROWS)
  const storage = typeof localStorage === "undefined" ? undefined : localStorage
  const [preferences, setPreferences] = createStore({
    view: "all" as SkillView,
    density: skillDensity(storage),
    customize: false,
    feedback: "",
    changes: {} as Record<string, { enabled: boolean; version: number }>,
  })
  const initialPreferences = skillPreferences(storage)
  const [pinned, setPinned] = createSignal(initialPreferences.pinned)
  const [recent, setRecent] = createSignal(initialPreferences.recent)
  const [permissionPending, setPermissionPending] = createSignal<Record<string, number>>({})
  const permissionVersions = new Map<string, number>()
  let permissionWrites = Promise.resolve()
  let workspaceElement: HTMLDivElement | undefined
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
      {
        pinned: pinned(),
        recent: recent(),
      },
    ),
  )
  const activeNames = createMemo(() => new Set(catalog().allowed.map((skill) => skill.name)))
  const enabled = (name: string) => activeNames().has(name)

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
              ? {
                  ...skill,
                  enabled: next,
                  disabled_by: next ? undefined : "server",
                }
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
  const recentNames = createMemo(() => new Set(catalog().recent.map((skill) => skill.name)))

  const categories = createMemo(() => {
    const counts = new Map<string, number>()
    for (const s of all()) {
      const cat = s.category ?? "uncategorized"
      counts.set(cat, (counts.get(cat) ?? 0) + 1)
    }
    return [
      { id: "all", label: "All categories", count: all().length },
      ...[...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, count]) => ({ id, label: displayLabel(id), count })),
    ]
  })

  const sources = createMemo(() => {
    const count = (value: Source) => all().filter((skill) => sourceOf(skill) === value).length
    return [
      { id: "all", label: "All sources", count: all().length },
      { id: "default", label: "Default", count: count("default") },
      { id: "installed", label: "Installed", count: count("installed") },
      { id: "user", label: "Personal", count: count("user") },
      { id: "project", label: "Project", count: count("project") },
    ]
  })

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase()
    const cat = category()
    const origin = source()
    return selectedSkills(all(), { view: preferences.view, pinned: pinnedNames(), active: activeNames() })
      .filter((skill) => origin === "all" || sourceOf(skill) === origin)
      .filter((s) => cat === "all" || (s.category ?? "uncategorized") === cat)
      .filter(
        (s) => !q || [s.name, s.description ?? "", ...(s.tags ?? [])].some((value) => value.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  // Group the filtered set into category shelves, sorted by name.
  const shelves = createMemo(() => {
    const by = new Map<string, Skill[]>()
    for (const s of filtered()) {
      const cat = s.category ?? "uncategorized"
      if (!by.has(cat)) by.set(cat, [])
      by.get(cat)!.push(s)
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })

  // The complete catalog can contain hundreds of skills. Keep first paint and
  // hidden-panel cost bounded, then reveal more as the user approaches the end.
  const visibleShelves = createMemo(() => {
    let remaining = visibleRows()
    const result: Array<[string, Skill[]]> = []
    for (const [name, items] of shelves()) {
      if (remaining <= 0) break
      const visible = items.slice(0, remaining)
      if (visible.length) result.push([name, visible])
      remaining -= visible.length
    }
    return result
  })
  const hasMoreRows = createMemo(() => visibleRows() < filtered().length)

  const visibleSummary = createMemo(() => {
    if (filtered().length === all().length) return `${all().length} available`
    return `${filtered().length} of ${all().length} shown`
  })
  const filtersActive = createMemo(
    () => !!search().trim() || category() !== "all" || source() !== "all" || preferences.view !== "all",
  )
  const activatable = createMemo(() =>
    filtered()
      .filter(
        (skill) =>
          !enabled(skill.name) &&
          skill.disabled_by !== "project" &&
          catalog().action(skill.name) !== "deny" &&
          skill.catalog_status !== "blocked",
      )
      .map((skill) => skill.name),
  )
  const deactivatable = createMemo(() =>
    filtered()
      .filter((skill) => enabled(skill.name))
      .map((skill) => skill.name),
  )

  function clearFilters() {
    setSearch("")
    setCategory("all")
    setSource("all")
    setPreferences("view", "all")
    setVisibleRows(INITIAL_SKILL_ROWS)
  }

  createEffect(() => {
    all().length
    setVisibleRows(INITIAL_SKILL_ROWS)
  })

  onMount(() => {
    const updatePreferences = () => {
      const next = skillPreferences(storage)
      setPinned(next.pinned)
      setRecent(next.recent)
    }
    globalThis.addEventListener(SKILL_PREFERENCES_EVENT, updatePreferences)
    onCleanup(() => globalThis.removeEventListener(SKILL_PREFERENCES_EVENT, updatePreferences))

    const panel = workspaceElement?.closest<HTMLElement>("[data-settings-panel]")
    if (!panel) return
    const observer = new MutationObserver(() => {
      if (panel.hidden) setVisibleRows(INITIAL_SKILL_ROWS)
    })
    observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] })
    onCleanup(() => observer.disconnect())
  })

  function loadMoreRows() {
    setVisibleRows((current) => Math.min(filtered().length, current + SKILL_ROW_BATCH))
  }

  function handleCatalogScroll(event: Event) {
    if (!hasMoreRows()) return
    const target = event.currentTarget as HTMLElement
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 480) loadMoreRows()
  }

  return (
    <div
      ref={workspaceElement}
      class="skills-workspace"
      data-layout={props.embedded ? "settings" : "workspace"}
      data-density={preferences.density}
    >
      <div class="skills-workspace__header">
        <div class="skills-workspace__heading">
          <div class="skills-workspace__heading-copy">
            <Show
              when={!props.embedded}
              fallback={
                <>
                  <h2>Skills</h2>
                  <p>Your research toolkit. Choose what agents can load when it is useful.</p>
                </>
              }
            >
              <>
                <h1>Skills</h1>
                <p>Your research toolkit. Choose what agents can load when it is useful.</p>
              </>
            </Show>
          </div>
          <div class="skills-workspace__summary" aria-live="polite">
            <span>{enabledCount()} active</span>
            <span aria-hidden="true">/</span>
            <span>{all().length} in library</span>
          </div>
        </div>

        <Show when={view() === "list"}>
          <div class="skills-workspace__toolbar">
            <div class="skills-workspace__views" role="group" aria-label="Skill library views">
              <For
                each={
                  [
                    { id: "all", label: "All skills", count: all().length },
                    { id: "active", label: "Active", count: enabledCount() },
                    {
                      id: "pinned",
                      label: "Pinned",
                      count: all().filter((skill) => pinnedNames().has(skill.name)).length,
                    },
                    { id: "off", label: "Off", count: all().length - enabledCount() },
                  ] as const
                }
              >
                {(tab) => (
                  <button
                    type="button"
                    aria-pressed={preferences.view === tab.id}
                    onClick={() => {
                      setPreferences("view", tab.id)
                      setVisibleRows(INITIAL_SKILL_ROWS)
                    }}
                  >
                    {tab.label}
                    <span>{tab.count}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="settings-toolbar skills-workspace__toolbar-controls">
              <SearchInput
                value={search()}
                onInput={(value) => {
                  setSearch(value)
                  setVisibleRows(INITIAL_SKILL_ROWS)
                }}
                placeholder="Search skills"
                ariaLabel="Search skills"
              />
              <button
                type="button"
                class="settings-control"
                aria-expanded={preferences.customize}
                onClick={() => setPreferences("customize", !preferences.customize)}
              >
                <Icon name="settings-gear" size="small" /> Filters & view
              </button>
              <AddMenu
                label="Add skill"
                items={[
                  {
                    icon: "pencil-line",
                    label: "Write from scratch",
                    description: "Author a new SKILL.md in the editor",
                    onSelect: () => setView("scratch"),
                  },
                  {
                    icon: "cloud-upload",
                    label: "Upload a skill",
                    description: "Import a SKILL.md file from disk",
                    onSelect: () => fileInput?.click(),
                  },
                  {
                    icon: "github",
                    label: "Import from GitHub",
                    description: "Install from a public git repo URL",
                    onSelect: () => setView("github"),
                  },
                ]}
              />
            </div>
            <Show when={preferences.customize}>
              <div class="skills-workspace__customize">
                <FilterMenu
                  options={sources()}
                  value={source()}
                  onSelect={(value) => {
                    setSource(value as SourceView)
                    setVisibleRows(INITIAL_SKILL_ROWS)
                  }}
                  ariaLabel="Filter skills by source"
                />
                <FilterMenu
                  options={categories()}
                  value={category()}
                  onSelect={(value) => {
                    setCategory(value)
                    setVisibleRows(INITIAL_SKILL_ROWS)
                  }}
                  ariaLabel="Filter skills by category"
                />
                <label class="skills-workspace__density">
                  Rows
                  <select
                    aria-label="Skill row density"
                    value={preferences.density}
                    onChange={(event) => {
                      const density = event.currentTarget.value === "compact" ? "compact" : "comfortable"
                      setPreferences("density", density)
                      try {
                        storage?.setItem("openscience.skills.density.v1", density)
                      } catch {
                        /* This view still works without browser storage. */
                      }
                    }}
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                </label>
                <div class="skills-workspace__bulk">
                  <span>{visibleSummary()}</span>
                  <button
                    type="button"
                    disabled={!activatable().length || skills.loading || !!skills.error}
                    onClick={() => toggle(activatable(), true)}
                  >
                    Activate {activatable().length} shown
                  </button>
                  <button
                    type="button"
                    disabled={!deactivatable().length || skills.loading || !!skills.error}
                    onClick={() => toggle(deactivatable(), false)}
                  >
                    Turn off {deactivatable().length} shown
                  </button>
                  <button type="button" onClick={clearFilters}>
                    Reset filters
                  </button>
                </div>
              </div>
            </Show>
            <p class="skills-workspace__scope">
              Active means available on demand, not loaded into every chat. Selection applies to this OpenScience
              server; project permissions still apply. Pin skills for quicker access in the / menu.
            </p>
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

      <div class="atlas-scroll skills-workspace__body" onScroll={handleCatalogScroll}>
        <div class="skills-workspace__content">
          <Show when={view() === "scratch"}>
            <ScratchForm
              busy={busy()}
              onCancel={() => setView("list")}
              onCreate={async (name, description, body) => {
                setBusy(true)
                try {
                  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
                  await service.create(name, content)
                  await skillsCtl.refetch()
                  showToast({ variant: "success", title: `Skill "${name}" created` })
                  setView("list")
                } catch (err) {
                  showToast({ variant: "error", title: "Could not create skill", description: message(err) })
                } finally {
                  setBusy(false)
                }
              }}
            />
          </Show>

          <Show when={view() === "github"}>
            <GithubForm
              busy={busy()}
              onCancel={() => setView("list")}
              onInstall={async (url) => {
                setBusy(true)
                try {
                  const res = await service.install(url)
                  await skillsCtl.refetch()
                  const n = res.installed.length
                  const r = res.rejected.length
                  showToast({
                    variant: n > 0 ? "success" : "error",
                    title: n > 0 ? `Installed ${n} skill${n === 1 ? "" : "s"}` : "No skills installed",
                    description: r > 0 ? `${r} rejected by security review` : undefined,
                  })
                  if (n > 0) setView("list")
                } catch (err) {
                  showToast({ variant: "error", title: "Install failed", description: message(err) })
                } finally {
                  setBusy(false)
                }
              }}
            />
          </Show>

          <Show when={view() === "list"}>
            <Show when={skills.error && all().length > 0}>
              <div class="skills-workspace__catalog-warning" role="alert">
                <span>The saved catalog is shown. Reconnect before changing active skills.</span>
                <button type="button" onClick={() => void skillsCtl.refetch()}>
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
                    onAction={() => void skillsCtl.refetch()}
                  />
                }
              >
                <Show
                  when={filtered().length > 0}
                  fallback={
                    <Show
                      when={filtersActive()}
                      fallback={
                        <EmptyState
                          icon="brain"
                          title="No skills yet"
                          hint="Write one from scratch, upload a SKILL.md, or import from a public GitHub repository."
                        />
                      }
                    >
                      <CatalogState
                        icon="magnifying-glass"
                        title="No matching skills"
                        hint="Try a different search, source, or category."
                        action="Clear filters"
                        onAction={clearFilters}
                      />
                    </Show>
                  }
                >
                  <div class="skills-workspace__list">
                    <For each={visibleShelves()}>
                      {([cat, items], index) => (
                        <section class="skills-workspace__group" aria-labelledby={`skills-group-${index()}`}>
                          <div class="skills-workspace__group-heading">
                            <h3 id={`skills-group-${index()}`}>{displayLabel(cat)}</h3>
                            <span>{items.length}</span>
                          </div>
                          <ul class="skills-workspace__rows">
                            <For each={items}>
                              {(skill) => (
                                <SkillRow
                                  skill={skill}
                                  on={enabled(skill.name)}
                                  pinned={pinnedNames().has(skill.name)}
                                  recent={recentNames().has(skill.name)}
                                  saving={Boolean(permissionPending()[skill.name])}
                                  action={catalog().action(skill.name)}
                                  disabled={skills.loading || !!skills.error}
                                  onToggle={(v) => toggle([skill.name], v)}
                                  onPin={(value) => {
                                    setSkillPinned(skill.name, value, storage)
                                    setPinned(skillPreferences(storage).pinned)
                                  }}
                                />
                              )}
                            </For>
                          </ul>
                        </section>
                      )}
                    </For>
                    <Show when={hasMoreRows()}>
                      <button type="button" class="skills-workspace__more" onClick={loadMoreRows}>
                        Show more skills
                      </button>
                    </Show>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )

  async function uploadSkill(file: File) {
    setBusy(true)
    try {
      const content = await file.text()
      const name = frontmatterName(content) ?? file.name.replace(/\.md$/i, "")
      if (!frontmatterName(content)) {
        throw new Error("The SKILL.md must start with a frontmatter block containing `name:` and `description:`.")
      }
      await service.create(name, content)
      await skillsCtl.refetch()
      showToast({ variant: "success", title: `Skill "${name}" uploaded` })
    } catch (err) {
      showToast({ variant: "error", title: "Upload failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }
}

export function SkillStateBadges(props: {
  allowed: boolean
  pinned?: boolean
  recent?: boolean
  recommended?: boolean
  loaded?: boolean
  action?: "allow" | "ask" | "deny"
  blocked?: boolean
  projectDisabled?: boolean
}): JSX.Element {
  return (
    <div class="skills-workspace__tags" aria-label="Skill states">
      <span
        class="settings-chip"
        data-state={props.allowed ? "allowed" : "library"}
        title={
          props.action === "ask"
            ? "The agent requests permission before loading this skill."
            : props.action === "deny"
              ? "Disabled by a permission rule. Selection does not override policy."
              : undefined
        }
      >
        {props.projectDisabled
          ? "Off in this project"
          : props.blocked || props.action === "deny"
            ? "Blocked by policy"
            : props.allowed
              ? props.action === "ask"
                ? "Ask first"
                : "Active"
              : "Off"}
      </span>
      <Show when={props.loaded}>
        <span class="settings-chip" data-state="loaded">
          Loaded this turn
        </span>
      </Show>
      <Show when={props.pinned}>
        <span class="settings-chip" data-state="pinned">
          Pinned
        </span>
      </Show>
      <Show when={!props.pinned && props.recent}>
        <span class="settings-chip" data-state="recent">
          Recent
        </span>
      </Show>
      <Show when={!props.pinned && !props.recent && props.recommended}>
        <span class="settings-chip" data-state="recommended">
          Recommended
        </span>
      </Show>
    </div>
  )
}

function SkillRow(props: {
  skill: Skill
  on: boolean
  pinned: boolean
  recent: boolean
  saving: boolean
  action: "allow" | "ask" | "deny"
  disabled: boolean
  onToggle: (v: boolean) => void
  onPin: (v: boolean) => void
}): JSX.Element {
  const source = () => sourceOf(props.skill)
  return (
    <li
      class="skills-workspace__row"
      data-enabled={props.on ? "true" : "false"}
      data-source={source()}
      data-saving={props.saving ? "true" : undefined}
      aria-busy={props.saving ? "true" : undefined}
    >
      <div class="skills-workspace__identity">
        <span class="skills-workspace__skill-icon" aria-hidden="true">
          <Icon name={skillIconFor(props.skill)} size="small" />
        </span>
        <div class="skills-workspace__identity-copy">
          <strong title={props.skill.name}>{displayLabel(props.skill.name)}</strong>
          <span>
            <code>/{props.skill.name}</code>
            <span aria-hidden="true">·</span>
            {SOURCE_LABEL[source()]}
          </span>
        </div>
      </div>

      <div class="skills-workspace__details">
        <p title={props.skill.description} data-empty={!props.skill.description}>
          {props.skill.description || "No description provided."}
        </p>
        <div class="skills-workspace__badges">
          <SkillStateBadges
            allowed={props.on}
            pinned={props.pinned}
            recent={props.recent}
            recommended={props.skill.recommended}
            action={props.action}
            blocked={props.skill.catalog_status === "blocked"}
            projectDisabled={props.skill.disabled_by === "project"}
          />
          <Show when={(props.skill.tags ?? []).length > 0}>
            <div class="skills-workspace__tags" aria-label="Skill tags">
              <For each={(props.skill.tags ?? []).slice(0, 2)}>
                {(tag) => <span class="settings-chip">{displayLabel(tag)}</span>}
              </For>
            </div>
          </Show>
        </div>
      </div>
      <div class="skills-workspace__toggle">
        <button
          type="button"
          class="skills-workspace__pin"
          data-pinned={props.pinned ? "true" : "false"}
          aria-pressed={props.pinned}
          aria-label={`${props.pinned ? "Unpin" : "Pin"} ${props.skill.name}`}
          title={`${props.pinned ? "Unpin" : "Pin"} from the / menu`}
          onClick={() => props.onPin(!props.pinned)}
        >
          <Icon name={props.pinned ? "pin-filled" : "pin"} size="small" />
        </button>
        <Switch
          data-action="skill-toggle"
          checked={props.on}
          onChange={props.onToggle}
          disabled={
            props.disabled ||
            props.action === "deny" ||
            props.skill.catalog_status === "blocked" ||
            props.skill.disabled_by === "project"
          }
          hideLabel
        >
          {props.on ? `Turn off ${props.skill.name}` : `Activate ${props.skill.name}`}
        </Switch>
      </div>
    </li>
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
    <div class="skills-workspace__form">
      <div class="skills-workspace__form-heading">
        <div class="skills-workspace__form-icon" aria-hidden="true">
          <Icon name="pencil-line" size="small" />
        </div>
        <div>
          <h3>Write a new skill</h3>
          <p>Create a focused playbook that agents can load when it is relevant.</p>
        </div>
      </div>
      <div class="skills-workspace__form-fields">
        <FormField label="Name" value={name()} onInput={setName} placeholder="my-skill (letters, digits, - and _)" />
        <FormField
          label="Description"
          value={description()}
          onInput={setDescription}
          placeholder="When should an agent load this skill?"
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
      </div>
    </div>
  )
}

function GithubForm(props: { busy: boolean; onCancel: () => void; onInstall: (url: string) => void }): JSX.Element {
  const [url, setUrl] = createSignal("")
  return (
    <div class="skills-workspace__form">
      <div class="skills-workspace__form-heading">
        <div class="skills-workspace__form-icon" aria-hidden="true">
          <Icon name="github" size="small" />
        </div>
        <div>
          <h3>Import from GitHub</h3>
          <p>Install one or more skills from a public repository.</p>
        </div>
      </div>
      <div class="skills-workspace__form-fields">
        <FormField label="Repository URL" value={url()} onInput={setUrl} placeholder="https://github.com/owner/repo" />
        <p class="skills-workspace__security-note">
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
      </div>
    </div>
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
    <div class="skills-workspace__state" role={props.icon === "alert-circle" ? "alert" : "status"}>
      <div class="settings-empty-state__icon skills-workspace__state-icon" aria-hidden="true">
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
