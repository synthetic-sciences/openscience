import { Component, For, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { useDialog } from "@synsci/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import {
  SETTINGS_PANELS,
  SETTINGS_SECTIONS,
  DEFAULT_PANEL,
  findPanel,
  preloadPanel,
  type SettingsPanelId,
} from "./settings/registry"
import { SettingsNavContext } from "./settings/nav"
import { SettingsPanelStack } from "./settings/panel-stack"

// Scoped to the settings dialog only. Gives shared primitives and legacy
// panels one calm OpenScience hierarchy, grid, and surface stack without
// changing global component CSS or tokens.
const SETTINGS_STYLES = `
.settings-dialog,
[data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) {
  --settings-space-1: 4px;
  --settings-space-2: 8px;
  --settings-space-3: 12px;
  --settings-space-4: 16px;
  --settings-space-5: 24px;
  --settings-space-6: 32px;
  --settings-space-7: 48px;
  --settings-radius-control: var(--radius-xs, 8px);
  --settings-radius-card: var(--radius-md, 12px);
  --settings-radius-modal: var(--radius-lg, 16px);
  --settings-radius-pill: 999px;
  --settings-canvas: var(--background-base);
  --settings-rail: var(--background-weak);
  --settings-surface: var(--surface-raised-stronger-non-alpha);
  --settings-surface-muted: var(--input-base);
  --settings-surface-hover: var(--surface-base-hover);
  --settings-surface-active: var(--surface-base-active);
  --settings-selection: color-mix(in srgb, var(--text-strong) 8%, transparent);
  --settings-border: var(--border-base);
  --settings-border-strong: var(--border-strong-base);
  --settings-accent: var(--border-selected);
  --settings-accent-muted: color-mix(in srgb, var(--text-interactive-base) 10%, transparent);
  --settings-accent-strong: var(--text-interactive-base);
  /* Settings actions stay warm and tonal. Dark ink belongs to labels, not
     large filled controls; compact active states carry the product color. */
  --settings-primary: var(--surface-interactive-base);
  --settings-primary-hover: var(--surface-interactive-hover);
  --settings-on-primary: var(--text-interactive-base);
  --settings-toggle-active: var(--surface-brand-base);
  --settings-shadow-modal: var(--atlas-shadow-md, var(--shadow-lg));
  --settings-shadow-card: none;
  --settings-type-title: 18px;
  --settings-type-heading: 13px;
  --settings-type-body: 13px;
  --settings-type-helper: 12px;
  --settings-leading-title: 24px;
  --settings-leading-body: 20px;
  --settings-leading-helper: 18px;
}
.settings-dialog {
  font-family: var(--font-family-sans);
  font-feature-settings: var(--font-family-sans--font-feature-settings, normal);
  font-size: var(--settings-type-body);
  font-weight: var(--font-weight-regular);
  line-height: var(--settings-leading-body);
  min-width: 0;
  min-height: 0;
  background: var(--settings-canvas);
  color: var(--text-base);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-synthesis: none;
}
.settings-dialog h2,
.settings-dialog h3,
.settings-dialog h4 {
  font-family: inherit;
  letter-spacing: -0.01em;
  text-wrap: balance;
}
.settings-dialog p {
  text-wrap: pretty;
}
.settings-dialog button,
.settings-dialog input,
.settings-dialog select,
.settings-dialog textarea {
  font-family: inherit;
}
.settings-dialog .atlas-section-label,
.settings-section-label {
  color: var(--text-weak);
  font-family: inherit;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  letter-spacing: 0;
  line-height: 16px;
}
.settings-dialog [data-component="switch"] {
  --switch-active-color: var(--settings-toggle-active);
}
.settings-dialog [data-slot="select-select-trigger"] {
  min-height: 32px;
  border-color: transparent;
  border-radius: var(--settings-radius-control);
  background: var(--settings-surface-muted);
}
.settings-dialog [data-component="button"] {
  border-radius: var(--settings-radius-control);
  box-shadow: none;
}
.settings-dialog [data-component="button"][data-variant="secondary"] {
  border: 1px solid transparent;
  background: var(--settings-surface-muted);
  color: var(--text-strong);
}
.settings-dialog [data-component="button"][data-variant="secondary"]:hover:not(:disabled),
.settings-dialog [data-component="button"][data-variant="secondary"]:focus:not(:disabled) {
  border-color: transparent;
  background: var(--settings-surface-hover);
}
.settings-dialog [data-component="button"][data-variant="primary"] {
  border-color: var(--border-weak-base);
  background: var(--settings-primary);
  color: var(--settings-on-primary);
  box-shadow: var(--shadow-xs-border);
}
.settings-dialog [data-component="button"][data-variant="primary"]:hover:not(:disabled),
.settings-dialog [data-component="button"][data-variant="primary"]:focus:not(:disabled) {
  border-color: var(--border-hover);
  background: var(--settings-primary-hover);
}
.settings-dialog [data-component="button"]:is(:disabled, [data-disabled], [aria-disabled="true"]) {
  cursor: not-allowed;
  opacity: 0.48;
  pointer-events: none;
}
.settings-dialog [data-component="switch"]:is([data-disabled], [aria-disabled="true"]) {
  cursor: not-allowed;
  opacity: 0.48;
}
.settings-dialog [data-component="switch"]:is([data-disabled], [aria-disabled="true"])
  [data-slot="switch-control"] {
  cursor: not-allowed;
}
.settings-dialog [data-component="button"][data-variant="ghost"]:hover:not(:disabled),
.settings-dialog [data-component="button"][data-variant="ghost"]:focus-visible:not(:disabled) {
  background: var(--settings-surface-hover);
}
.settings-dialog > [data-slot="dialog-header"] {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
[data-component="select-content"][data-trigger-style="settings"] {
  border-radius: var(--settings-radius-card);
  padding: 5px;
}
[data-component="select-content"][data-trigger-style="settings"] [data-slot="select-select-item"] {
  border-radius: var(--settings-radius-control);
}

/* ── Fixed modal frame ──────────────────────────────────────────────────────
   The settings modal is ONE size regardless of the active panel. The rail +
   header stay fixed; only each panel body scrolls inside this frame. Without
   the height:100% override the shared dialog content grows to fit its content,
   so the box jumps size between tabs — the fix is to pin content to the fixed
   container height and let panels manage their own internal overflow. */
[data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-container"] {
  box-sizing: border-box;
  width: min(calc(100vw - 32px), 1180px);
  height: min(calc(100vh - 40px), 800px);
  overflow: hidden;
  border: 1px solid var(--settings-border);
  border-radius: var(--settings-radius-modal);
  background: var(--settings-canvas);
  box-shadow: var(--settings-shadow-modal);
  isolation: isolate;
}
[data-component="dialog"]:has([data-slot="dialog-content"].settings-expanded) [data-slot="dialog-container"] {
  width: min(calc(100vw - 32px), 1280px);
  height: min(calc(100vh - 40px), 880px);
}
[data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-content"] {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: inherit;
  background: transparent;
  box-shadow: none;
}
[data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-body"] {
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.settings-layout {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.settings-nav {
  width: 208px;
  min-height: 0;
  flex: 0 0 208px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: var(--settings-space-4) var(--settings-space-3) var(--settings-space-3);
  overflow: hidden;
  border-right: 1px solid var(--settings-border);
  background: var(--settings-rail);
}
.settings-nav__title {
  flex: 0 0 auto;
  padding: var(--settings-space-1) var(--settings-space-2) var(--settings-space-4);
  color: var(--text-strong);
  font-size: 15px;
  font-weight: var(--font-weight-medium);
  line-height: 22px;
  letter-spacing: -0.012em;
}
.settings-nav__scroll-button {
  display: none;
}
.settings-nav__mobile-trigger {
  display: none;
}
.settings-nav__sections {
  min-height: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--settings-space-4);
  padding-top: 2px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.settings-nav__sections::-webkit-scrollbar {
  display: none;
}
.settings-nav__section {
  display: flex;
  flex-direction: column;
  gap: var(--settings-space-1);
}
.settings-nav__label {
  padding: 0 var(--settings-space-2) var(--settings-space-1);
  color: var(--text-weak);
  font-size: 11px;
  font-weight: var(--font-weight-regular);
  letter-spacing: 0;
}
.settings-nav__item {
  min-width: 0;
  min-height: 32px;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: var(--settings-space-2);
  padding: 4px var(--settings-space-2);
  border: 0;
  border-radius: var(--settings-radius-control);
  background: transparent;
  box-shadow: none;
  font-size: 13px;
  font-weight: var(--font-weight-regular);
  line-height: 18px;
  color: var(--text-weak);
  text-align: left;
  transition:
    background 140ms ease,
    color 140ms ease,
    transform 120ms ease;
}
.settings-nav__item:hover {
  background: var(--settings-surface-hover);
  color: var(--text-strong);
}
.settings-nav__item[data-active="true"] {
  background: var(--settings-selection);
  color: var(--text-strong);
  font-weight: var(--font-weight-medium);
  box-shadow: none;
}
.settings-nav__item [data-component="icon"] {
  color: var(--icon-weak-base);
}
.settings-nav__item:hover [data-component="icon"],
.settings-nav__item[data-active="true"] [data-component="icon"] {
  color: var(--text-base);
}
.settings-nav__item[data-pending="true"] [data-component="icon"] {
  opacity: 0.55;
}
.settings-nav__item:active {
  transform: scale(0.98);
}
.settings-nav__item:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}
.settings-nav__footer {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 1px;
  padding: 12px 8px 0;
  color: var(--text-weak);
}
.settings-nav__footer > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-main {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--settings-canvas);
  container-name: settings-main;
  container-type: inline-size;
}
.settings-main__header {
  min-height: 48px;
  display: grid;
  grid-template-columns: minmax(72px, 1fr) auto minmax(72px, 1fr);
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 var(--settings-space-4);
  border-bottom: 1px solid var(--settings-border);
  background: var(--settings-canvas);
  flex-shrink: 0;
}
.settings-main__header > :last-child {
  justify-self: end;
}
.settings-main__context {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-weak);
  font-size: 12px;
  font-weight: var(--font-weight-regular);
  line-height: 18px;
}
.settings-main__viewport {
  position: relative;
  width: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  overscroll-behavior: contain;
  background: var(--settings-canvas);
}
.settings-main__viewport > :where(*) {
  min-width: 0;
}
.settings-panel-slot {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}
.settings-panel-slot[hidden] {
  display: none;
}
.settings-panel-loading {
  width: 100%;
  height: 100%;
  background: var(--settings-canvas);
}
.settings-panel-loading__header {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 28px 44px 22px;
  border-bottom: 1px solid var(--settings-border);
}
.settings-panel-loading__body {
  display: flex;
  max-width: 900px;
  flex-direction: column;
  gap: 14px;
  margin-inline: auto;
  padding: 28px 44px 64px;
}
.settings-panel-loading__line,
.settings-panel-loading__rows span {
  display: block;
  border-radius: var(--settings-radius-control);
  background: var(--settings-surface-muted);
}
.settings-panel-loading__line[data-size="title"] {
  width: 132px;
  height: 20px;
}
.settings-panel-loading__line[data-size="copy"] {
  width: min(420px, 72%);
  height: 13px;
}
.settings-panel-loading__line[data-size="label"] {
  width: 84px;
  height: 14px;
}
.settings-panel-loading__rows {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border: 0;
  border-radius: var(--settings-radius-card);
  background: var(--settings-surface);
  box-shadow: var(--settings-shadow-card);
}
.settings-panel-loading__rows span {
  height: 64px;
  border-radius: var(--settings-radius-control);
  background: var(--settings-surface-muted);
}
.settings-panel-loading__rows span + span {
  border-top: 0;
}

.settings-page-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: var(--settings-space-3);
  padding: var(--settings-space-5) var(--settings-space-6) var(--settings-space-3);
  border-bottom: 0;
  background: var(--settings-canvas);
}
.settings-page-header__inner {
  display: flex;
  width: min(100%, 900px);
  flex-direction: column;
  gap: var(--settings-space-1);
  margin-inline: auto;
}
.settings-page-header h2 {
  display: block;
  margin: 0;
  color: var(--text-strong);
  font-size: var(--settings-type-title);
  font-weight: var(--font-weight-medium);
  line-height: var(--settings-leading-title);
  letter-spacing: -0.015em;
}
.settings-page-header p {
  max-width: 700px;
  color: var(--text-weak);
  font-size: var(--settings-type-body);
  font-weight: var(--font-weight-regular);
  line-height: var(--settings-leading-body);
}
.settings-page-body {
  display: flex;
  width: 100%;
  max-width: 900px;
  flex-direction: column;
  gap: var(--settings-space-5);
  margin-inline: auto;
  padding: var(--settings-space-3) var(--settings-space-6) var(--settings-space-7);
}
.settings-section {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--settings-space-3);
}
.settings-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--settings-space-4);
}
.settings-section-heading > div {
  min-width: 0;
}
.settings-section-heading h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: var(--settings-type-heading);
  font-weight: var(--font-weight-medium);
  line-height: 1.35;
}
.settings-section-heading p {
  max-width: 640px;
  margin: var(--settings-space-1) 0 0;
  color: var(--text-weak);
  font-size: var(--settings-type-helper);
  line-height: var(--settings-leading-helper);
}
.settings-section-heading > span {
  flex: 0 0 auto;
  color: var(--text-weak);
  font-size: 12px;
}
.settings-section-heading--compact {
  min-height: 20px;
  align-items: center;
  gap: 8px;
  padding-inline: 2px;
}
.settings-error {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--text-danger) 35%, var(--border-base));
  border-radius: var(--settings-radius-control);
  color: var(--text-danger);
  font-size: 12px;
  line-height: 1.5;
}
.credential-services {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.settings-list-item + .settings-list-item {
  border-top: 0;
}
.settings-list-row {
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: var(--settings-space-3);
  padding: 10px var(--settings-space-3);
  border-radius: var(--settings-radius-control);
}
.settings-list-copy {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}
.settings-list-copy strong {
  color: var(--text-strong);
  font-size: var(--settings-type-body);
  font-weight: var(--font-weight-medium);
  line-height: var(--settings-leading-body);
}
.settings-list-copy span {
  color: var(--text-weak);
  font-size: 12px;
  line-height: var(--settings-leading-helper);
  text-wrap: pretty;
}
.settings-list-actions,
.credential-form-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.credential-form {
  display: grid;
  gap: var(--settings-space-3);
  padding: 4px var(--settings-space-3) var(--settings-space-4) 56px;
}
.credential-form--custom {
  padding: 20px;
}
.credential-form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(140px, 0.55fr);
  gap: 10px;
}
.credential-form label {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.credential-form label > span {
  color: var(--text-weak);
  font-size: 12px;
}
.credential-form input,
.credential-form textarea {
  width: 100%;
  min-height: 32px;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: var(--settings-radius-control);
  outline: none;
  background: var(--settings-surface-muted);
  color: var(--text-strong);
  font-size: 13px;
}
.credential-form textarea {
  min-height: 94px;
  resize: vertical;
}
.credential-form input:focus,
.credential-form textarea:focus {
  border-color: var(--focus-lit-ring);
  box-shadow: var(--focus-lit-halo);
}
.credential-form > p {
  margin: -2px 0 0;
  color: var(--text-weak);
  font-size: 12px;
}
.settings-add-row {
  min-height: 32px;
  align-self: flex-start;
  padding: 0 11px;
  border-radius: var(--settings-radius-control);
  color: var(--text-weak);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
}
.settings-add-row:hover {
  background: var(--settings-surface-hover);
  color: var(--text-strong);
}

/* Shared panel primitives follow the same 24px page grid and restrained
   surface stack as the shell. This prevents toolbars and list cards from
   turning into unrelated dark islands in the dark theme. */
.settings-card {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border: 0;
  border-radius: var(--settings-radius-card);
  background: var(--settings-surface);
  box-shadow: none;
}
.settings-form-card {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: var(--settings-space-5);
}
.settings-row {
  min-height: 56px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--settings-space-3);
  padding: 10px var(--settings-space-3);
  border: 0;
  border-radius: var(--settings-radius-control);
}
.settings-row[data-interactive="true"] {
  cursor: pointer;
}
.settings-row[data-interactive="true"]:hover {
  background: var(--settings-surface-hover);
}
.settings-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 16px;
  text-align: center;
}
.settings-empty-state__icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--settings-radius-card);
  background: var(--settings-surface-muted);
  color: var(--icon-weak-base);
}
.settings-alert {
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 0;
  border-radius: var(--settings-radius-control);
  color: var(--text-weak);
  background: var(--settings-surface-muted);
}
.settings-alert[data-tone="critical"] {
  color: var(--color-error);
  background: color-mix(in srgb, var(--color-error) 6%, transparent);
}
.settings-alert[data-tone="warning"] {
  color: var(--text-warning-base);
  background: var(--surface-warning-weak);
}
.settings-alert[data-stacked="true"] {
  align-items: stretch;
  flex-direction: column;
  justify-content: flex-start;
}
.settings-inline-action {
  min-height: 32px;
  padding: 4px 9px;
  border: 1px solid transparent;
  border-radius: var(--settings-radius-control);
  color: var(--text-weak);
  background: transparent;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
}
.settings-inline-action:hover {
  color: var(--text-strong);
  background: var(--settings-surface-hover);
}
.settings-inline-action[data-quiet="true"] {
  border-color: transparent;
}
.settings-choice-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.settings-choice {
  min-height: 88px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--settings-space-3);
  border: 1px solid transparent;
  border-radius: var(--settings-radius-card);
  color: var(--text-weak);
  background: var(--settings-surface-muted);
  text-align: left;
  transition:
    background 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}
.settings-choice:hover:not(:disabled) {
  background: var(--settings-surface-hover);
}
.settings-choice[aria-pressed="true"] {
  border-color: var(--settings-border-strong);
  color: var(--text-strong);
  background: var(--settings-surface);
}
.settings-choice:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.settings-filter-pill {
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--settings-radius-pill);
  color: var(--text-weak);
  background: transparent;
  font-size: 11px;
  font-weight: var(--font-weight-medium);
}
.settings-filter-pill:hover,
.settings-filter-pill[aria-pressed="true"] {
  color: var(--text-strong);
  background: var(--settings-surface-hover);
}
.settings-filter-pill[aria-pressed="true"] {
  border-color: transparent;
}
.settings-list-header {
  min-height: 34px;
  display: flex;
  align-items: center;
  padding: 0 18px;
  border-bottom: 0;
  border-radius: var(--settings-radius-control);
  background: var(--settings-surface-muted);
}
.settings-model-row {
  flex-wrap: nowrap;
  justify-content: space-between;
}
.settings-icon-action {
  width: 32px;
  height: 32px;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: var(--settings-radius-control);
  color: var(--text-weak);
  background: transparent;
}
.settings-icon-action:hover,
.settings-icon-action[data-pinned="true"] {
  color: var(--text-strong);
  background: var(--settings-surface-hover);
}
.settings-provider-key {
  min-height: 32px;
  padding-block: 5px;
  font-family: var(--font-family-mono);
}

@media (max-width: 640px) {
  .settings-choice-grid {
    grid-template-columns: 1fr;
  }
}
.settings-avatar {
  width: 32px;
  height: 32px;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--settings-radius-control);
  background: var(--settings-surface-muted);
  color: var(--icon-strong-base);
  font-size: var(--settings-type-body);
  font-weight: var(--font-weight-medium);
  line-height: 1;
}
.settings-avatar[data-tinted="true"] {
  border-color: transparent;
}
.settings-provider-logo {
  position: relative;
  width: 32px;
  height: 32px;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 0;
  border-radius: var(--settings-radius-control);
  background: var(--settings-surface-muted);
  color: var(--text-strong);
}
.settings-provider-logo[data-size="small"] {
  width: 24px;
  height: 24px;
  border-radius: calc(var(--settings-radius-control) - 2px);
}
.settings-chip {
  min-height: 20px;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 2px 7px;
  border: 0;
  border-radius: var(--settings-radius-pill);
  background: var(--settings-surface-muted);
  color: var(--text-weak);
  font-size: 11px;
  font-weight: var(--font-weight-medium);
  line-height: 15px;
}
.settings-toolbar {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.settings-segmented-control {
  min-height: 32px;
  border: 0;
  border-radius: var(--settings-radius-control);
  background: var(--settings-surface-muted);
}
.settings-segmented-control__option {
  min-height: 28px;
  border-radius: calc(var(--settings-radius-control) - 2px);
  color: var(--text-weak);
}
.settings-segmented-control__option:hover,
.settings-segmented-control__option[data-selected="true"] {
  color: var(--text-strong);
  background: var(--settings-surface-active);
}
.settings-control {
  min-width: 0;
  min-height: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--settings-radius-control);
  background: var(--settings-surface-muted);
  color: var(--text-strong);
  font-size: var(--settings-type-body);
  font-weight: var(--font-weight-regular);
  line-height: var(--settings-leading-body);
  transition:
    background 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}
.settings-control--search {
  min-width: 140px;
  flex: 1;
  cursor: text;
}
.settings-control--search:focus-within {
  border-color: var(--focus-lit-ring);
  box-shadow: var(--focus-lit-halo);
}
.settings-control--menu,
.settings-control--primary {
  flex: 0 0 auto;
  cursor: pointer;
}
.settings-control--menu:hover,
.settings-control--menu[data-expanded] {
  background: var(--settings-surface-active);
}
.settings-control--primary {
  border-color: var(--border-weak-base);
  background: var(--settings-primary);
  color: var(--settings-on-primary);
}
.settings-control--primary:hover {
  background: var(--settings-primary-hover);
}
.settings-field {
  width: 100%;
  min-height: 32px;
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: var(--settings-radius-control);
  outline: none;
  background: var(--settings-surface-muted);
  color: var(--text-strong);
  font-size: var(--settings-type-body);
  font-weight: var(--font-weight-regular);
  line-height: var(--settings-leading-body);
}
.settings-field:focus {
  border-color: var(--focus-lit-ring);
  box-shadow: var(--focus-lit-halo);
}
.settings-field::placeholder {
  color: var(--text-weak);
}
.settings-field--multiline {
  min-height: 96px;
  resize: vertical;
}
.settings-button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--settings-radius-control);
  color: var(--text-strong);
  font-size: var(--settings-type-body);
  font-weight: var(--font-weight-medium);
  transition:
    background 140ms ease,
    border-color 140ms ease,
    color 140ms ease,
    opacity 140ms ease;
}
.settings-button[data-variant="primary"] {
  border-color: var(--border-weak-base);
  background: var(--settings-primary);
  color: var(--settings-on-primary);
  box-shadow: var(--shadow-xs-border);
}
.settings-button[data-variant="primary"]:hover {
  background: var(--settings-primary-hover);
}
.settings-button[data-variant="ghost"] {
  border-color: transparent;
  color: var(--text-weak);
  background: transparent;
}
.settings-button[data-variant="ghost"]:hover {
  color: var(--text-strong);
  background: var(--settings-surface-hover);
}
.settings-button[data-variant="danger"] {
  color: var(--text-on-critical-base);
  background: var(--surface-critical-weak);
}
.settings-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* Panel-local semantic hooks. These keep icon, status, and action hierarchy
   consistent without forcing each Settings page to invent its own colors. */
.settings-row-icon,
.settings-alert__icon {
  width: 32px;
  height: 32px;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--settings-radius-control);
  background: var(--surface-base-hover);
  color: var(--icon-strong-base);
}
.settings-alert__icon {
  width: 28px;
  height: 28px;
}
.settings-status {
  min-height: 24px;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 0;
  border-radius: var(--settings-radius-pill);
  color: var(--text-weak);
  background: var(--settings-surface-muted);
  font-size: 11px;
  font-weight: var(--font-weight-medium);
}
.settings-status[data-tone="ready"] {
  color: var(--text-strong);
}
.settings-status__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--icon-success-base);
}
.settings-panel-action {
  border-radius: var(--settings-radius-control);
}
.settings-panel-action--quiet {
  color: var(--text-weak);
}
.settings-panel-action--danger-quiet {
  border-color: transparent;
  color: var(--text-danger);
  background: transparent;
}
.settings-panel-action--danger-quiet:hover:not(:disabled) {
  border-color: var(--border-critical-base);
  background: var(--surface-critical-weak);
}
.settings-provider-key-form,
.settings-defaults-card,
.settings-model-catalog {
  background: var(--settings-surface);
}

/* Panels use the shared type utility names, but the shell owns their semantic
   role. Keep title, row label, body, and helper text distinct instead of
   flattening every class (and even inline styles) to one 12px weight. */
.settings-dialog .text-16-medium {
  font-family: inherit;
  font-size: var(--settings-type-title);
  font-weight: var(--font-weight-medium);
  line-height: var(--settings-leading-title);
  letter-spacing: -0.015em;
}
.settings-dialog .settings-page-header h2 {
  font-weight: var(--font-weight-medium);
}
.settings-dialog .text-14-medium {
  font-family: inherit;
  font-size: var(--settings-type-heading);
  font-weight: var(--font-weight-medium);
  line-height: var(--settings-leading-body);
  letter-spacing: -0.006em;
}
.settings-dialog .text-13-medium {
  font-family: inherit;
  font-size: var(--settings-type-body);
  font-weight: var(--font-weight-medium);
  line-height: var(--settings-leading-body);
  letter-spacing: 0;
}
.settings-dialog .text-12-medium {
  font-family: inherit;
  font-size: var(--settings-type-helper);
  font-weight: var(--font-weight-medium);
  line-height: var(--settings-leading-helper);
  letter-spacing: 0;
}
.settings-dialog .text-14-regular {
  font-family: inherit;
  font-size: var(--settings-type-heading);
  font-weight: var(--font-weight-regular);
  line-height: var(--settings-leading-body);
  letter-spacing: 0;
}
.settings-dialog .text-13-regular {
  font-family: inherit;
  font-size: var(--settings-type-body);
  font-weight: var(--font-weight-regular);
  line-height: var(--settings-leading-body);
  letter-spacing: 0;
}
.settings-dialog :where(.text-12-regular, .text-11-regular, .text-10-regular) {
  font-family: inherit;
  font-size: var(--settings-type-helper);
  font-weight: var(--font-weight-regular);
  line-height: var(--settings-leading-helper);
  letter-spacing: 0;
}
.settings-dialog :where(.text-11-medium, .text-10-medium) {
  font-family: inherit;
  font-size: var(--settings-type-helper);
  font-weight: var(--font-weight-medium);
  line-height: var(--settings-leading-helper);
  letter-spacing: 0;
}
.settings-dialog [class~="tracking-wide"] {
  letter-spacing: 0;
}
.settings-dialog :where(button, [role="button"], [data-slot="select-select-trigger"]) {
  min-height: 32px;
}
.settings-dialog .settings-choice {
  height: auto;
  min-height: 88px;
}
.settings-dialog :where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea) {
  min-height: 32px;
}
.settings-dialog :where(.text-text-weaker, [class*="text-text-weak/"]) {
  color: var(--text-weak);
}
.settings-dialog :where(input, textarea)::placeholder {
  color: var(--text-weak);
  opacity: 1;
}
.settings-dialog [data-slot="select-select-trigger"] span {
  font-size: var(--settings-type-body);
  line-height: var(--settings-leading-body);
}
.settings-dialog :where(button, [role="button"]):not(:disabled) {
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease,
    opacity 140ms ease,
    transform 120ms ease;
}
.settings-dialog :where(button, [role="button"]):not(:disabled):active {
  transform: scale(0.98);
}
.settings-dialog :where(button, input, select, textarea):focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
  transition-duration: 0ms;
}
@media (pointer: coarse) {
  .settings-dialog :where(button, [role="button"], [data-slot="select-select-trigger"]),
  .settings-dialog :where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea) {
    min-height: 44px;
  }
}

@media (prefers-reduced-transparency: reduce) {
  [data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-container"],
  .settings-dialog,
  .settings-main,
  .settings-main__header {
    background: var(--settings-canvas);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .settings-nav {
    background: var(--settings-rail);
  }
}

@media (prefers-contrast: more) {
  [data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-container"],
  .settings-nav,
  .settings-main__header,
  .settings-card {
    border-color: var(--settings-border-strong);
  }
}

/* Generic panels respond to the Settings column rather than the browser.
   Panels with bespoke layouts own their intrinsic breakpoints locally. */
@container settings-main (max-width: 600px) {
  .settings-choice-grid,
  .credential-form-grid {
    grid-template-columns: 1fr;
  }
}

@container settings-main (max-width: 480px) {
  .settings-section-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }
  .settings-list-row,
  .settings-model-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .settings-list-actions,
  .credential-form-actions {
    width: 100%;
    flex-wrap: wrap;
    padding-left: 44px;
  }
  .credential-form {
    padding-left: 14px;
  }
}

@media (max-width: 980px) {
  [data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-container"] {
    width: calc(100vw - 16px);
    height: calc(100vh - 16px);
    border-radius: var(--settings-radius-modal);
  }
  .settings-layout {
    flex-direction: column;
  }
  .settings-nav {
    position: relative;
    z-index: 30;
    width: 100%;
    height: 48px;
    flex: 0 0 48px;
    display: block;
    padding: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border-base);
    overflow: visible;
  }
  .settings-nav__title {
    display: none;
  }
  .settings-nav__mobile-trigger {
    width: 100%;
    height: 48px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 16px;
    border: 0;
    border-radius: 0;
    background: var(--settings-rail);
    color: var(--text-strong);
    font-size: 13px;
    font-weight: var(--font-weight-medium);
    text-align: left;
  }
  .settings-nav__mobile-trigger:hover {
    background: var(--settings-surface-hover);
  }
  .settings-nav__mobile-trigger:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: -3px;
  }
  .settings-nav__mobile-trigger > [data-component="icon"]:last-child {
    margin-left: auto;
  }
  .settings-nav__mobile-trigger small {
    min-width: 0;
    overflow: hidden;
    color: var(--text-weak);
    font-size: 11px;
    font-weight: var(--font-weight-regular);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .settings-nav__sections {
    position: absolute;
    top: 48px;
    right: 0;
    left: 0;
    z-index: 31;
    min-width: 0;
    max-height: min(68dvh, 520px);
    display: none;
    flex-direction: column;
    gap: 16px;
    padding: 14px 12px 16px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-bottom: 1px solid var(--settings-border);
    background: var(--settings-rail);
    box-shadow: 0 14px 28px color-mix(in srgb, var(--background-strongest) 20%, transparent);
  }
  .settings-nav[data-mobile-open="true"] .settings-nav__sections {
    display: flex;
  }
  .settings-nav__section {
    flex-direction: column;
    gap: 4px;
  }
  .settings-nav__footer {
    display: none;
  }
  .settings-nav__label {
    display: block;
    padding-inline: 8px;
  }
  .settings-nav__item {
    width: 100%;
    min-height: 40px;
    gap: 6px;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--settings-radius-control);
    font-size: 13px;
  }
  .settings-nav__item:hover {
    background: var(--settings-surface-hover);
  }
  .settings-nav__item[data-active="true"] {
    background: var(--settings-selection);
  }
  .settings-main__header {
    min-height: 52px;
  }
  .settings-page-header {
    padding: 20px 20px 16px;
  }
  .settings-page-body {
    padding: 16px 20px 36px;
  }
  .settings-panel-loading__header {
    padding: 20px 20px 16px;
  }
  .settings-panel-loading__body {
    padding: 16px 20px 36px;
  }
  .credential-form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .settings-main__context {
    display: none;
  }
}

@media (max-height: 600px) and (min-width: 981px) {
  [data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-container"] {
    height: calc(100vh - 24px);
  }
  .settings-nav {
    padding-block: 12px;
  }
  .settings-nav__sections {
    gap: 12px;
  }
  .settings-page-header {
    padding-block: 16px 14px;
  }
  .settings-page-body {
    gap: 20px;
    padding-block: 14px 28px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-dialog *,
  .settings-dialog *::before,
  .settings-dialog *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
`

