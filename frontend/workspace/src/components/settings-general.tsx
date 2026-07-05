import { Component, For, createMemo, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { useTheme, type ColorScheme } from "@synsci/ui/theme"
import { showToast } from "@synsci/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings, monoFontFamily } from "@/context/settings"
import { playSound, SOUND_OPTIONS } from "@/utils/sound"
import { URLS } from "@/config/urls"
import { Link } from "./link"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const playDemoSound = (src: string) => {
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }

  clearTimeout(demoSoundState.timeout)

  demoSoundState.timeout = setTimeout(() => {
    demoSoundState.cleanup = playSound(src)
  }, 100)
}

// The appearance / theme / notification / sound / update controls, without any
// outer scroll wrapper or header — so the new General settings panel can compose
// them below its Account / Model / Licensing sections. `SettingsGeneral` below
// keeps the standalone panel (scroll + header) for any legacy mount.
export const AppearanceSections: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()

  const [store, setStore] = createStore({
    checking: false,
  })

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)

    void platform
      .checkUpdate()
      .then((result) => {
        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        const actions =
          platform.update && platform.restart
            ? [
                {
                  label: language.t("toast.update.action.installRestart"),
                  onClick: async () => {
                    await platform.update!()
                    await platform.restart!()
                  },
                },
                {
                  label: language.t("toast.update.action.notYet"),
                  onClick: "dismiss" as const,
                },
              ]
            : [
                {
                  label: language.t("toast.update.action.notYet"),
                  onClick: "dismiss" as const,
                },
              ]

        showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
          actions,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setStore("checking", false))
  }

  // Swatch data for the theme picker — pull representative seed colors from the
  // active mode's variant so each swatch previews how the theme actually looks.
  const themeSwatches = createMemo(() => {
    const mode = theme.mode()
    return Object.entries(theme.themes()).map(([id, def]) => {
      const variant = mode === "dark" ? def.dark : def.light
      const seeds = variant?.seeds
      return {
        id,
        name: def.name ?? id,
        bg: seeds?.neutral ?? "#111111",
        dots: [
          seeds?.primary ?? seeds?.interactive ?? "#888888",
          seeds?.info ?? "#6ea8fe",
          seeds?.success ?? "#38b000",
          seeds?.warning ?? "#f7a14d",
        ],
      }
    })
  })

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const fontOptions = [
    { value: "ibm-plex-mono", label: "font.option.ibmPlexMono" },
    { value: "cascadia-code", label: "font.option.cascadiaCode" },
    { value: "fira-code", label: "font.option.firaCode" },
    { value: "hack", label: "font.option.hack" },
    { value: "inconsolata", label: "font.option.inconsolata" },
    { value: "intel-one-mono", label: "font.option.intelOneMono" },
    { value: "iosevka", label: "font.option.iosevka" },
    { value: "jetbrains-mono", label: "font.option.jetbrainsMono" },
    { value: "meslo-lgs", label: "font.option.mesloLgs" },
    { value: "roboto-mono", label: "font.option.robotoMono" },
    { value: "source-code-pro", label: "font.option.sourceCodePro" },
    { value: "ubuntu-mono", label: "font.option.ubuntuMono" },
  ] as const
  const fontOptionsList = [...fontOptions]

  const soundOptions = [...SOUND_OPTIONS]

  return (
    <div class="flex flex-col gap-8 w-full max-w-[760px]">
      {/* Appearance Section */}
      <div class="flex flex-col gap-3">
        <h3 class="text-13-medium text-text-weak tracking-wide">{language.t("settings.general.section.appearance")}</h3>

        <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
          <SettingsRow
            title={language.t("settings.general.row.language.title")}
            description={language.t("settings.general.row.language.description")}
          >
            <Select
              options={languageOptions()}
              current={languageOptions().find((o) => o.value === language.locale())}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => option && language.setLocale(option.value)}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.appearance.title")}
            description={language.t("settings.general.row.appearance.description")}
          >
            <div class="inline-flex items-center gap-0.5 p-0.5 rounded-xs border border-border-weak-base bg-surface-base">
              <For each={colorSchemeOptions()}>
                {(option) => (
                  <button
                    type="button"
                    class="h-7 px-3 rounded-xs text-13-medium transition-colors"
                    classList={{
                      "bg-surface-raised-base-active text-text-strong shadow-xs": theme.colorScheme() === option.value,
                      "text-text-weak hover:text-text-strong": theme.colorScheme() !== option.value,
                    }}
                    onClick={() => theme.setColorScheme(option.value)}
                    onMouseEnter={() => theme.previewColorScheme(option.value)}
                    onMouseLeave={() => theme.cancelPreview()}
                  >
                    {option.label}
                  </button>
                )}
              </For>
            </div>
          </SettingsRow>
        </div>
      </div>

      {/* Theme Section */}
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-0.5">
          <h3 class="text-13-medium text-text-weak tracking-wide">{language.t("settings.general.row.theme.title")}</h3>
          <p class="text-12-regular text-text-weak">
            {language.t("settings.general.row.theme.description")}{" "}
            <Link href={URLS.docsThemes}>{language.t("common.learnMore")}</Link>
          </p>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <For each={themeSwatches()}>
            {(swatch) => (
              <button
                type="button"
                class="group flex flex-col gap-2 p-2 rounded-[4px] text-left transition-all"
                style={{
                  border:
                    theme.themeId() === swatch.id
                      ? "2px solid var(--color-text-interactive-base, var(--color-text-strong))"
                      : "2px solid var(--color-border-weak-base)",
                  background:
                    theme.themeId() === swatch.id
                      ? "var(--color-surface-raised-base-active, transparent)"
                      : "transparent",
                }}
                onClick={() => theme.setTheme(swatch.id)}
                onMouseEnter={() => theme.previewTheme(swatch.id)}
                onMouseLeave={() => theme.cancelPreview()}
              >
                <div
                  class="h-14 rounded-xs flex items-center gap-1.5 px-3"
                  style={{
                    background: swatch.bg,
                    "box-shadow": "inset 0 0 0 1px rgba(128,128,128,0.18)",
                  }}
                >
                  <For each={swatch.dots}>
                    {(dot) => (
                      <span
                        class="size-3.5 rounded-full"
                        style={{ background: dot, "box-shadow": "0 1px 2px rgba(0,0,0,0.25)" }}
                      />
                    )}
                  </For>
                </div>
                <span class="text-12-medium text-text-strong px-1 truncate">{swatch.name}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Layout Section */}
      <div class="flex flex-col gap-1">
        <h3 class="text-13-medium text-text-weak tracking-wide pb-2">
          {language.t("settings.general.section.layout")}
        </h3>

        <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
          <SettingsRow
            title={language.t("settings.general.layout.showChanges.title")}
            description={language.t("settings.general.layout.showChanges.description")}
          >
            <Switch
              checked={settings.ui.showChangesView()}
              onChange={(checked) => settings.ui.setShowChangesView(checked)}
            />
          </SettingsRow>
        </div>
      </div>

      {/* System notifications Section */}
      <div class="flex flex-col gap-1">
        <h3 class="text-13-medium text-text-weak tracking-wide pb-2">
          {language.t("settings.general.section.notifications")}
        </h3>

        <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
          <SettingsRow
            title={language.t("settings.general.notifications.agent.title")}
            description={language.t("settings.general.notifications.agent.description")}
          >
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.notifications.permissions.title")}
            description={language.t("settings.general.notifications.permissions.description")}
          >
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.notifications.errors.title")}
            description={language.t("settings.general.notifications.errors.description")}
          >
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </SettingsRow>
        </div>
      </div>

      {/* Sound effects Section */}
      <div class="flex flex-col gap-1">
        <h3 class="text-13-medium text-text-weak tracking-wide pb-2">
          {language.t("settings.general.section.sounds")}
        </h3>

        <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
          <SettingsRow
            title={language.t("settings.general.sounds.agent.title")}
            description={language.t("settings.general.sounds.agent.description")}
          >
            <Select
              options={soundOptions}
              current={soundOptions.find((o) => o.id === settings.sounds.agent())}
              value={(o) => o.id}
              label={(o) => language.t(o.label)}
              onHighlight={(option) => {
                if (!option) return
                playDemoSound(option.src)
              }}
              onSelect={(option) => {
                if (!option) return
                settings.sounds.setAgent(option.id)
                playDemoSound(option.src)
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.sounds.permissions.title")}
            description={language.t("settings.general.sounds.permissions.description")}
          >
            <Select
              options={soundOptions}
              current={soundOptions.find((o) => o.id === settings.sounds.permissions())}
              value={(o) => o.id}
              label={(o) => language.t(o.label)}
              onHighlight={(option) => {
                if (!option) return
                playDemoSound(option.src)
              }}
              onSelect={(option) => {
                if (!option) return
                settings.sounds.setPermissions(option.id)
                playDemoSound(option.src)
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.sounds.errors.title")}
            description={language.t("settings.general.sounds.errors.description")}
          >
            <Select
              options={soundOptions}
              current={soundOptions.find((o) => o.id === settings.sounds.errors())}
              value={(o) => o.id}
              label={(o) => language.t(o.label)}
              onHighlight={(option) => {
                if (!option) return
                playDemoSound(option.src)
              }}
              onSelect={(option) => {
                if (!option) return
                settings.sounds.setErrors(option.id)
                playDemoSound(option.src)
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>
        </div>
      </div>

      {/* Updates Section */}
      <div class="flex flex-col gap-1">
        <h3 class="text-13-medium text-text-weak tracking-wide pb-2">
          {language.t("settings.general.section.updates")}
        </h3>

        <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
          <SettingsRow
            title={language.t("settings.updates.row.startup.title")}
            description={language.t("settings.updates.row.startup.description")}
          >
            <Switch
              checked={settings.updates.startup()}
              disabled={!platform.checkUpdate}
              onChange={(checked) => settings.updates.setStartup(checked)}
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.releaseNotes.title")}
            description={language.t("settings.general.row.releaseNotes.description")}
          >
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.updates.row.check.title")}
            description={language.t("settings.updates.row.check.description")}
          >
            <Button size="small" variant="secondary" disabled={store.checking || !platform.checkUpdate} onClick={check}>
              {store.checking
                ? language.t("settings.updates.action.checking")
                : language.t("settings.updates.action.checkNow")}
            </Button>
          </SettingsRow>
        </div>
      </div>
    </div>
  )
}

// Standalone General appearance panel (scroll + header). Retained for any legacy
// mount; the primary General settings panel composes AppearanceSections directly.
export const SettingsGeneral: Component = () => {
  const language = useLanguage()
  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-8 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-8 pb-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.general")}</h2>
        </div>
      </div>
      <AppearanceSections />
    </div>
  )
}

interface SettingsRowProps {
  title: string
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}
