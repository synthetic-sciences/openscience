import {
  batch,
  createComputed,
  createEffect,
  createMemo,
  createResource,
  lazy,
  onCleanup,
  Show,
  Suspense,
  type ParentProps,
} from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { TerminalProvider } from "@/context/terminal"
import { FileProvider } from "@/context/file"
import { PromptProvider } from "@/context/prompt"

import { DataProvider } from "@synsci/ui/context"
import { MarkdownImages } from "@synsci/ui/markdown"
import { iife } from "@synsci/util/iife"
import type { QuestionAnswer } from "@synsci/sdk/v2"
import { showToast } from "@synsci/ui/toast"
import { useLanguage } from "@/context/language"
import { uiStore } from "@/atlas/store/ui"
import { artifactContext } from "@/artifacts/context"
import { normalizeStoredArtifact, savedResultLabel } from "@/artifacts/store"
import { ProjectWorkspaceFrame } from "@/atlas/ProjectWorkspaceFrame"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { decode64, setCurrentDirectory } from "@/utils/base64"
import { assetUrl, workspaceAssetPath } from "@/utils/markdown-assets"
import { rawFileQuery } from "@/utils/project-file"
import { projectPrefs } from "@/atlas/store/projectPrefs"
import { missingProject, ProjectUnavailable } from "./project-availability"
import {
  looksLikeProjectSegment,
  projectAliasID,
  projectPathname,
  resolveProjectAlias,
  resolveProjectRoute,
} from "@/utils/project-route"

const ProjectRightPane = lazy(() => import("@/atlas/ProjectRightPane"))

