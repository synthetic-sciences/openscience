import { lazy, type Component } from "solid-js"
import type { IconProps } from "@synsci/ui/icon"
import type { TranslationKey } from "@/context/language"

// ── Panel contract ──────────────────────────────────────────────────────────
//
// Every settings panel is a lazily-loaded SolidJS component keyed by a stable
// `id`. Panel authors own exactly one file — `components/settings/<Panel>.tsx`
// — and `export default` a `Component`. The shell (dialog-settings.tsx) renders
// the header (back/forward + title + expand/close) and the left rail from this
// registry; the panel component only renders its own scrollable body.
//
// To add real behaviour a panel either:
//   • calls an existing local-server endpoint via the SDK (`useSDK().client.*`
//     or `useGlobalSDK().client.*`), or
//   • ships a NEW minimal backend route at
//     `backend/cli/src/server/routes/settings/<name>.ts` (export a Hono route;
//     mount it in `backend/cli/src/server/server.ts`) that persists to a JSON
//     config store — so the control does something real.
//
// HARD RULE: no dead buttons. A panel either wires to a real backend or omits
// the control. Placeholder panels below ship with zero interactive controls.

export type SettingsSection = "capabilities" | "workspace"

export type SettingsPanelId =
  | "connectors"
  | "specialists"
  | "memory"
  | "compute"
  | "local-models"
  | "network"
  | "permissions"
  | "sandbox"
  | "credentials"
  | "billing"
  | "storage"
  | "general"

export interface SettingsPanel {
  /** Stable key used for routing/history. */
  id: SettingsPanelId
  /** Title shown in the shell header + rail label. */
  title: TranslationKey
  /** Icon name from `@synsci/ui/icon`. */
  icon: IconProps["name"]
  /** Which rail group the row lives under. */
  section: SettingsSection
  /** Lazily-loaded panel body (default export of the file). */
  component: Component
}

// Order here is the render order in the rail (top→bottom within each section).
export const SETTINGS_PANELS: SettingsPanel[] = [
  // ── Capabilities ──
  // Skills moved to a dedicated center-pane tab (atlas/SkillsPage) — it's a
  // first-class catalog now, not a settings row.
  {
    id: "connectors",
    title: "settings.panel.connectors",
    icon: "mcp",
    section: "capabilities",
    component: lazy(() => import("./Connectors")),
  },
  {
    id: "specialists",
    title: "settings.panel.specialists",
    icon: "models",
    section: "capabilities",
    component: lazy(() => import("./Specialists")),
  },
  {
    id: "memory",
    title: "settings.panel.memory",
    icon: "archive",
    section: "capabilities",
    component: lazy(() => import("./Memory")),
  },
  {
    id: "compute",
    title: "settings.panel.compute",
    icon: "server",
    section: "capabilities",
    component: lazy(() => import("./Compute")),
  },
  {
    id: "local-models",
    title: "settings.panel.localModels",
    icon: "models",
    section: "capabilities",
    component: lazy(() => import("./LocalModels")),
  },
  {
    id: "network",
    title: "settings.panel.network",
    icon: "share",
    section: "capabilities",
    component: lazy(() => import("./Network")),
  },
  // ── Workspace ──
  {
    id: "permissions",
    title: "settings.panel.permissions",
    icon: "check",
    section: "workspace",
    component: lazy(() => import("./Permissions")),
  },
  {
    id: "sandbox",
    title: "settings.panel.sandbox",
    icon: "console",
    section: "workspace",
    component: lazy(() => import("./Sandbox")),
  },
  {
    id: "credentials",
    title: "settings.panel.credentials",
    icon: "providers",
    section: "workspace",
    component: lazy(() => import("./Credentials")),
  },
  // Wallet + Spend + Usage merged into one Billing panel (they each rendered a
  // duplicate balance card). Balance · Spend routing · Usage · Ledger.
  {
    id: "billing",
    title: "settings.panel.billing",
    icon: "sliders",
    section: "workspace",
    component: lazy(() => import("./Billing")),
  },
  {
    id: "storage",
    title: "settings.panel.storage",
    icon: "folder",
    section: "workspace",
    component: lazy(() => import("./Storage")),
  },
  {
    id: "general",
    title: "settings.panel.general",
    icon: "settings-gear",
    section: "workspace",
    component: lazy(() => import("./General")),
  },
]

export const SETTINGS_SECTIONS: { id: SettingsSection; label: TranslationKey }[] = [
  { id: "capabilities", label: "settings.section.capabilities" },
  { id: "workspace", label: "settings.section.workspace" },
]

export function findPanel(id: SettingsPanelId): SettingsPanel {
  return SETTINGS_PANELS.find((p) => p.id === id) ?? SETTINGS_PANELS[0]
}

export const DEFAULT_PANEL: SettingsPanelId = "connectors"
