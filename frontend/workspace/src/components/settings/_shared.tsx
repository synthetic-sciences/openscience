import { For, Show, createSignal, createUniqueId, type JSX, type ParentComponent, type Component } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import type { IconProps } from "@synsci/ui/icon"
import { DropdownMenu } from "@synsci/ui/dropdown-menu"

// These menus render inside the modal settings Dialog. Kobalte portals a
// dropdown to document.body by default, which lands OUTSIDE the dialog's
// dismissable layer — the dialog then treats the open as an outside
// interaction and closes the menu instantly. Mounting the portal into the
// enclosing dialog content nests the layers so the menu opens and stays open.
// Falls back to the default body portal when not inside a dialog.
function useDialogMount() {
  const [mount, setMount] = createSignal<HTMLElement>()
  const anchor = (el: HTMLElement) => {
    const content = el.closest<HTMLElement>('[data-slot="dialog-content"]')
    if (content) setMount(content)
  }
  return { mount, anchor }
}

// Shared visual language for the OpenScience settings panels. Matches the
// reference (rounded cards, muted subheaders, filter/search/add toolbar) while
// inheriting the workspace type stack and theme tokens. Panels stay one-file-
// each; this module is pure presentational infrastructure they compose.

export const PanelScroll: ParentComponent = (props) => (
  <div class="flex min-h-0 min-w-0 flex-col h-full overflow-y-auto no-scrollbar">{props.children}</div>
)

export const PanelHeader: Component<{ title: string; description: string; toolbar?: JSX.Element }> = (props) => (
  <div class="settings-page-header">
    <div class="settings-page-header__inner min-w-0">
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="text-16-medium text-text-strong">{props.title}</h2>
        <p class="text-13-regular text-text-weak">{props.description}</p>
      </div>
      <Show when={props.toolbar}>{props.toolbar}</Show>
    </div>
  </div>
)

export const PanelBody: ParentComponent = (props) => <div class="settings-page-body min-w-0">{props.children}</div>

export const Section: ParentComponent<{
  title: string
  description?: JSX.Element
  count?: number
  action?: JSX.Element
  id?: string
}> = (props) => {
  const generated = `settings-${createUniqueId()}`
  const id = () => props.id ?? generated
  return (
    <section class="settings-section" aria-labelledby={id()}>
      <div class="settings-section-heading">
        <div>
          <h3 id={id()}>{props.title}</h3>
          <Show when={props.description}>
            <p>{props.description}</p>
          </Show>
        </div>
        <Show
          when={props.action}
          fallback={
            <Show when={props.count !== undefined}>
              <span>{props.count}</span>
            </Show>
          }
        >
          {props.action}
        </Show>
      </div>
      {props.children}
    </section>
  )
}

export const RowCopy: Component<{ title: string; description?: string; mono?: boolean }> = (props) => (
  <div class="settings-list-copy">
    <strong classList={{ "font-mono": props.mono }}>{props.title}</strong>
    <Show when={props.description}>
      <span class="whitespace-normal text-ellipsis">{props.description}</span>
    </Show>
  </div>
)

// Muted sentence-case subheader with a trailing count.
export const SectionLabel: Component<{ label: string; count?: number }> = (props) => (
  <div class="settings-section-heading settings-section-heading--compact">
    <h3 class="settings-section-label min-w-0 break-words">{props.label}</h3>
    <Show when={props.count !== undefined}>
      <span>{props.count}</span>
    </Show>
  </div>
)

// Rounded card wrapping a stack of rows (dividers between children handled by
// Row's border-b). Use for grouped lists.
export const Card: ParentComponent = (props) => <div class="settings-card min-w-0 w-full">{props.children}</div>

export const Row: ParentComponent<{ onClick?: () => void }> = (props) => (
  <Show when={props.onClick} fallback={<div class="settings-row min-w-0">{props.children}</div>}>
    {(onClick) => (
      <button type="button" class="settings-row min-w-0" data-interactive="true" onClick={() => onClick()()}>
        {props.children}
      </button>
    )}
  </Show>
)

export const EmptyState: Component<{ icon: IconProps["name"]; title: string; hint?: string }> = (props) => (
  <div class="settings-empty-state min-w-0">
    <div class="settings-empty-state__icon">
      <Icon name={props.icon} size="normal" />
    </div>
    <span class="text-14-medium text-text-strong">{props.title}</span>
    <Show when={props.hint}>
      <p class="text-12-regular text-text-weak leading-relaxed max-w-[380px]">{props.hint}</p>
    </Show>
  </div>
)

// Leading identity tile for a list row — the shared visual anchor that makes the
// Specialists and Connectors lists read as one family. Pass a `monogram` (takes
// the tint as its colour, for a specialist's identity) or an `icon` (stays
// neutral on the tinted tile, for a connector's type). `tint` (hex or a CSS var)
// washes the tile background; omit it for a neutral tile.
export const Avatar: Component<{ tint?: string; icon?: IconProps["name"]; monogram?: string }> = (props) => (
  <div
    class="settings-avatar"
    data-tinted={props.tint ? "true" : undefined}
    style={{
      background: props.tint ? `color-mix(in srgb, ${props.tint} 14%, transparent)` : undefined,
      color: props.monogram && props.tint ? props.tint : "var(--color-icon-strong-base)",
    }}
  >
    <Show when={props.icon} fallback={<span>{props.monogram}</span>}>
      <Icon name={props.icon!} size="small" />
    </Show>
  </div>
)

