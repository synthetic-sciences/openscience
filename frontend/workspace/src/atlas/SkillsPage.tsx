// Skills — the dedicated, full-pane catalog of expert playbooks agents load on
// demand. Promoted out of the settings dialog into its own center-pane tab so
// it reads as a first-class surface. Data + enable/disable + add flows are the
// same real endpoints the old settings panel used (app.skills / app.skill.write
// / permission.skill), presented as a browsable, category-shelved library.
import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { currentDirectory } from "@/utils/base64"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useGlobalSync } from "@/context/global-sync"
import { FONT_SANS } from "@/styles/tokens"
import type { Config } from "@synsci/sdk/v2/client"
import {
  SearchInput,
  FilterMenu,
  AddMenu,
  Toolbar,
  EmptyState,
  FormField,
  FormButton,
} from "@/components/settings/_shared"

interface Skill {
  name: string
  description?: string
  location: string
  category?: string
  tags?: string[]
  entry?: boolean
}

type Action = "allow" | "deny"
type View = "list" | "scratch" | "github"
type Source = "bundled" | "learned" | "installed"

// The catalog draws from three origins; the badge is a real taxonomy, not
// decoration. Derived from the skill's on-disk location (learned skills live in
// a learned-skills store; bundled ship with the binary under …/skills).
function sourceOf(location: string): Source {
  const l = (location ?? "").toLowerCase()
  if (l.includes("learned")) return "learned"
  if (l.includes("backend/cli/skills") || l.includes("resources/skills") || l.includes("/app/skills")) return "bundled"
  return "installed"
}

const SOURCE_DOT: Record<Source, string> = {
  bundled: "var(--color-text-faint)",
  learned: "var(--color-success, #3fb950)",
  installed: "var(--color-text-interactive-base, var(--color-text))",
}

