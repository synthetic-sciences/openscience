import { DialogProvider } from "@synsci/ui/context/dialog"
import { ThemeProvider } from "@synsci/ui/theme"
import { PlatformProvider, type Platform } from "@/context/platform"
import { LanguageProvider } from "@/context/language"
import { SettingsProvider } from "@/context/settings"
import { AppearanceSections, type CommandLineServices } from "../settings-general"
import { StartupUpdateCheck } from "./startup-update"

/** The launch notice with the contexts it reads, so a test can mount the real
 * component against a platform that does — or does not — stage updates. */
export function createStartupUpdateFixture(platform: Platform) {
  return () => (
    <PlatformProvider value={platform}>
      <SettingsProvider>
        <DialogProvider>
          <StartupUpdateCheck />
        </DialogProvider>
      </SettingsProvider>
    </PlatformProvider>
  )
}

/** Customize → General's update row, with the same contexts. Both surfaces read
 * one notice, so a test can compare what they say about the same offer.
 * `services` stands in for the app's GlobalSDK context on a desktop platform,
 * where the panel also renders the command-line row — pass a real local
 * server's URL rather than mounting the full event-stream provider. */
export function createGeneralFixture(platform: Platform, services?: CommandLineServices) {
  return () => (
    <PlatformProvider value={platform}>
      <LanguageProvider>
        <ThemeProvider>
          <SettingsProvider>
            <DialogProvider>
              <AppearanceSections services={services} />
            </DialogProvider>
          </SettingsProvider>
        </ThemeProvider>
      </LanguageProvider>
    </PlatformProvider>
  )
}
