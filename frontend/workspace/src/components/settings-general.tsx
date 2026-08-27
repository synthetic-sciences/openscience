import { Component, For, Show, createMemo, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { useTheme, type ColorScheme } from "@synsci/ui/theme"
import { showToast } from "@synsci/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { playSound, SOUND_OPTIONS } from "@/utils/sound"
import { URLS } from "@/config/urls"
import { PanelBody, PanelHeader, PanelScroll, Section as SettingsSection } from "./settings/_shared"
import "./settings-general.css"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const playDemoSound = (src: string, volume: number) => {
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }

  clearTimeout(demoSoundState.timeout)

  demoSoundState.timeout = setTimeout(() => {
    demoSoundState.cleanup = playSound(src, volume)
  }, 100)
}

// The appearance / notification / sound / update controls, without any
// outer scroll wrapper or header — so the new General settings panel can compose
// them below its Account / Model / Licensing sections. `SettingsGeneral` below
// keeps the standalone panel (scroll + header) for any legacy mount.
export const AppearanceSections: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()

  onCleanup(() => {
    clearTimeout(demoSoundState.timeout)
    demoSoundState.cleanup?.()
    demoSoundState = { cleanup: undefined, timeout: undefined }
  })

  const [store, setStore] = createStore<{
    checking: boolean
    installing: boolean
    available?: string
  }>({
    checking: false,
    installing: false,
  })

  const install = () => {
    if (!platform.update || store.installing) return
    setStore("installing", true)
    void platform
      .update()
      .then((result) => {
        setStore("installing", false)
        setStore("available", undefined)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: result.installed ? `OpenScience ${result.version ?? ""} installed` : "OpenScience is up to date",
          description: result.restartRequired
            ? "Restart the OpenScience command to finish the update."
            : "You're running the latest version of OpenScience.",
        })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        showToast({ title: language.t("common.requestFailed"), description: message })
        setStore("installing", false)
      })
  }

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)

    void platform
      .checkUpdate({ refresh: true })
      .then((result) => {
        if (!result.updateAvailable) {
          setStore("available", undefined)
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        setStore("available", result.version ?? "Update available")

        const actions = platform.update
          ? [
              {
                label: "Install update",
                onClick: install,
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

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const themeOptions = createMemo(() =>
    Object.values(theme.themes())
      .map((item) => ({ value: item.id, label: item.name }))
      .sort((a, b) =>
        a.value === "openscience" ? -1 : b.value === "openscience" ? 1 : a.label.localeCompare(b.label),
      ),
  )

  const soundOptions = [...SOUND_OPTIONS]

  return (
    <>
      <SettingsSection title={language.t("settings.general.section.appearance")}>
        <div class="settings-card">
          <SettingsRow title="Theme" description="Choose a complete color system for the workspace.">
            <Select
              aria-label="Theme"
              options={themeOptions()}
              current={themeOptions().find((option) => option.value === theme.themeId())}
              value={(option) => option.value}
              label={(option) => option.label}
              onSelect={(option) => option && theme.setTheme(option.value)}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.appearance.title")}
            description={language.t("settings.general.row.appearance.description")}
          >
            <div
              role="group"
              aria-label={language.t("settings.general.row.appearance.title")}
              class="inline-flex max-w-full items-center rounded-md border border-border-weak-base bg-surface-base p-0.5"
            >
              <For each={colorSchemeOptions()}>
                {(option) => (
                  <button
                    type="button"
                    aria-pressed={theme.colorScheme() === option.value}
                    class="h-8 min-w-[56px] rounded-sm px-2.5 text-12-medium text-text-weak transition-colors duration-150 hover:text-text-strong focus-visible:z-10"
                    classList={{
                      "bg-surface-raised-strong text-text-strong shadow-xs": theme.colorScheme() === option.value,
                    }}
                    onClick={() => theme.setColorScheme(option.value)}
                  >
                    {option.label}
                  </button>
                )}
              </For>
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.language.title")}
            description={language.t("settings.general.row.language.description")}
          >
            <Select
              aria-label={language.t("settings.general.row.language.title")}
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
        </div>
      </SettingsSection>

      <SettingsSection title={language.t("settings.general.section.notifications")}>
        <div class="settings-card">
          <SettingsRow
            title={language.t("settings.general.notifications.agent.title")}
            description={language.t("settings.general.notifications.agent.description")}
          >
            <Switch
              hideLabel
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            >
              {language.t("settings.general.notifications.agent.title")}
            </Switch>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.notifications.permissions.title")}
            description={language.t("settings.general.notifications.permissions.description")}
          >
            <Switch
              hideLabel
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            >
              {language.t("settings.general.notifications.permissions.title")}
            </Switch>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.notifications.errors.title")}
            description={language.t("settings.general.notifications.errors.description")}
          >
            <Switch
              hideLabel
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            >
              {language.t("settings.general.notifications.errors.title")}
            </Switch>
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title={language.t("settings.general.section.sounds")}>
        <div class="settings-card">
          <SettingsRow
            title={language.t("settings.general.sounds.enabled.title")}
            description={language.t("settings.general.sounds.enabled.description")}
          >
            <Switch
              hideLabel
              checked={settings.sounds.enabled()}
              onChange={(checked) => settings.sounds.setEnabled(checked)}
            >
              {language.t("settings.general.sounds.enabled.title")}
            </Switch>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.sounds.volume.title")}
            description={language.t("settings.general.sounds.volume.description")}
          >
            <label class="settings-sound-volume">
              <span class="sr-only">{language.t("settings.general.sounds.volume.title")}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.sounds.volume()}
                disabled={!settings.sounds.enabled()}
                aria-valuetext={`${Math.round(settings.sounds.volume() * 100)}%`}
                onInput={(event) => settings.sounds.setVolume(Number(event.currentTarget.value))}
              />
              <output aria-live="polite">{Math.round(settings.sounds.volume() * 100)}%</output>
            </label>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.sounds.agent.title")}
            description={language.t("settings.general.sounds.agent.description")}
          >
            <Select
              aria-label={language.t("settings.general.sounds.agent.title")}
              disabled={!settings.sounds.enabled()}
              options={soundOptions}
              current={soundOptions.find((o) => o.id === settings.sounds.agent())}
              value={(o) => o.id}
              label={(o) => language.t(o.label)}
              onHighlight={(option) => {
                if (!option) return
                playDemoSound(option.src, settings.sounds.volume())
              }}
              onSelect={(option) => {
                if (!option) return
                settings.sounds.setAgent(option.id)
                playDemoSound(option.src, settings.sounds.volume())
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
              aria-label={language.t("settings.general.sounds.permissions.title")}
              disabled={!settings.sounds.enabled()}
              options={soundOptions}
              current={soundOptions.find((o) => o.id === settings.sounds.permissions())}
              value={(o) => o.id}
              label={(o) => language.t(o.label)}
              onHighlight={(option) => {
                if (!option) return
                playDemoSound(option.src, settings.sounds.volume())
              }}
              onSelect={(option) => {
                if (!option) return
                settings.sounds.setPermissions(option.id)
                playDemoSound(option.src, settings.sounds.volume())
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
              aria-label={language.t("settings.general.sounds.errors.title")}
              disabled={!settings.sounds.enabled()}
              options={soundOptions}
              current={soundOptions.find((o) => o.id === settings.sounds.errors())}
              value={(o) => o.id}
              label={(o) => language.t(o.label)}
              onHighlight={(option) => {
                if (!option) return
                playDemoSound(option.src, settings.sounds.volume())
              }}
              onSelect={(option) => {
                if (!option) return
                settings.sounds.setErrors(option.id)
                playDemoSound(option.src, settings.sounds.volume())
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title={language.t("settings.general.section.updates")}>
        <div class="settings-card">
          <SettingsRow
            title={language.t("settings.updates.row.startup.title")}
            description={language.t("settings.updates.row.startup.description")}
          >
            <Switch
              hideLabel
              checked={settings.updates.startup()}
              disabled={!platform.checkUpdate}
              onChange={(checked) => settings.updates.setStartup(checked)}
            >
              {language.t("settings.updates.row.startup.title")}
            </Switch>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.releaseNotes.title")}
            description={language.t("settings.general.row.releaseNotes.description")}
          >
            <div class="flex max-w-full flex-wrap items-center justify-end gap-2">
              <Button size="small" variant="secondary" onClick={() => platform.openLink(URLS.releases)}>
                View notes
              </Button>
              <Switch
                hideLabel
                checked={settings.general.releaseNotes()}
                onChange={(checked) => settings.general.setReleaseNotes(checked)}
              >
                {language.t("settings.general.row.releaseNotes.title")}
              </Switch>
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.updates.row.check.title")}
            description={language.t("settings.updates.row.check.description")}
          >
            <div class="flex max-w-full flex-wrap items-center justify-end gap-2">
              <Show when={store.available && platform.update}>
                <Button size="small" variant="primary" disabled={store.installing} onClick={install}>
                  {store.installing ? "Installing…" : `Install ${store.available}`}
                </Button>
              </Show>
              <Button
                size="small"
                variant="secondary"
                disabled={store.checking || !platform.checkUpdate}
                onClick={check}
              >
                {store.checking
                  ? language.t("settings.updates.action.checking")
                  : language.t("settings.updates.action.checkNow")}
              </Button>
            </div>
          </SettingsRow>
        </div>
      </SettingsSection>
    </>
  )
}

// Standalone General appearance panel (scroll + header). Retained for any legacy
// mount; the primary General settings panel composes AppearanceSections directly.
export const SettingsGeneral: Component = () => {
  const language = useLanguage()
  return (
    <PanelScroll>
      <PanelHeader title={language.t("settings.tab.general")} description="Appearance, notifications, and updates." />
      <PanelBody>
        <AppearanceSections />
      </PanelBody>
    </PanelScroll>
  )
}

interface SettingsRowProps {
  title: string
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="settings-row justify-between">
      <div class="flex min-w-0 flex-1 basis-[220px] flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="ml-auto max-w-full flex-shrink-0">{props.children}</div>
    </div>
  )
}
