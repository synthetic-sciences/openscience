import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@synsci/ui/context"
import { Persist, persisted } from "@/utils/persist"
// English (default + fallback) stays eager so first paint has strings instantly.
// Every OTHER locale is a per-language dynamic chunk, loaded only when that
// language is actually selected — this keeps ~130KB gzip of translations out of
// the entry chunk (measured). Switching language loads its chunk on demand and
// the UI updates reactively; until then it falls back to English.
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@synsci/ui/i18n/en"

export type Locale =
  | "en"
  | "zh"
  | "zht"
  | "ko"
  | "de"
  | "es"
  | "fr"
  | "da"
  | "ja"
  | "pl"
  | "ru"
  | "ar"
  | "no"
  | "br"
  | "th"

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>

const LOCALES: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "ar",
  "no",
  "br",
  "th",
]

type NonEn = Exclude<Locale, "en">
// Static-string dynamic imports so Vite emits one chunk per language.
const APP_DICTS: Record<NonEn, () => Promise<{ dict: unknown }>> = {
  zh: () => import("@/i18n/zh"),
  zht: () => import("@/i18n/zht"),
  ko: () => import("@/i18n/ko"),
  de: () => import("@/i18n/de"),
  es: () => import("@/i18n/es"),
  fr: () => import("@/i18n/fr"),
  da: () => import("@/i18n/da"),
  ja: () => import("@/i18n/ja"),
  pl: () => import("@/i18n/pl"),
  ru: () => import("@/i18n/ru"),
  ar: () => import("@/i18n/ar"),
  no: () => import("@/i18n/no"),
  br: () => import("@/i18n/br"),
  th: () => import("@/i18n/th"),
}
const UI_DICTS: Record<NonEn, () => Promise<{ dict: unknown }>> = {
  zh: () => import("@synsci/ui/i18n/zh"),
  zht: () => import("@synsci/ui/i18n/zht"),
  ko: () => import("@synsci/ui/i18n/ko"),
  de: () => import("@synsci/ui/i18n/de"),
  es: () => import("@synsci/ui/i18n/es"),
  fr: () => import("@synsci/ui/i18n/fr"),
  da: () => import("@synsci/ui/i18n/da"),
  ja: () => import("@synsci/ui/i18n/ja"),
  pl: () => import("@synsci/ui/i18n/pl"),
  ru: () => import("@synsci/ui/i18n/ru"),
  ar: () => import("@synsci/ui/i18n/ar"),
  no: () => import("@synsci/ui/i18n/no"),
  br: () => import("@synsci/ui/i18n/br"),
  th: () => import("@synsci/ui/i18n/th"),
}

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) {
      if (language.toLowerCase().includes("hant")) return "zht"
      return "zh"
    }
    if (language.toLowerCase().startsWith("ko")) return "ko"
    if (language.toLowerCase().startsWith("de")) return "de"
    if (language.toLowerCase().startsWith("es")) return "es"
    if (language.toLowerCase().startsWith("fr")) return "fr"
    if (language.toLowerCase().startsWith("da")) return "da"
    if (language.toLowerCase().startsWith("ja")) return "ja"
    if (language.toLowerCase().startsWith("pl")) return "pl"
    if (language.toLowerCase().startsWith("ru")) return "ru"
    if (language.toLowerCase().startsWith("ar")) return "ar"
    if (
      language.toLowerCase().startsWith("no") ||
      language.toLowerCase().startsWith("nb") ||
      language.toLowerCase().startsWith("nn")
    )
      return "no"
    if (language.toLowerCase().startsWith("pt")) return "br"
    if (language.toLowerCase().startsWith("th")) return "th"
  }

  return "en"
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  init: () => {
    const [store, setStore, _, ready] = persisted(
      Persist.global("language", ["language.v1"]),
      createStore({
        locale: detectLocale() as Locale,
      }),
    )

    const locale = createMemo<Locale>(() =>
      (LOCALES as readonly string[]).includes(store.locale) ? (store.locale as Locale) : "en",
    )

    createEffect(() => {
      const current = locale()
      if (store.locale === current) return
      setStore("locale", current)
    })

    const base = i18n.flatten({ ...en, ...uiEn }) as Dictionary
    // Loaded dictionaries by locale; English is always present. Others populate
    // asynchronously the first time their language is selected.
    const [dicts, setDicts] = createSignal<Partial<Record<Locale, Dictionary>>>({ en: base })

    createEffect(() => {
      const l = locale()
      if (l === "en" || dicts()[l]) return
      Promise.all([APP_DICTS[l](), UI_DICTS[l]()])
        .then(([app, ui]) => {
          const merged = {
            ...base,
            ...i18n.flatten({ ...(app.dict as RawDictionary), ...(ui as { dict: RawDictionary }).dict }),
          } as Dictionary
          setDicts((prev) => ({ ...prev, [l]: merged }))
        })
        .catch(() => {
          /* keep English fallback on load failure */
        })
    })

    // Falls back to English until the active locale's chunk resolves.
    const dict = createMemo<Dictionary>(() => dicts()[locale()] ?? base)

    const t = i18n.translator(dict, i18n.resolveTemplate)

    const labelKey: Record<Locale, keyof Dictionary> = {
      en: "language.en",
      zh: "language.zh",
      zht: "language.zht",
      ko: "language.ko",
      de: "language.de",
      es: "language.es",
      fr: "language.fr",
      da: "language.da",
      ja: "language.ja",
      pl: "language.pl",
      ru: "language.ru",
      ar: "language.ar",
      no: "language.no",
      br: "language.br",
      th: "language.th",
    }

    const label = (value: Locale) => t(labelKey[value])

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.lang = locale()
    })

    return {
      ready,
      locale,
      locales: LOCALES,
      label,
      t,
      setLocale(next: Locale) {
        setStore("locale", next)
      },
    }
  },
})
