import { Show, createResource } from "solid-js"
import { Button } from "@synsci/ui/button"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"

export function SearchConnections() {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const [status, { refetch }] = createResource(async () => (await sdk.client.settings.search()).data!)
  return (
    <section class="models-provider-keys" aria-label={language.t("settings.search.title")}>
      <div class="settings-row models-compact-row">
        <div class="models-provider-copy">
          <span class="text-14-medium text-text-strong">{language.t("settings.search.title")}</span>
          <span class="text-12-regular text-text-weak">{language.t("settings.search.independent")}</span>
        </div>
        <Button size="small" variant="secondary" disabled={status.loading} onClick={() => void refetch()}>
          {language.t("settings.search.refresh")}
        </Button>
      </div>
      <div class="models-provider-copy text-12-regular text-text-weak" aria-live="polite">
        <Show when={!status.loading} fallback={<p>{language.t("settings.search.loading")}</p>}>
          <p>
            {language.t(
              status.error
                ? "settings.search.error"
                : status()?.configured
                  ? "settings.search.configured"
                  : "settings.search.missing",
            )}
          </p>
        </Show>
        <p>{language.t("settings.search.builtin")}</p>
        <p>{language.t("settings.search.mcp")}</p>
        <p>{language.t("settings.search.limits")}</p>
      </div>
    </section>
  )
}
