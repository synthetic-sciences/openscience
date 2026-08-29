import "@/index.css"
import { ErrorBoundary, Show, Suspense, onCleanup, onMount, type ParentProps } from "solid-js"
import { A, Router, Route, Navigate } from "@solidjs/router"
import { MetaProvider } from "@solidjs/meta"
import { I18nProvider } from "@synsci/ui/context"
import { ThemeProvider } from "@synsci/ui/theme"
import { GlobalSyncProvider } from "@/context/global-sync"
import { PermissionProvider } from "@/context/permission"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { normalizeServerUrl, ServerProvider, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { CommentsProvider } from "@/context/comments"
import { NotificationProvider } from "@/context/notification"
import { ModelsProvider } from "@/context/models"
import { DialogProvider } from "@synsci/ui/context/dialog"
import { CommandProvider } from "@/context/command"
import { LanguageProvider, useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { HighlightsProvider } from "@/context/highlights"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "./pages/error"
import { URLS } from "@/config/urls"
import { resolveDefaultServerUrl } from "@/config/server-url"
import { AsciiSpinner } from "@/atlas/shared/AsciiSpinner"
import { AccountGate } from "@/atlas/AccountGate"
import Home from "@/pages/home"
import { Session } from "@/pages/session-loader"
import { DEFAULT_PANEL, preloadPanel } from "@/components/settings/registry"
import { StartupUpdateCheck } from "@/components/settings/startup-update"
import "./app.css"

const Loading = () => (
  <div class="size-full" style={{ display: "flex", "align-items": "center", "justify-content": "center" }}>
    <AsciiSpinner label="loading…" color="var(--color-text-faint)" />
  </div>
)

const NotFound = () => (
  <main class="app-not-found" aria-labelledby="not-found-title">
    <span class="app-not-found__eyebrow">404</span>
    <h1 id="not-found-title">Page Not Found</h1>
    <p>This address does not match a project, session, or OpenScience workspace.</p>
    <A class="app-not-found__action" href="/">
      Back to Projects
    </A>
  </main>
)

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.locale, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENSCIENCE__?: { updaterEnabled?: boolean; deepLinks?: string[] }
    __OPENSCIENCE_BASE_URL__?: string
  }
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <ThemeProvider defaultTheme="openscience">
        <LanguageProvider>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <DialogProvider>{props.children}</DialogProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.url} keyed>
      {props.children}
    </Show>
  )
}

function DesktopReadySignal() {
  const platform = usePlatform()
  onMount(() => {
    if (platform.platform !== "desktop") return
    document.documentElement.dataset.openscienceReady = "true"
  })
  onCleanup(() => delete document.documentElement.dataset.openscienceReady)
  return null
}

export function AppInterface(props: { defaultUrl?: string }) {
  const platform = usePlatform()

  // Warm the default Customize panel from the mounted app lifecycle. Keeping
  // this out of module evaluation prevents detached consumers (including
  // isolated renderers) from owning an untracked lazy import.
  onMount(() => void preloadPanel(DEFAULT_PANEL).catch(() => undefined))

  const stored = (() => {
    if (platform.platform !== "web") return
    const result = platform.getDefaultServerUrl?.()
    if (result instanceof Promise) return
    if (!result) return
    return normalizeServerUrl(result)
  })()

  const defaultServerUrl = () => {
    const configured = (() => {
      const direct = normalizeServerUrl(import.meta.env.VITE_OPENSCIENCE_SERVER_URL ?? "")
      if (direct) return direct

      const host = import.meta.env.VITE_OPENSCIENCE_SERVER_HOST
      const port = import.meta.env.VITE_OPENSCIENCE_SERVER_PORT
      if (!host && !port) return
      return normalizeServerUrl(`http://${host ?? "localhost"}:${port ?? "4096"}`)
    })()

    return resolveDefaultServerUrl({
      explicit: normalizeServerUrl(props.defaultUrl ?? ""),
      stored,
      configured,
      hostname: location.hostname,
      origin: window.location.origin,
      hostedDomain: URLS.host,
      dev: import.meta.env.DEV,
    })
  }

  return (
    <ServerProvider defaultUrl={defaultServerUrl()}>
      <ServerKey>
        <DesktopReadySignal />
        <AccountGate>
          <GlobalSDKProvider>
            <GlobalSyncProvider>
              <Router
                root={(props) => (
                  <SettingsProvider>
                    <StartupUpdateCheck />
                    <PermissionProvider>
                      <LayoutProvider>
                        <NotificationProvider>
                          <ModelsProvider>
                            <CommandProvider>
                              <HighlightsProvider>
                                <Layout>{props.children}</Layout>
                              </HighlightsProvider>
                            </CommandProvider>
                          </ModelsProvider>
                        </NotificationProvider>
                      </LayoutProvider>
                    </PermissionProvider>
                  </SettingsProvider>
                )}
              >
                <Route
                  path="/"
                  component={() => (
                    <Suspense fallback={<Loading />}>
                      <Home />
                    </Suspense>
                  )}
                />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route path="/" component={() => <Navigate href="session" />} />
                  <Route
                    path="/session/:id?"
                    component={(p) => (
                      <Show when={p.params.id ?? "new"}>
                        <CommentsProvider>
                          <Suspense fallback={<Loading />}>
                            <Session />
                          </Suspense>
                        </CommentsProvider>
                      </Show>
                    )}
                  />
                </Route>
                <Route path="*404" component={NotFound} />
              </Router>
            </GlobalSyncProvider>
          </GlobalSDKProvider>
        </AccountGate>
      </ServerKey>
    </ServerProvider>
  )
}
