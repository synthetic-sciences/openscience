import { Component, For, Show, createMemo, onCleanup, onMount, type JSX } from "solid-js"
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
import { formatUpdateBytes, updateController } from "./settings/update-controller"
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

  const updates = updateController(platform)
  const [store, setStore] = createStore<{
    releases: Array<{ version: string; name: string; notes: string; publishedAt?: string; url: string }>
  }>({ releases: [] })

  onMount(() => {
    updates.start()
    void platform
      .listUpdates?.()
      .then((releases) => setStore("releases", releases))
      .catch(() => undefined)
  })

  const check = () => {
    if (!platform.checkUpdate) return
    void updates
      .check()
      .then((result) => {
        if (!result?.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }
        showToast({
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const updateAction = () => {
    const run =
      updates.state.phase === "ready" || updates.state.phase === "restart_blocked" ? updates.apply : updates.stage
    void run().catch((error: unknown) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const cancelUpdate = () => {
    void updates.cancel().catch((error: unknown) => {
      showToast({
        title: "OpenScience kept the update",
        description: error instanceof Error ? error.message : String(error),
      })
    })
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
              class="settings-segmented-control"
            >
              <For each={colorSchemeOptions()}>
                {(option) => (
                  <button
                    type="button"
                    aria-pressed={theme.colorScheme() === option.value}
                    class="settings-segmented-control__option"
                    data-selected={theme.colorScheme() === option.value ? "true" : undefined}
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
            description={
              updates.state.phase === "ready"
                ? updates.state.migration_required
                  ? `OpenScience ${updates.state.version} is verified. It will move to your user Applications folder before restarting because this installation is administrator-owned.`
                  : `OpenScience ${updates.state.version} is signed, verified, and ready to restart.`
                : updates.state.phase === "succeeded"
                  ? `Updated to OpenScience ${updates.state.version}. The relaunched workspace passed its health check.`
                  : updates.state.phase === "restarting"
                    ? `Restarting into OpenScience ${updates.state.version}. The app will reopen automatically.`
                    : updates.state.phase === "restart_blocked"
                      ? (updates.state.error ?? "OpenScience is waiting for the local runtime to finish safely.")
                      : updates.state.phase === "downloading"
                        ? `${formatUpdateBytes(updates.state.transferred)}${updates.state.total ? ` of ${formatUpdateBytes(updates.state.total)}` : ""} downloaded.`
                        : ["extracting", "verifying"].includes(updates.state.phase)
                          ? "Verifying the signed, notarized app before restart."
                          : updates.state.phase === "failed"
                            ? (updates.state.error ?? "The update could not be prepared.")
                            : language.t("settings.updates.row.check.description")
            }
          >
            <div class="flex max-w-full flex-wrap items-center justify-end gap-2">
              <Show when={updates.state.available && platform.stageUpdate}>
                <Button
                  size="small"
                  variant="primary"
                  disabled={["downloading", "extracting", "verifying", "restarting"].includes(updates.state.phase)}
                  onClick={updateAction}
                >
                  {updates.state.phase === "ready"
                    ? updates.state.migration_required
                      ? "Move & restart"
                      : "Restart to update"
                    : updates.state.phase === "restarting"
                      ? "Restarting…"
                      : updates.state.phase === "restart_blocked"
                        ? "Retry restart"
                        : ["downloading", "extracting", "verifying"].includes(updates.state.phase)
                          ? "Preparing…"
                          : updates.state.phase === "failed"
                            ? "Retry download"
                            : `Download ${updates.state.available}`}
                </Button>
              </Show>
              <Show when={updates.state.available && !platform.stageUpdate}>
                <Button size="small" variant="primary" onClick={() => platform.openLink(URLS.releases)}>
                  Download installer
                </Button>
              </Show>
              <Show
                when={
                  platform.cancelUpdate &&
                  ["downloading", "extracting", "verifying", "ready"].includes(updates.state.phase)
                }
              >
                <Button size="small" variant="secondary" disabled={updates.state.cancelling} onClick={cancelUpdate}>
                  {updates.state.cancelling
                    ? "Discarding…"
                    : updates.state.phase === "ready"
                      ? "Discard"
                      : "Cancel download"}
                </Button>
              </Show>
              <Button
                size="small"
                variant="secondary"
                disabled={updates.state.checking || !platform.checkUpdate}
                onClick={check}
              >
                {updates.state.checking
                  ? language.t("settings.updates.action.checking")
                  : language.t("settings.updates.action.checkNow")}
              </Button>
            </div>
          </SettingsRow>
        </div>
        <Show when={store.releases.length > 0}>
          <div class="settings-card settings-update-history" aria-label="Recent OpenScience releases">
            <For each={store.releases.slice(0, 3)}>
              {(release) => (
                <button
                  type="button"
                  class="settings-row"
                  data-interactive="true"
                  onClick={() => platform.openLink(release.url)}
                >
                  <span>
                    <strong>{release.name}</strong>
                    <small>
                      {release.notes
                        .split("\n")
                        .find((line) => line.trim())
                        ?.replace(/^#+\s*/, "")}
                    </small>
                  </span>
                  <time datetime={release.publishedAt}>
                    {release.publishedAt
                      ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
                          new Date(release.publishedAt),
                        )
                      : release.version}
                  </time>
                </button>
              )}
            </For>
          </div>
        </Show>
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