// Small inline metadata badge (a specialist's mode, a connector's type).
export const Chip: ParentComponent = (props) => <span class="settings-chip">{props.children}</span>

// ── Toolbar pieces ──────────────────────────────────────────────────────────

const controlBase = "settings-control"

export const SearchInput: Component<{
  value: string
  onInput: (v: string) => void
  placeholder?: string
  ariaLabel?: string
}> = (props) => (
  <div class={`${controlBase} settings-control--search max-w-full`}>
    <Icon name="magnifying-glass" size="small" class="text-icon-weak-base flex-shrink-0" />
    <input
      type="text"
      aria-label={props.ariaLabel ?? props.placeholder ?? "Search"}
      value={props.value}
      placeholder={props.placeholder ?? "Search"}
      spellcheck={false}
      autocapitalize="off"
      autocomplete="off"
      class="min-w-0 flex-1 bg-transparent outline-none text-text-strong placeholder:text-text-weak/60"
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
    <Show when={props.value}>
      <button
        type="button"
        class="shrink-0 text-icon-weak-base hover:text-text-strong"
        aria-label="Clear search"
        onClick={() => props.onInput("")}
      >
        <Icon name="circle-x" size="small" />
      </button>
    </Show>
  </div>
)

export interface FilterOption {
  id: string
  label: string
  count?: number
}

export const FilterMenu: Component<{
  options: FilterOption[]
  value: string
  onSelect: (id: string) => void
  ariaLabel?: string
}> = (props) => {
  const active = () => props.options.find((o) => o.id === props.value) ?? props.options[0]
  const dialog = useDialogMount()
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        ref={dialog.anchor}
        aria-label={props.ariaLabel}
        class={`${controlBase} settings-control--menu max-w-full`}
      >
        <span class="min-w-0 truncate max-w-[160px]">
          {active()?.label}
          <Show when={active()?.count !== undefined}> ({active()?.count})</Show>
        </span>
        <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak-base" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal mount={dialog.mount()}>
        <DropdownMenu.Content class="mt-1 min-w-[180px]">
          <For each={props.options}>
            {(option) => (
              <DropdownMenu.Item onSelect={() => props.onSelect(option.id)}>
                <DropdownMenu.ItemLabel class="flex-1">{option.label}</DropdownMenu.ItemLabel>
                <Show when={option.count !== undefined}>
                  <span class="text-12-regular text-text-weak ml-4">{option.count}</span>
                </Show>
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export interface AddItem {
  icon: IconProps["name"]
  label: string
  description?: string
  onSelect: () => void
}

export const AddMenu: Component<{ label: string; items: AddItem[] }> = (props) => {
  const dialog = useDialogMount()
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        ref={dialog.anchor}
        aria-label={props.label}
        class={`${controlBase} settings-control--primary max-w-full`}
      >
        <Icon name="plus" size="small" class="shrink-0" />
        <span class="min-w-0 truncate">{props.label}</span>
        <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak-base" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal mount={dialog.mount()}>
        <DropdownMenu.Content class="mt-1 min-w-[240px]">
          <For each={props.items}>
            {(item) => (
              <DropdownMenu.Item aria-label={item.label} onSelect={item.onSelect} class="items-start gap-2.5 py-2">
                <Icon name={item.icon} size="small" class="text-icon-weak-base mt-0.5 flex-shrink-0" />
                <div class="flex flex-col gap-0.5 min-w-0">
                  <DropdownMenu.ItemLabel>{item.label}</DropdownMenu.ItemLabel>
                  <Show when={item.description}>
                    <DropdownMenu.ItemDescription class="text-12-regular text-text-weak">
                      {item.description}
                    </DropdownMenu.ItemDescription>
                  </Show>
                </div>
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export const Toolbar: ParentComponent = (props) => <div class="settings-toolbar min-w-0">{props.children}</div>

// A small labelled text/textarea field used by the inline creation forms.
export const FormField: Component<{
  label: string
  value: string
  onInput: (v: string) => void
  placeholder?: string
  multiline?: boolean
  disabled?: boolean
  mono?: boolean
}> = (props) => (
  <label class="flex min-w-0 flex-col gap-1.5">
    <span class="text-12-medium text-text-strong">{props.label}</span>
    <Show
      when={props.multiline}
      fallback={
        <input
          type="text"
          value={props.value}
          disabled={props.disabled}
          placeholder={props.placeholder}
          class="settings-field"
          onInput={(e) => props.onInput(e.currentTarget.value)}
        />
      }
    >
      <textarea
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        rows={5}
        class="settings-field settings-field--multiline"
        classList={{ "font-mono": props.mono }}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    </Show>
  </label>
)

export const FormButton: Component<{
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: "primary" | "ghost" | "danger"
}> = (props) => (
  <button
    type="button"
    disabled={props.disabled}
    onClick={props.onClick}
    class="settings-button max-w-full"
    data-variant={props.variant ?? "primary"}
  >
    {props.label}
  </button>
)
