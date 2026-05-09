import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";

/* Custom dropdown that matches the watermelon theme. We don't use the
   native <select> here because every browser/OS renders it with its own
   chrome (Mac NSPopUpButton, Windows ComboBox, etc.) and we want a
   consistent dark / pink-accent look across platforms. */

export interface DropdownOption<T> {
  value: T;
  label: string;
  description?: string;
}

export function Dropdown<T extends string | number>(props: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const current = () => props.options.find((o) => o.value === props.value);

  function onDocClick(e: MouseEvent) {
    if (!containerRef) return;
    if (!containerRef.contains(e.target as Node)) setOpen(false);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") setOpen(false);
  }

  createEffect(() => {
    if (open()) {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    } else {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    }
  });

  onCleanup(() => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  });

  return (
    <div class="dropdown" ref={containerRef}>
      <button
        type="button"
        class="dropdown__trigger"
        classList={{ "is-open": open() }}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open());
        }}
      >
        <span class="dropdown__trigger-label">
          {current()?.label ?? props.placeholder ?? "—"}
        </span>
        <span class="dropdown__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      <Show when={open()}>
        <div class="dropdown__panel" role="listbox">
          <For each={props.options}>
            {(opt) => (
              <button
                type="button"
                class="dropdown__option"
                classList={{ "is-selected": opt.value === props.value }}
                role="option"
                aria-selected={opt.value === props.value}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span class="dropdown__option-label">{opt.label}</span>
                <Show when={opt.description}>
                  <span class="dropdown__option-desc">{opt.description}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
