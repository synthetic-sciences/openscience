import { For, Show, type JSX, type ParentComponent, type Component } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import type { IconProps } from "@synsci/ui/icon"
import { DropdownMenu } from "@synsci/ui/dropdown-menu"

// Shared visual language for the OpenScience settings panels. Matches the
// reference (rounded cards, muted subheaders, filter/search/add toolbar) while
// inheriting the app's Computer Modern font — no token/font edits. Panels stay
// one-file-each; this module is pure presentational infra they compose.

export const PanelScroll: ParentComponent = (props) => (
  <div class="flex flex-col h-full overflow-y-auto no-scrollbar">{props.children}</div>
)

export const PanelHeader: Component<{ title: string; description: string; toolbar?: JSX.Element }> = (props) => (
  <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
    <div class="flex flex-col gap-4 px-4 pt-8 pb-4 sm:px-8 max-w-[820px]">
      <div class="flex flex-col gap-1">
        <h2 class="text-16-medium text-text-strong">{props.title}</h2>
        <p class="text-13-regular text-text-weak">{props.description}</p>
      </div>
      <Show when={props.toolbar}>{props.toolbar}</Show>
    </div>
  </div>
)

export const PanelBody: ParentComponent = (props) => (
  <div class="flex flex-col gap-6 px-4 pb-12 sm:px-8 max-w-[820px]">{props.children}</div>
)

// Muted "SECTION" subheader with a trailing count.
export const SectionLabel: Component<{ label: string; count?: number }> = (props) => (
  <div class="flex items-center gap-2 px-0.5">
    <span class="thesis-section-label">{props.label}</span>
    <Show when={props.count !== undefined}>
      <span class="text-10-regular text-text-weaker">{props.count}</span>
    </Show>
  </div>
)

// Rounded card wrapping a stack of rows (dividers between children handled by
// Row's border-b). Use for grouped lists.
export const Card: ParentComponent = (props) => (
  <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">{props.children}</div>
)

export const Row: ParentComponent<{ onClick?: () => void }> = (props) => (
  <div
    class="flex flex-wrap items-center gap-3 px-4 py-3.5 border-b border-border-weak-base last:border-none"
    classList={{ "cursor-pointer hover:bg-surface-raised-base/40": !!props.onClick }}
    onClick={props.onClick}
  >
    {props.children}
  </div>
)

export const EmptyState: Component<{ icon: IconProps["name"]; title: string; hint?: string }> = (props) => (
  <div class="flex flex-col items-center gap-3 text-center py-14">
    <div class="flex items-center justify-center size-11 rounded-[4px] border border-border-weak-base bg-surface-base/40 text-icon-weak-base">
      <Icon name={props.icon} size="normal" />
    </div>
    <span class="text-14-medium text-text-strong">{props.title}</span>
    <Show when={props.hint}>
      <p class="text-12-regular text-text-weak leading-relaxed max-w-[380px]">{props.hint}</p>
    </Show>
  </div>
)

// ── Toolbar pieces ──────────────────────────────────────────────────────────

const controlBase =
  "flex items-center gap-2 h-9 px-3 rounded-xs border border-border-weak-base bg-surface-base text-13-medium transition-colors"

export const SearchInput: Component<{ value: string; onInput: (v: string) => void; placeholder?: string }> = (
  props,
) => (
  <label class={`${controlBase} flex-1 min-w-[140px] focus-within:border-border-strong-base cursor-text`}>
    <Icon name="magnifying-glass" size="small" class="text-icon-weak-base flex-shrink-0" />
    <input
      type="text"
      value={props.value}
      placeholder={props.placeholder ?? "Search"}
      spellcheck={false}
      autocapitalize="off"
      autocomplete="off"
      class="flex-1 bg-transparent outline-none text-text-strong placeholder:text-text-weak/60"
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
    <Show when={props.value}>
      <button type="button" class="text-icon-weak-base hover:text-text-strong" onClick={() => props.onInput("")}>
        <Icon name="circle-x" size="small" />
      </button>
    </Show>
  </label>
)

export interface FilterOption {
  id: string
  label: string
  count?: number
}

export const FilterMenu: Component<{ options: FilterOption[]; value: string; onSelect: (id: string) => void }> = (
  props,
) => {
  const active = () => props.options.find((o) => o.id === props.value) ?? props.options[0]
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        class={`${controlBase} text-text-strong hover:bg-surface-raised-base/60 data-[expanded]:bg-surface-raised-base-active flex-shrink-0`}
      >
        <span class="truncate max-w-[160px]">
          {active()?.label}
          <Show when={active()?.count !== undefined}> ({active()?.count})</Show>
        </span>
        <Icon name="chevron-down" size="small" class="text-icon-weak-base" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
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

export const AddMenu: Component<{ label: string; items: AddItem[] }> = (props) => (
  <DropdownMenu>
    <DropdownMenu.Trigger
      class={`${controlBase} text-text-strong bg-surface-raised-base-active hover:bg-surface-raised-base-active/80 data-[expanded]:bg-surface-raised-base-active flex-shrink-0`}
    >
      <Icon name="plus" size="small" />
      <span class="truncate">{props.label}</span>
      <Icon name="chevron-down" size="small" class="text-icon-weak-base" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="mt-1 min-w-[240px]">
        <For each={props.items}>
          {(item) => (
            <DropdownMenu.Item onSelect={item.onSelect} class="items-start gap-2.5 py-2">
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

export const Toolbar: ParentComponent = (props) => <div class="flex items-center gap-2 flex-wrap">{props.children}</div>

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
  <label class="flex flex-col gap-1.5">
    <span class="text-12-medium text-text-strong">{props.label}</span>
    <Show
      when={props.multiline}
      fallback={
        <input
          type="text"
          value={props.value}
          disabled={props.disabled}
          placeholder={props.placeholder}
          class="h-9 px-3 rounded-xs border border-border-weak-base bg-surface-base text-13-regular text-text-strong outline-none focus:border-border-strong-base placeholder:text-text-weak/60"
          onInput={(e) => props.onInput(e.currentTarget.value)}
        />
      }
    >
      <textarea
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        rows={5}
        class="px-3 py-2 rounded-xs border border-border-weak-base bg-surface-base text-13-regular text-text-strong outline-none focus:border-border-strong-base resize-y min-h-[96px] placeholder:text-text-weak/60"
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
    class="h-9 px-4 rounded-xs text-13-medium transition-colors disabled:opacity-50"
    classList={{
      "bg-surface-raised-base-active text-text-strong hover:bg-surface-raised-base-active/80":
        (props.variant ?? "primary") === "primary",
      "border border-border-weak-base text-text-weak hover:text-text-strong hover:bg-surface-raised-base/60":
        props.variant === "ghost",
      "text-text-on-critical-base hover:bg-surface-critical-weak": props.variant === "danger",
    }}
  >
    {props.label}
  </button>
)
