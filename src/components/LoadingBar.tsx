import { Show } from "solid-js";

/* Determinate-style progress bar with the watermelon gradient.

   The rail is dark; the gradient (pink → leaf-green, no white middle)
   is a stable layer the same width as the rail. A "cover" sits on top,
   pinned to the right edge, and shrinks as progress advances — so the
   visible filled portion always shows the correct slice of the gradient
   (0% = pink only, 100% = pink → green).

   Two modes:

     - Determinate: pass `progress` ∈ [0, 1]. The cover width is set
       directly. Use this when you have a real percentage.
     - Time-driven (default): the cover shrinks via a CSS animation over
       `expectedSeconds`, easing toward ~90% so it never claims the work
       finished. Use this when you only know the operation is in
       progress, not how far through it is. */
export function LoadingBar(props: {
  active?: boolean;
  label?: string;
  sublabel?: string;
  progress?: number;
  expectedSeconds?: number;
}) {
  const isDeterminate = () => props.progress !== undefined;
  const coverWidth = () => {
    const p = Math.max(0, Math.min(1, props.progress ?? 0));
    return `${(1 - p) * 100}%`;
  };

  return (
    <Show when={props.active ?? true}>
      <div
        class="loadingbar"
        classList={{ "loadingbar--time": !isDeterminate() }}
        role="progressbar"
        aria-busy="true"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={isDeterminate() ? Math.round((props.progress ?? 0) * 100) : undefined}
      >
        <div class="loadingbar__rail">
          <div class="loadingbar__gradient" />
          <div
            class="loadingbar__cover"
            style={
              isDeterminate()
                ? { width: coverWidth() }
                : { "animation-duration": `${props.expectedSeconds ?? 30}s` }
            }
          />
        </div>
        <Show when={props.label}>
          <div class="loadingbar__label">{props.label}</div>
        </Show>
        <Show when={props.sublabel}>
          <div class="loadingbar__sublabel">{props.sublabel}</div>
        </Show>
      </div>
    </Show>
  );
}
