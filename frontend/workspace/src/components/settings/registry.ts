import { lazy, type Component } from "solid-js"
import type { IconProps } from "@synsci/ui/icon"

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
  | "skills"
  | "connectors"
  | "specialists"
  | "memory"
  | "compute"
  | "local-models"
  | "network"
  | "permissions"
  | "credentials"
  | "spend"
  | "wallet"
  | "storage"
  | "usage"
  | "general"

export interface SettingsPanel {
  /** Stable key used for routing/history. */
  id: SettingsPanelId
  /** Title shown in the shell header + rail label. */
  title: string
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
  { id: "skills", title: "Skills", icon: "brain", section: "capabilities", component: lazy(() => import("./Skills")) },
  {
    id: "connectors",
    title: "Connectors",
    icon: "mcp",
    section: "capabilities",
    component: lazy(() => import("./Connectors")),
  },
  {
    id: "specialists",
    title: "Specialists",
    icon: "models",
    section: "capabilities",
    component: lazy(() => import("./Specialists")),
  },
  {
    id: "memory",
    title: "Memory",
    icon: "archive",
    section: "capabilities",
    component: lazy(() => import("./Memory")),
  },
  {
    id: "compute",
    title: "Compute",
    icon: "server",
    section: "capabilities",
    component: lazy(() => import("./Compute")),
  },
  {
    id: "local-models",
    title: "Local models",
    icon: "models",
    section: "capabilities",
    component: lazy(() => import("./LocalModels")),
  },
  {
    id: "network",
    title: "Network",
    icon: "share",
    section: "capabilities",
    component: lazy(() => import("./Network")),
  },
  // ── Workspace ──
  {
    id: "permissions",
    title: "Permissions",
    icon: "check",
    section: "workspace",
    component: lazy(() => import("./Permissions")),
  },
  {
    id: "credentials",
    title: "Credentials",
    icon: "providers",
    section: "workspace",
    component: lazy(() => import("./Credentials")),
  },
  { id: "spend", title: "Spend", icon: "sliders", section: "workspace", component: lazy(() => import("./Spend")) },
  { id: "wallet", title: "Wallet", icon: "checklist", section: "workspace", component: lazy(() => import("./Wallet")) },
  { id: "storage", title: "Storage", icon: "folder", section: "workspace", component: lazy(() => import("./Storage")) },
  { id: "usage", title: "Usage", icon: "bullet-list", section: "workspace", component: lazy(() => import("./Usage")) },
  {
    id: "general",
    title: "General",
    icon: "settings-gear",
    section: "workspace",
    component: lazy(() => import("./General")),
  },
]

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "capabilities", label: "Capabilities" },
  { id: "workspace", label: "Workspace" },
]

export function findPanel(id: SettingsPanelId): SettingsPanel {
  return SETTINGS_PANELS.find((p) => p.id === id) ?? SETTINGS_PANELS[0]
}

export const DEFAULT_PANEL: SettingsPanelId = "skills"