export default function Layout(props: ParentProps) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const language = useLanguage()
  const global = useGlobalSync()
  const layout = useLayout()
  const route = createMemo(() => resolveProjectRoute(params.dir, global.data.project))
  const aliasID = createMemo(() => {
    if (!global.ready || route()) return
    return projectAliasID(params.dir)
  })
  const [alias] = createResource(aliasID, async (projectID) => ({
    projectID,
    project: await global.project.resolveID(projectID).catch(() => undefined),
  }))
  const recovered = createMemo(() => {
    const current = alias.latest
    if (!current || current.projectID !== aliasID()) return
    return resolveProjectAlias(params.dir, current.project)
  })
  const legacy = createMemo(() => {
    if (!params.dir || looksLikeProjectSegment(params.dir)) return ""
    return decode64(params.dir) ?? ""
  })
  const unresolvedLegacy = createMemo(() => {
    if (route()) return
    return legacy() || undefined
  })
  const [legacyProject] = createResource(unresolvedLegacy, async (directory) => ({
    directory,
    project: await global.project.resolve(directory).catch(() => undefined),
  }))
  const recoveredLegacy = createMemo(() => {
    const current = legacyProject.latest
    if (!current || current.directory !== unresolvedLegacy() || !current.project) return
    return resolveProjectRoute(params.dir, [current.project])
  })
  const active = createMemo(() => route() ?? recovered() ?? recoveredLegacy())
  // A route that resolves against the catalog (seeded from the persisted
  // cache) renders straight away; this round trip only demotes it to the
  // recovery surface once the server confirms the folder is gone.
  const availabilityID = createMemo(() => route()?.projectID)
  const [availability] = createResource(availabilityID, async (projectID) => ({
    projectID,
    missing: await global.project.resolveID(projectID).then(
      () => undefined,
      (error) => missingProject(error),
    ),
  }))
  const unavailable = createMemo(() => {
    const current = route()
    const result = availability.latest
    if (!current || result?.projectID !== current.projectID || !result.missing) return
    return { directory: result.missing.directory ?? current.directory }
  })
  // A legacy base64 route carries only a directory. Resolve its opaque project
  // capability before mounting project-scoped providers; otherwise children
  // can synchronously build requests without the required project selector.
  const directory = createMemo(() => active()?.directory ?? "")
  const projectID = createMemo(() => active()?.projectID)
  const scope = createMemo(() => active()?.segment ?? projectID() ?? directory())

  createComputed(() => {
    const project = scope()
    if (!project) return
    const session = params.id ?? "new"
    batch(() => {
      uiStore.activateScope(project, session)
      artifactContext.activateScope(project, session)
    })
  })

  createEffect(() => {
    const value = directory()
    if (!value || unavailable()) return
    const clear = setCurrentDirectory(value, projectID())
    onCleanup(clear)
  })

  createEffect(() => {
    const current = active()
    if (!current?.legacy) return
    navigate(`${projectPathname(current.segment, params.id)}${location.search}${location.hash}`, { replace: true })
  })

  createEffect(() => {
    if (!params.dir) return
    if (directory()) return
    if (!global.ready) return
    if (aliasID() && (alias.loading || alias.state === "unresolved")) return
    if (legacy() && (legacyProject.loading || legacyProject.state === "unresolved")) return
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: "Unknown project in URL.",
    })
    navigate("/")
  })

  const home = () => navigate("/", { replace: true })
  const remove = () => {
    const current = active()
    if (current) {
      projectPrefs.hide(current.projectID, current.project.worktree)
      layout.projects.close(current.project.worktree)
      showToast({ variant: "success", title: "Project removed from home" })
    }
    home()
  }

  return (
    <Show
      when={unavailable()}
      fallback={
        <Show when={directory()}>
          <SDKProvider directory={directory()} projectID={projectID()} scope={scope()}>
            <SyncProvider>
              {iife(() => {
                const sync = useSync()
                const sdk = useSDK()

                const respond = (input: {
                  sessionID: string
                  permissionID: string
                  response: "once" | "session" | "project" | "always" | "reject"
                }) => sdk.client.permission.respond(input)

                const replyToQuestion = (input: { requestID: string; answers: QuestionAnswer[] }) =>
                  sdk.client.question.reply(input)

                const rejectQuestion = (input: { requestID: string }) => sdk.client.question.reject(input)

                const navigateToSession = (sessionID: string) => {
                  navigate(`/${params.dir}/session/${sessionID}`)
                }

                // Tool cards and diffs share the contextual Files surface with the
                // explorer. Selecting one opens the right pane without replacing the
                // conversation in the center.
                const openFile = (path: string) => {
                  const dir = directory()
                  uiStore.openFile(dir, path, { scope: "auto" })
                }

                const openArtifact = (id: string) => {
                  void sdk
                    .request(`/file/artifact-store/${encodeURIComponent(id)}`)
                    .then(async (response) => {
                      if (!response.ok) throw new Error(`artifact could not be opened (${response.status})`)
                      const artifact = normalizeStoredArtifact(await response.json())
                      if (!artifact) throw new Error("artifact metadata is invalid")
                      uiStore.openSaved(artifact)
                    })
                    .catch((error: unknown) => {
                      showToast({
                        variant: "error",
                        title: "artifact could not be opened",
                        description: error instanceof Error ? error.message : String(error),
                      })
                    })
                }

                // "Save as Result…" at the end of an assistant turn promotes a
                // written scratch file into a durable Result via the explicit-save route.
                const saveArtifact = (path: string) => {
                  const session = params.id && params.id !== "new" ? params.id : undefined
                  if (!session) {
                    const error = new Error("No active session.")
                    showToast({ variant: "error", title: "artifact save failed", description: error.message })
                    return Promise.reject(error)
                  }
                  return sdk
                    .request("/file/artifact", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ path, sessionID: session }),
                    })
                    .then(async (response) => {
                      if (!response.ok) throw new Error(`artifact save failed (${response.status})`)
                      const name = path.split("/").filter(Boolean).at(-1) || "Result"
                      const saved = normalizeStoredArtifact(await response.json().catch(() => undefined))
                      window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
                      showToast({
                        variant: "success",
                        title: "Saved to Results",
                        description: saved ? savedResultLabel(saved) : name,
                        actions: saved
                          ? [
                              {
                                label: "Open",
                                onClick: () => uiStore.openSaved(saved),
                              },
                            ]
                          : undefined,
                      })
                    })
                    .catch((error: unknown) => {
                      showToast({
                        variant: "error",
                        title: "artifact save failed",
                        description: error instanceof Error ? error.message : String(error),
                      })
                      throw error
                    })
                }

                // Chat markdown may reference workspace files (figures/plot.png).
                // Resolve relative images against the project root through the
                // backend raw-file endpoint so they render instead of 404ing on
                // the SPA origin. Absolute http(s)/data: URLs pass through.
                const image = (src: string) =>
                  assetUrl(src, {
                    root: directory(),
                    url: (path) =>
                      sdk.request.url(
                        "/file/raw",
                        rawFileQuery({
                          directory: directory(),
                          path,
                          sessionID: params.id && params.id !== "new" ? params.id : undefined,
                          scope: "session",
                          inline: true,
                        }),
                      ),
                  })
                const file = (href: string) => workspaceAssetPath(href, directory())

                return (
                  <DataProvider
                    data={sync.data}
                    directory={directory()}
                    onPermissionRespond={respond}
                    onQuestionReply={replyToQuestion}
                    onQuestionReject={rejectQuestion}
                    onNavigateToSession={navigateToSession}
                    onOpenFile={openFile}
                    onOpenArtifact={openArtifact}
                    onSaveArtifact={saveArtifact}
                  >
                    <MarkdownImages resolve={image} resolveFile={file} openFile={openFile}>
                      <LocalProvider>
                        <TerminalProvider>
                          <FileProvider>
                            <PromptProvider>
                              <ProjectWorkspaceFrame
                                inspector={
                                  <Suspense>
                                    <ProjectRightPane project={sdk.scope} session={params.id ?? "new"} />
                                  </Suspense>
                                }
                              >
                                {props.children}
                              </ProjectWorkspaceFrame>
                            </PromptProvider>
                          </FileProvider>
                        </TerminalProvider>
                      </LocalProvider>
                    </MarkdownImages>
                  </DataProvider>
                )
              })}
            </SyncProvider>
          </SDKProvider>
        </Show>
      }
    >
      {(missing) => <ProjectUnavailable directory={missing().directory} onBack={home} onRemove={remove} />}
    </Show>
  )
}
