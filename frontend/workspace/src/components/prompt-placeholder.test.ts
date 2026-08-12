import { describe, expect, test } from "bun:test"
import { dict as ar } from "@/i18n/ar"
import { dict as br } from "@/i18n/br"
import { dict as da } from "@/i18n/da"
import { dict as de } from "@/i18n/de"
import { dict as en } from "@/i18n/en"
import { dict as es } from "@/i18n/es"
import { dict as fr } from "@/i18n/fr"
import { dict as ja } from "@/i18n/ja"
import { dict as ko } from "@/i18n/ko"
import { dict as no } from "@/i18n/no"
import { dict as pl } from "@/i18n/pl"
import { dict as ru } from "@/i18n/ru"
import { dict as th } from "@/i18n/th"
import { dict as zh } from "@/i18n/zh"
import { dict as zht } from "@/i18n/zht"

const source = await Bun.file(new URL("./prompt-input.tsx", import.meta.url)).text()
const locales = { ar, br, da, de, en, es, fr, ja, ko, no, pl, ru, th, zh, zht }

describe("research composer placeholder", () => {
  test("uses one stable research-task prompt instead of rotating software examples", () => {
    expect(source).not.toContain("const EXAMPLES")
    expect(source).not.toContain("prompt.example.")
    expect(source).not.toContain('setStore("placeholder"')
    expect(source).not.toContain("Math.floor(Math.random()")
    expect(source).toContain('return language.t("prompt.placeholder.normal")')
    expect(en["prompt.placeholder.normal"]).toBe("Describe the research task you want to work through…")
  })

  test("keeps every locale deterministic and free of example interpolation", () => {
    for (const dict of Object.values(locales)) {
      const placeholder = dict["prompt.placeholder.normal"]
      expect(placeholder).not.toContain("{{example}}")
      expect(placeholder).toEndWith("…")
      expect(Object.keys(dict).some((key) => key.startsWith("prompt.example."))).toBe(false)
    }
  })

  test("derives the visible and accessible labels from the same mode-aware value", () => {
    expect(source).toContain('if (store.mode === "shell") return language.t("prompt.placeholder.shell")')
    expect(source).toContain('if (commentCount() > 1) return language.t("prompt.placeholder.summarizeComments")')
    expect(source).toContain('if (commentCount() === 1) return language.t("prompt.placeholder.summarizeComment")')
    expect(source).toContain("aria-label={placeholder()}")
    expect(source).toContain('class="workspace-composer__placeholder" aria-hidden="true" dir="auto"')
  })
})
