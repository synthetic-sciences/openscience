import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { DialogProvider } from "@synsci/ui/context/dialog"
import { Toast } from "@synsci/ui/toast"
import { PlatformProvider, type Platform } from "@/context/platform"
import { ServerProvider } from "@/context/server"
import { LanguageProvider } from "@/context/language"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider } from "@/context/global-sync"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import DirectoryLayout from "./directory-layout"

/** The real `/:dir` layout under the app's own providers and a memory router,
 * opened cold at `path`. The home and session routes are markers: the layout
 * is the subject, and which of them is on screen is how a test reads where it
 * sent the user. */
export function createDirectoryLayoutFixture(input: { platform: Platform; url: string; path: string }) {
  const history = createMemoryHistory()
  history.set({ value: input.path, replace: true })
  return () => (
    <>
      <Toast.Region />
      <PlatformProvider value={input.platform}>
        <ServerProvider defaultUrl={input.url}>
          <LanguageProvider>
            <DialogProvider>
              <GlobalSDKProvider>
                <GlobalSyncProvider>
                  <MemoryRouter
                    history={history}
                    root={(props) => (
                      <LayoutProvider>
                        <ModelsProvider>{props.children}</ModelsProvider>
                      </LayoutProvider>
                    )}
                  >
                    <Route path="/" component={() => <main data-route="home" />} />
                    <Route path="/:dir" component={DirectoryLayout}>
                      <Route path="/session/:id?" component={() => <section data-route="session" />} />
                    </Route>
                  </MemoryRouter>
                </GlobalSyncProvider>
              </GlobalSDKProvider>
            </DialogProvider>
          </LanguageProvider>
        </ServerProvider>
      </PlatformProvider>
    </>
  )
}
