import { DialogProvider } from "@synsci/ui/context/dialog"
import { ThemeProvider } from "@synsci/ui/theme"
import { PlatformProvider, type Platform } from "@/context/platform"
import { LanguageProvider } from "@/context/language"
import { SettingsProvider } from "@/context/settings"
import { AppearanceSections } from "../settings-general"
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
 * one notice, so a test can compare what they say about the same offer. */
export function createGeneralFixture(platform: Platform) {
  return () => (
    <PlatformProvider value={platform}>
      <LanguageProvider>
        <ThemeProvider>
          <SettingsProvider>
            <DialogProvider>
              <AppearanceSections />
            </DialogProvider>
          </SettingsProvider>
        </ThemeProvider>
      </LanguageProvider>
    </PlatformProvider>
  )
}
