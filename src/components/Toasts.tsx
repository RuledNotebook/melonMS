import { For } from "solid-js";
import { dismissToast, toasts } from "../state/store";

/* Tiny toast stack pinned to the bottom-right. State lives in store.ts so
   anything in the app can pushToast(). */
export function Toasts() {
  return (
    <div class="toasts">
      <For each={toasts()}>
        {(t) => (
          <div class={`toast toast--${t.kind}`} onClick={() => dismissToast(t.id)}>
            {t.message}
            <span class="toast__close" aria-hidden>
              ×
            </span>
          </div>
        )}
      </For>
    </div>
  );
}
