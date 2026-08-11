import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { DateTime } from "luxon"
import { AppHeader } from "@/atlas/AppHeader"
import {
  IconArchive,
  IconChevronRight,
  IconFolder,
  IconMoon,
  IconPin,
  IconPinFilled,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSun,
  IconTrash,
  IconX,
} from "@/atlas/shared/Icon"
import { Wordmark } from "@/atlas/Wordmark"
import { projectHint, projectName, type LauncherState, type PreparedProject } from "./home-projects"
import "./home-workbench.css"

export type HomeProject = PreparedProject & {
  sessions?: number
}

export function ProjectsWorkbench(props: {
  state: LauncherState
  projects: HomeProject[]
  query: string
  home?: string
  refreshing?: boolean
  accessory?: JSX.Element
  notice?: JSX.Element
  dark: boolean
  serverName: string
  serverStatus: "checking" | "healthy" | "error"
  onQuery: (query: string) => void
  onOpen: (project: HomeProject) => void
  onPin: (project: HomeProject) => void
  onRemove: (project: HomeProject) => void
  onCreate: () => void
  onImport: () => void
  onRetry: () => void
  onTheme: () => void
  onSettings: () => void
  onServer: () => void
}): JSX.Element {
  const [searching, setSearching] = createSignal(false)
  const searchOpen = () => searching() || props.query.length > 0
  const recent = () => props.state === "recent"
  let input: HTMLInputElement | undefined

  const openSearch = () => {
    setSearching(true)
    queueMicrotask(() => input?.focus())
  }

  const clearSearch = () => {
    props.onQuery("")
    input?.focus()
  }

  const actions = () => (
    <div class="science-home__state-actions">
      <button class="science-home__button science-home__button--primary" type="button" onClick={props.onCreate}>
        <IconPlus size={14} strokeWidth={1.5} />
        Create project
      </button>
      <button class="science-home__button" type="button" onClick={props.onImport}>
        <IconFolder size={14} strokeWidth={1.5} />
        Import existing folder
      </button>
    </div>
  )

  return (
    <div class="science-home__view">
      <AppHeader class="science-home__bar">
        <Wordmark size="sm" textOnly />
        <span class="science-home__spacer" />

        <div class="science-home__bar-actions">
          <div class="science-home__search" data-open={searchOpen()}>
            <IconSearch size={14} strokeWidth={1.5} />
            <input
              ref={input}
              id="science-home-project-search"
              type="search"
              aria-label="Search projects"
              value={props.query}
              placeholder="Search projects"
              onInput={(event) => props.onQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                props.onQuery("")
                setSearching(false)
                event.currentTarget.blur()
              }}
            />
            <Show when={props.query}>
              <button type="button" aria-label="Clear search" onClick={clearSearch}>
                <IconX size={12} strokeWidth={1.6} />
              </button>
            </Show>
          </div>

          <button
            class="science-home__icon science-home__search-toggle"
            type="button"
            aria-label="Search projects"
            aria-controls="science-home-project-search"
            aria-expanded={searchOpen()}
            onClick={openSearch}
          >
            <IconSearch size={15} strokeWidth={1.5} />
          </button>
          {props.accessory}
          <button
            class="science-home__icon science-home__new"
            type="button"
            aria-label="New project"
            title="Create project"
            onClick={props.onCreate}
          >
            <IconPlus size={16} strokeWidth={1.6} />
            <span>New project</span>
          </button>
          <button
            class="science-home__icon"
            type="button"
            aria-label="Import existing folder"
            title="Import existing folder"
            onClick={props.onImport}
          >
            <IconFolder size={15} strokeWidth={1.5} />
          </button>
          <button class="science-home__icon" type="button" aria-label="Toggle theme" onClick={props.onTheme}>
            <Show when={props.dark} fallback={<IconMoon size={15} strokeWidth={1.5} />}>
              <IconSun size={15} strokeWidth={1.5} />
            </Show>
          </button>
          <button class="science-home__icon" type="button" aria-label="Settings" onClick={props.onSettings}>
            <IconSettings size={15} strokeWidth={1.5} />
          </button>
          <button
            class="science-home__server"
            type="button"
            aria-label={props.serverName}
            title={`Server · ${props.serverName}`}
            onClick={props.onServer}
          >
            <span class="science-home__server-dot" data-status={props.serverStatus} aria-hidden="true" />
            <span>{props.serverName}</span>
          </button>
        </div>
      </AppHeader>

      {props.notice}

      <main class="atlas-scroll science-home__main">
        <div class="science-home__content">
          <header class="science-home__heading">
            <div class="science-home__heading-copy">
              <div class="science-home__title">
                <IconArchive size={15} strokeWidth={1.45} />
                <h1 id="science-home-projects-title">Projects</h1>
                <Show when={recent()}>
                  <span class="science-home__count" aria-label={`${props.projects.length} projects`}>
                    {props.projects.length}
                  </span>
                </Show>
              </div>
              <p>Recent research, files, and sessions.</p>
            </div>
            <Show when={recent() && props.refreshing}>
              <span class="science-home__refreshing" role="status">
                Refreshing…
              </span>
            </Show>
          </header>

          <Switch>
            <Match when={props.state === "loading"}>
              <section class="science-home__state" role="status" aria-live="polite">
                <span class="science-home__spinner" aria-hidden="true" />
                <div>
                  <strong>Loading projects…</strong>
                  <span>Reading projects from this server.</span>
                </div>
              </section>
            </Match>

            <Match when={props.state === "error"}>
              <section class="science-home__state science-home__state--error" role="alert">
                <div>
                  <strong>Local workspace unavailable</strong>
                  <span>Check the selected server, then try the connection again.</span>
                </div>
                <button class="science-home__button" type="button" onClick={props.onRetry}>
                  Try again
                </button>
              </section>
            </Match>

            <Match when={props.state === "empty"}>
              <section class="science-home__state science-home__state--empty">
                <div>
                  <strong>No projects yet</strong>
                  <span>Create a project to keep sessions, files, and evidence together.</span>
                </div>
                {actions()}
              </section>
            </Match>

            <Match when={props.state === "recent"}>
              <Show
                when={props.projects.length > 0}
                fallback={
                  <section class="science-home__state science-home__state--empty" aria-live="polite">
                    <div>
                      <strong>No matching projects</strong>
                      <span>Clear the search or create a new project.</span>
                    </div>
                    <div class="science-home__state-actions">
                      <button class="science-home__button" type="button" onClick={clearSearch}>
                        Clear search
                      </button>
                      <button
                        class="science-home__button science-home__button--primary"
                        type="button"
                        onClick={props.onCreate}
                      >
                        <IconPlus size={14} strokeWidth={1.5} />
                        Create project
                      </button>
                    </div>
                  </section>
                }
              >
                <ul class="science-home__projects" aria-labelledby="science-home-projects-title">
                  <For each={props.projects}>
                    {(project) => (
                      <li class="science-home__project-row" data-pinned={project.pinned ? "true" : undefined}>
                        <button
                          class="science-home__project-action science-home__project-pin"
                          type="button"
                          aria-label={`${project.pinned ? "Unpin" : "Pin"} ${projectName(project)}`}
                          aria-pressed={project.pinned}
                          title={project.pinned ? "Unpin project" : "Pin project"}
                          onClick={() => props.onPin(project)}
                        >
                          <Show when={project.pinned} fallback={<IconPin size={14} strokeWidth={1.45} />}>
                            <IconPinFilled size={14} strokeWidth={1.45} />
                          </Show>
                        </button>
                        <button
                          class="science-home__project"
                          type="button"
                          data-project={project.id}
                          title={`Open ${projectName(project)}`}
                          onClick={() => props.onOpen(project)}
                        >
                          <span class="science-home__project-copy">
                            <strong>{projectName(project)}</strong>
                            <span>{project.pinned ? "Pinned" : projectHint(project)}</span>
                          </span>
                          <Show when={project.sessions !== undefined}>
                            <span class="science-home__sessions">
                              {project.sessions} {project.sessions === 1 ? "session" : "sessions"}
                            </span>
                          </Show>
                          <time datetime={DateTime.fromMillis(project.updatedAt).toISO() ?? undefined}>
                            {DateTime.fromMillis(project.updatedAt).toRelative({ style: "short" }) ?? "Recently"}
                          </time>
                          <span class="science-home__arrow" aria-hidden="true">
                            <IconChevronRight size={14} strokeWidth={1.45} />
                          </span>
                        </button>
                        <button
                          class="science-home__project-action science-home__project-remove"
                          type="button"
                          aria-label={`Remove ${projectName(project)} from home`}
                          title="Remove project from home"
                          onClick={() => props.onRemove(project)}
                        >
                          <IconTrash size={13} strokeWidth={1.4} />
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Match>
          </Switch>
        </div>
      </main>
    </div>
  )
}
