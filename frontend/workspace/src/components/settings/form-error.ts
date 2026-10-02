import { dict } from "@/i18n/en"

type Key = Extract<keyof typeof dict, `settings.validation.${string}`>
export class ConnectorFormError extends Error {
  constructor(
    readonly key: Key,
    readonly values: Record<string, string> = {},
    fallback?: string,
  ) {
    super(
      fallback ??
        Object.entries(values).reduce(
          (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
          dict[key] as string,
        ),
    )
  }
}