export default function SkillsPage(): JSX.Element {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const sync = useGlobalSync()

  const [skills, skillsCtl] = createResource(async () => {
    const res = await sdk.client.app.skills()
    return (res.data ?? []) as Skill[]
  })

  const [search, setSearch] = createSignal("")
  const [category, setCategory] = createSignal("all")
  const [view, setView] = createSignal<View>("list")
  const [busy, setBusy] = createSignal(false)
  let fileInput: HTMLInputElement | undefined

  // Enable/disable is the real `permission.skill` config: a skill an agent can
  // load is one whose skill-permission isn't "deny" (the skill tool filters the
  // rest), so this toggle is effective, not cosmetic.
  const skillPerm = createMemo<Record<string, Action>>(() => {
    const perm = sync.data.config.permission
    if (!perm || typeof perm === "string") return {}
    const skill = (perm as Record<string, unknown>).skill
    if (!skill || typeof skill === "string") return {}
    return skill as Record<string, Action>
  })
  const enabled = (name: string) => skillPerm()[name] !== "deny"

  async function toggle(name: string, next: boolean) {
    const map: Record<string, Action> = { ...skillPerm(), [name]: next ? "allow" : "deny" }
    const perm = sync.data.config.permission
    const base = perm && typeof perm === "object" ? perm : {}
    sync.set("config", "permission", { ...base, skill: map })
    try {
      await sync.updateConfig({ permission: { skill: map } } as Config)
    } catch (err) {
      showToast({ variant: "error", title: "Failed to update skill", description: message(err) })
    }
  }

  const all = () => skills() ?? []
  const enabledCount = createMemo(() => all().filter((s) => enabled(s.name)).length)

  const categories = createMemo(() => {
    const counts = new Map<string, number>()
    for (const s of all()) {
      const cat = s.category ?? "uncategorized"
      counts.set(cat, (counts.get(cat) ?? 0) + 1)
    }
    return [
      { id: "all", label: "All", count: all().length },
      ...[...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, count]) => ({ id, label: id, count })),
    ]
  })

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase()
    const cat = category()
    return all()
      .filter((s) => cat === "all" || (s.category ?? "uncategorized") === cat)
      .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q))
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

  return (
    <div class="skills-workspace">
      <div class="skills-workspace__header">
        <div class="skills-workspace__heading">
          <div>
            <h1>Skills</h1>
            <p>Playbooks available to this workspace and its research agents.</p>
          </div>
          <div class="skills-workspace__summary">
            <span>{enabledCount()} enabled</span>
            <span>{all().length} total</span>
          </div>
        </div>

        <Show when={view() === "list"}>
          <div class="skills-workspace__toolbar">
            <Toolbar>
              <FilterMenu options={categories()} value={category()} onSelect={setCategory} />
              <SearchInput value={search()} onInput={setSearch} placeholder="Search skills" />
              <AddMenu
                label="add skill"
                items={[
                  {
                    icon: "pencil-line",
                    label: "write from scratch",
                    description: "Author a new SKILL.md in the editor",
                    onSelect: () => setView("scratch"),
                  },
                  {
                    icon: "cloud-upload",
                    label: "upload a skill",
                    description: "Import a SKILL.md file from disk",
                    onSelect: () => fileInput?.click(),
                  },
                  {
                    icon: "github",
                    label: "import from GitHub",
                    description: "Install from a public git repo URL",
                    onSelect: () => setView("github"),
                  },
                ]}
              />
            </Toolbar>
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
          <Show when={view() === "scratch"}>
            <ScratchForm
              busy={busy()}
              onCancel={() => setView("list")}
              onCreate={async (name, description, body) => {
                setBusy(true)
                try {
                  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
                  await sdk.client.app.skill.write({ name, content })
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
                  const res = await installFromGit(platform.fetch ?? fetch, sdk.url, currentDirectory(), url)
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
            <Show when={!skills.loading} fallback={<div style={loadingStyle()}>Loading skills…</div>}>
              <Show
                when={filtered().length > 0}
                fallback={
                  <div style={{ "padding-top": "36px" }}>
                    <EmptyState
                      icon="brain"
                      title={search() || category() !== "all" ? "No matching skills" : "No skills yet"}
                      hint="Write one from scratch, upload a SKILL.md, or import from a public GitHub repo."
                    />
                  </div>
                }
              >
                <div class="skills-workspace__list">
                  <For each={shelves()}>
                    {([cat, items]) => (
                      <section class="skills-workspace__group">
                        <div class="skills-workspace__group-heading">
                          <span class="atlas-section-label">{cat}</span>
                          <span>{items.length}</span>
                        </div>
                        <div class="skills-workspace__rows">
                          <For each={items}>
                            {(skill) => (
                              <SkillRow
                                skill={skill}
                                on={enabled(skill.name)}
                                onToggle={(v) => void toggle(skill.name, v)}
                              />
                            )}
                          </For>
                        </div>
                      </section>
                    )}
                  </For>
                </div>
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
      await sdk.client.app.skill.write({ name, content })
      await skillsCtl.refetch()
      showToast({ variant: "success", title: `Skill "${name}" uploaded` })
    } catch (err) {
      showToast({ variant: "error", title: "Upload failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }
}

function SkillRow(props: { skill: Skill; on: boolean; onToggle: (v: boolean) => void }): JSX.Element {
  const source = () => sourceOf(props.skill.location)
  return (
    <div class="skills-workspace__row" data-enabled={props.on ? "true" : "false"}>
      <div class="skills-workspace__identity">
        <strong title={props.skill.name}>{props.skill.name}</strong>
        <span>
          <i style={{ background: SOURCE_DOT[source()] }} />
          {source()}
        </span>
      </div>

      <Show when={props.skill.description}>
        <p>{props.skill.description}</p>
      </Show>

      <div class="skills-workspace__tags">
        <For each={(props.skill.tags ?? []).slice(0, 3)}>{(tag) => <span>{tag}</span>}</For>
      </div>
      <Switch data-action="skill-toggle" checked={props.on} onChange={props.onToggle} hideLabel>
        {props.skill.name}
      </Switch>
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
    <div class="flex flex-col gap-4 max-w-[680px]">
      <span class="atlas-section-label">Write a new skill</span>
      <div class="flex flex-col gap-4 p-5 border border-border-weak-base rounded-[8px] bg-surface-base/40">
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
        <div class="flex items-center gap-2">
          <FormButton
            label={props.busy ? "creating…" : "create skill"}
            disabled={props.busy || !valid()}
            onClick={() => props.onCreate(name().trim(), description().trim(), body())}
          />
          <FormButton label="cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
        </div>
      </div>
    </div>
  )
}

function GithubForm(props: { busy: boolean; onCancel: () => void; onInstall: (url: string) => void }): JSX.Element {
  const [url, setUrl] = createSignal("")
  return (
    <div class="flex flex-col gap-4 max-w-[680px]">
      <span class="atlas-section-label">Import from GitHub</span>
      <div class="flex flex-col gap-4 p-5 border border-border-weak-base rounded-[8px] bg-surface-base/40">
        <FormField label="Repository URL" value={url()} onInput={setUrl} placeholder="https://github.com/owner/repo" />
        <p class="text-12-regular text-text-weak flex items-start gap-1.5">
          <Icon name="check-small" size="small" class="text-icon-weak-base mt-0.5" />
          Skills are fetched, screened by a multi-layer security review, and only installed if they pass.
        </p>
        <div class="flex items-center gap-2">
          <FormButton
            label={props.busy ? "installing…" : "install"}
            disabled={props.busy || !url().trim()}
            onClick={() => props.onInstall(url().trim())}
          />
          <FormButton label="cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
        </div>
      </div>
    </div>
  )
}

function loadingStyle(): JSX.CSSProperties {
  return {
    padding: "48px 0",
    "text-align": "center",
    "font-family": FONT_SANS,
    "font-size": "13px",
    color: "var(--color-text-muted)",
  }
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

async function installFromGit(
  fetchFn: typeof fetch,
  baseUrl: string,
  directory: string,
  url: string,
): Promise<{ installed: unknown[]; rejected: unknown[]; warnings: unknown[] }> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/settings/skills/install?directory=${encodeURIComponent(directory)}`
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(text || `Request failed (${res.status})`)
  }
  return res.json() as Promise<{ installed: unknown[]; rejected: unknown[]; warnings: unknown[] }>
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
