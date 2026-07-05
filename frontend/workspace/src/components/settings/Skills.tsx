import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { currentDirectory } from "@/utils/base64"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useGlobalSync } from "@/context/global-sync"
import type { Config } from "@synsci/sdk/v2/client"

interface Skill {
  name: string
  description?: string
  location: string
  category?: string
  tags?: string[]
  entry?: boolean
}
import {
  PanelScroll,
  PanelHeader,
  PanelBody,
  Toolbar,
  SearchInput,
  FilterMenu,
  AddMenu,
  Card,
  Row,
  SectionLabel,
  EmptyState,
  FormField,
  FormButton,
} from "./_shared"

type Action = "allow" | "deny"
type View = "list" | "scratch" | "github"

export default function Skills() {
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

  // ── enable/disable state, backed by the real `permission.skill` config ──
  // A skill the agent can load is one whose skill-permission is not "deny".
  // The skill tool already filters denied skills, so this toggle is effective.
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

  // ── grouping / filtering ──
  const categories = createMemo(() => {
    const counts = new Map<string, number>()
    for (const s of skills() ?? []) {
      const cat = s.category ?? "uncategorized"
      counts.set(cat, (counts.get(cat) ?? 0) + 1)
    }
    return [
      { id: "all", label: "All", count: (skills() ?? []).length },
      ...[...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, count]) => ({ id, label: id, count })),
    ]
  })

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase()
    const cat = category()
    return (skills() ?? [])
      .filter((s) => cat === "all" || (s.category ?? "uncategorized") === cat)
      .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <PanelScroll>
      <PanelHeader
        title="Skills"
        description="Expert instructions your agents can load on demand — bundled, learned, and installed. Toggle a skill off to hide it from every agent."
        toolbar={
          <Show when={view() === "list"}>
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
          </Show>
        }
      />

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

      <PanelBody>
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
          <Show
            when={!skills.loading}
            fallback={<div class="py-12 text-center text-13-regular text-text-weak">Loading skills…</div>}
          >
            <Show
              when={filtered().length > 0}
              fallback={
                <EmptyState
                  icon="brain"
                  title={search() || category() !== "all" ? "No matching skills" : "No skills yet"}
                  hint="Add one from scratch, upload a SKILL.md, or import from a public GitHub repo."
                />
              }
            >
              <div class="flex flex-col gap-2">
                <SectionLabel label="Skills" count={filtered().length} />
                <Card>
                  <For each={filtered()}>
                    {(skill) => (
                      <Row>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="text-14-medium text-text-strong truncate">{skill.name}</span>
                            <Show when={skill.category}>
                              <span class="text-11-medium text-text-weak/70 px-1.5 py-0.5 rounded-md bg-surface-raised-base/60">
                                {skill.category}
                              </span>
                            </Show>
                          </div>
                          <Show when={skill.description}>
                            <p class="text-12-regular text-text-weak truncate mt-0.5">{skill.description}</p>
                          </Show>
                        </div>
                        <Switch checked={enabled(skill.name)} onChange={(v) => void toggle(skill.name, v)} hideLabel>
                          {skill.name}
                        </Switch>
                      </Row>
                    )}
                  </For>
                </Card>
              </div>
            </Show>
          </Show>
        </Show>
      </PanelBody>
    </PanelScroll>
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

function ScratchForm(props: {
  busy: boolean
  onCancel: () => void
  onCreate: (name: string, description: string, body: string) => void
}) {
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [body, setBody] = createSignal("")
  const valid = () => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name().trim()) && description().trim().length > 0
  return (
    <div class="flex flex-col gap-4">
      <SectionLabel label="Write a new skill" />
      <div class="flex flex-col gap-4 p-5 border border-border-weak-base rounded-[4px] bg-surface-base/40">
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

function GithubForm(props: { busy: boolean; onCancel: () => void; onInstall: (url: string) => void }) {
  const [url, setUrl] = createSignal("")
  return (
    <div class="flex flex-col gap-4">
      <SectionLabel label="Import from GitHub" />
      <div class="flex flex-col gap-4 p-5 border border-border-weak-base rounded-[4px] bg-surface-base/40">
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