export const DialogSettings: Component<{ initial?: SettingsPanelId }> = (props) => {
  const platform = usePlatform()
  const dialog = useDialog()
  const initial = findPanel(props.initial ?? DEFAULT_PANEL)

  // Browser-style history so back/forward chevrons are real navigation.
  const [history, setHistory] = createSignal<SettingsPanelId[]>([initial.id])
  const [cursor, setCursor] = createSignal(0)
  // Keep the active panel plus the two most recent destinations. Retaining
  // every panel forever leaves large catalogs, subscriptions, and resources
  // alive after they disappear, so Customize gets slower the longer it stays
  // open. A small LRU keeps normal back-and-forth state without accumulating a
  // hidden settings application behind the visible panel.
  const [mounted, setMounted] = createSignal([initial])
  const [pending, setPending] = createSignal<SettingsPanelId>()
  const [expanded, setExpanded] = createSignal(false)
  const [navOpen, setNavOpen] = createSignal(false)
  let nav: HTMLElement | undefined
  let navSections: HTMLDivElement | undefined
  let navTrigger: HTMLButtonElement | undefined
  let navigationRequest = 0

  const current = createMemo(() => findPanel(history()[cursor()]))
  const canBack = createMemo(() => cursor() > 0)
  const canForward = createMemo(() => cursor() < history().length - 1)

  onMount(() => {
    const closeMobileNavigation = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !navOpen()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setNavOpen(false)
      queueMicrotask(() => navTrigger?.focus())
    }
    nav?.addEventListener("keydown", closeMobileNavigation, true)

    // Keep the opening interaction light. Preloading every settings chunk at
    // once competes with the active panel on slower machines. The most likely
    // next destination is warmed during idle time; every other destination is
    // prefetched on pointer or keyboard intent below.
    const preloadSkills = () => void preloadPanel("skills").catch(() => undefined)
    let idleHandle: number | undefined
    let timerHandle: ReturnType<typeof setTimeout> | undefined
    const requestIdle = (window as Window & { requestIdleCallback?: typeof window.requestIdleCallback })
      .requestIdleCallback
    if (typeof requestIdle === "function") {
      idleHandle = requestIdle.call(window, preloadSkills, { timeout: 1_200 })
    } else {
      timerHandle = globalThis.setTimeout(preloadSkills, 600)
    }
    onCleanup(() => {
      nav?.removeEventListener("keydown", closeMobileNavigation, true)
      if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle)
      if (timerHandle !== undefined) globalThis.clearTimeout(timerHandle)
    })
  })

  createEffect(() => {
    current().id
    queueMicrotask(() =>
      navSections
        ?.querySelector<HTMLElement>('.settings-nav__item[data-active="true"]')
        ?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" }),
    )
  })

  const navigate = (id: SettingsPanelId) => {
    if (history()[cursor()] === id) return
    const restoreNavFocus = navOpen()
    const request = ++navigationRequest
    const next = history().slice(0, cursor() + 1)
    next.push(id)

    // Navigation acknowledges synchronously. The destination owns its loading
    // skeleton through Suspense, so a click never looks ignored while a lazy
    // module or its first data request is still settling.
    batch(() => {
      const panel = findPanel(id)
      setMounted((panels) => [...panels.filter((item) => item.id !== id), panel].slice(-3))
      setHistory(next)
      setCursor(next.length - 1)
      setPending(id)
      setNavOpen(false)
    })
    if (restoreNavFocus) queueMicrotask(() => navTrigger?.focus())

    void preloadPanel(id)
      .catch(() => undefined)
      .finally(() => {
        if (request === navigationRequest) setPending(undefined)
      })
  }
  const moveHistory = (next: number) => {
    navigationRequest += 1
    batch(() => {
      const panel = findPanel(history()[next])
      setMounted((panels) => [...panels.filter((item) => item.id !== panel.id), panel].slice(-3))
      setPending(undefined)
      setCursor(next)
    })
  }
  const back = () => canBack() && moveHistory(cursor() - 1)
  const forward = () => canForward() && moveHistory(cursor() + 1)

  return (
    <>
      <style>{SETTINGS_STYLES}</style>
      <Dialog
        title="Settings"
        action={<span aria-hidden="true" />}
        size="x-large"
        class="settings-dialog"
        classList={{ "settings-expanded": expanded() }}
      >
        <div class="settings-layout">
          {/* ── Left rail ── */}
          <nav
            ref={nav}
            class="settings-nav"
            aria-label="Settings sections"
            data-mobile-open={navOpen() ? "true" : undefined}
            data-dialog-escape-scope={navOpen() ? "true" : undefined}
          >
            <div class="settings-nav__title">Settings</div>
            <button
              type="button"
              ref={navTrigger}
              class="settings-nav__mobile-trigger"
              aria-expanded={navOpen()}
              aria-controls="settings-section-menu"
              onClick={() => setNavOpen((value) => !value)}
            >
              <Icon name={current().icon} size="small" />
              <span>{current().title}</span>
              <Icon name="chevron-down" size="small" classList={{ "rotate-180": navOpen() }} />
            </button>
            <div id="settings-section-menu" class="settings-nav__sections" ref={navSections}>
              <For each={SETTINGS_SECTIONS}>
                {(section) => (
                  <div class="settings-nav__section">
                    <span class="settings-nav__label">{section.label}</span>
                    <For each={SETTINGS_PANELS.filter((p) => p.section === section.id)}>
                      {(panel) => (
                        <button
                          type="button"
                          class="settings-nav__item"
                          data-active={current().id === panel.id ? "true" : "false"}
                          data-pending={pending() === panel.id ? "true" : undefined}
                          onPointerEnter={() => void preloadPanel(panel.id).catch(() => undefined)}
                          onFocus={() => void preloadPanel(panel.id).catch(() => undefined)}
                          onClick={() => void navigate(panel.id)}
                          aria-busy={pending() === panel.id ? "true" : undefined}
                          aria-current={current().id === panel.id ? "page" : undefined}
                        >
                          <Icon name={panel.icon} size="normal" class="flex-shrink-0" />
                          <span class="truncate">{panel.title}</span>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
            <div class="settings-nav__footer">
              <span class="text-12-medium">OpenScience</span>
              <span class="text-11-regular">v{platform.version}</span>
            </div>
          </nav>

          {/* ── Right column ── */}
          <div class="settings-main">
            {/* Header */}
            <header class="settings-main__header">
              <div class="flex items-center gap-1 min-w-0">
                <IconButton icon="arrow-left" variant="ghost" disabled={!canBack()} onClick={back} aria-label="Back" />
                <IconButton
                  icon="arrow-right"
                  variant="ghost"
                  disabled={!canForward()}
                  onClick={forward}
                  aria-label="Forward"
                />
              </div>
              <div class="settings-main__context" aria-live="polite">
                <span>{current().title}</span>
              </div>
              <div class="flex items-center gap-1 flex-shrink-0">
                <IconButton
                  icon={expanded() ? "collapse" : "expand"}
                  variant="ghost"
                  onClick={() => setExpanded((v) => !v)}
                  aria-label={expanded() ? "Collapse" : "Expand"}
                />
                <IconButton icon="close" variant="ghost" onClick={() => dialog.close()} aria-label="Close" />
              </div>
            </header>

            {/* Body */}
            <div class="settings-main__viewport" data-panel={current().id}>
              <SettingsNavContext.Provider value={(id) => void navigate(id)}>
                <SettingsPanelStack active={() => current().id} panels={mounted} />
              </SettingsNavContext.Provider>
            </div>
          </div>
        </div>
      </Dialog>
    </>
  )
}
