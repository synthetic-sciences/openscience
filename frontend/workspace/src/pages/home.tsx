import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { useTheme } from "@synsci/ui/theme"
import { CommandPalette } from "@/atlas/CommandPalette"
import { DisconnectedPanel } from "@/atlas/DisconnectedPanel"
import { FdaBanner } from "@/atlas/FdaBanner"
import { FolderPicker } from "@/atlas/FolderPicker"
import { HelpOverlay } from "@/atlas/HelpOverlay"
import { confirmDialog } from "@/atlas/dialogs"
import { uiStore } from "@/atlas/store/ui"
import { projectPrefs } from "@/atlas/store/projectPrefs"
import { ToastContainer } from "@/atlas/Toast"
import { useGlobalKeys } from "@/atlas/useGlobalKeys"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { DialogCreateProject, type ProjectCreateInput } from "@/components/dialog-create-project"
import { DialogSettings } from "@/components/dialog-settings"
import { settingsApi } from "@/components/settings/api"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { ProjectsWorkbench, type HomeProject } from "./home-workbench"
import { filterProjects, launcherState, prepareProjects, projectName, type ProjectRecord } from "./home-projects"
import { projectHref } from "@/utils/project-route"

export { ProjectsWorkbench, type HomeProject }

export default function Home(): JSX.Element {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const theme = useTheme()
  const [query, setQuery] = createSignal("")
  const [draft, setDraft] = createSignal({ name: "", sources: [] as string[] })
  const projects = createMemo(() =>
    prepareProjects(sync.data.project, projectPrefs.hidden(), projectPrefs.favorites()).map((project): HomeProject => {
      const child = sync.child(project.worktree, { bootstrap: false, projectID: project.id })[0]
      if (child.status !== "complete") return project
      return { ...project, sessions: child.sessionTotal }
    }),
  )
  const filtered = createMemo(() => filterProjects(projects(), query()))
  const state = createMemo(() =>
    launcherState({
      ready: sync.ready,
      healthy: server.healthy(),
      error: sync.error,
      projectCount: projects().length,
    }),
  )
  const status = createMemo(() => {
    if (server.healthy() === true) return "healthy"
    if (server.healthy() === false) return "error"
    return "checking"
  })

  function openProject(project: ProjectRecord) {
    projectPrefs.unhide(project.id, project.worktree)
    layout.projects.open(project.worktree)
    server.projects.touch(project.id)
    navigate(projectHref(project))
  }

  function pinProject(project: ProjectRecord) {
    projectPrefs.toggleFavorite(project.id, project.worktree)
  }

  async function removeProject(project: ProjectRecord) {
    const name = projectName(project)
    const ok = await confirmDialog(dialog, {
      title: `Remove ${name}?`,
      message:
        "This removes the project from your home list. Its files and sessions stay on disk, and importing the folder restores it.",
      confirmLabel: "Remove",
      danger: true,
    })
    if (!ok) return
    projectPrefs.hide(project.id, project.worktree)
    layout.projects.close(project.worktree)
    showToast({ variant: "success", title: "Project removed from home" })
  }

  async function openDirectory(directory: string) {
    const project = await sync.project.resolve(directory).catch((error) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
      return undefined
    })
    if (project) openProject(project)
  }

  async function importProject() {
    const resolve = (result: string | string[] | null) => {
      if (Array.isArray(result)) {
        void Promise.all(result.map(openDirectory))
        return
      }
      if (result) void openDirectory(result)
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
      return
    }

    dialog.show(() => <FolderPicker onSelect={resolve} />, {
      onClose: () => resolve(null),
      lite: true,
    })
  }

  async function createProject(input: ProjectCreateInput) {
    const project = await settingsApi<ProjectRecord>(sdk.url, platform.fetch ?? fetch, "/global/project", {
      method: "POST",
      body: JSON.stringify(input),
    })
    setDraft({ name: "", sources: [] })
    openProject(project)
  }

  const mergeSources = (result: string | string[] | null) => {
    const paths = Array.isArray(result) ? result : result ? [result] : []
    if (paths.length === 0) return
    setDraft((current) => ({
      ...current,
      sources: [...new Set([...current.sources, ...paths])].slice(0, 10),
    }))
  }

  async function chooseProjectSources() {
    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog({ title: "Add source folders", multiple: true })
      mergeSources(result)
      return
    }

    const selection = { result: null as string | string[] | null }
    dialog.show(
      () => <FolderPicker multiple title="Add source folder" onSelect={(value) => (selection.result = value)} />,
      {
        onClose: () => {
          mergeSources(selection.result)
          resumeCreateProject()
        },
        lite: true,
      },
    )
  }

  function createDialog() {
    return (
      <DialogCreateProject
        name={draft().name}
        sources={draft().sources}
        onDraft={(name) => setDraft((current) => ({ ...current, name }))}
        onChooseSources={() => void chooseProjectSources()}
        onRemoveSource={(path) =>
          setDraft((current) => ({ ...current, sources: current.sources.filter((source) => source !== path) }))
        }
        onCreate={createProject}
      />
    )
  }

  function resumeCreateProject() {
    dialog.show(createDialog)
  }

  function showCreateProject() {
    setDraft({ name: "", sources: [] })
    dialog.show(createDialog)
  }

  const isDark = () => theme.mode() === "dark"
  const cycleScheme = () => theme.setColorScheme(isDark() ? "light" : "dark")

  useGlobalKeys({ onNew: showCreateProject })

  return (
    <div class="atlas-root science-home">
      <ToastContainer />
      <HelpOverlay open={uiStore.helpOpen()} onClose={() => uiStore.setHelpOpen(false)} />
      <CommandPalette open={uiStore.paletteOpen()} onClose={() => uiStore.setPaletteOpen(false)} />

      <ProjectsWorkbench
        state={state()}
        projects={filtered()}
        query={query()}
        home={sync.data.path.home}
        refreshing={!sync.ready}
        accessory={<FdaBanner />}
        notice={
          <Show when={state() === "recent"}>
            <DisconnectedPanel />
          </Show>
        }
        dark={isDark()}
        serverName={server.name || "Local server"}
        serverStatus={status()}
        onQuery={setQuery}
        onOpen={openProject}
        onPin={pinProject}
        onRemove={(project) => void removeProject(project)}
        onCreate={showCreateProject}
        onImport={() => void importProject()}
        onRetry={() => void server.refresh()}
        onTheme={cycleScheme}
        onSettings={() => dialog.show(() => <DialogSettings />)}
        onServer={() => dialog.show(() => <DialogSelectServer />)}
      />
    </div>
  )
}
