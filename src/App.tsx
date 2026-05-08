import { createEffect, createMemo, on, onMount, Show } from "solid-js";
import { DropZone } from "./components/DropZone";
import { FilterPane } from "./components/FilterPane";
import { MassView } from "./components/MassView";
import { ParameterPane } from "./components/ParameterPane";
import { SpectrumView } from "./components/SpectrumView";
import { Toasts } from "./components/Toasts";
import { Toolbar } from "./components/Toolbar";
import { getSidecarStatus, isTauri } from "./api/sidecar";
import {
  cancelInFlightForNewSpectrum,
  scheduleDeconvRerun,
} from "./state/analysis";
import {
  clearAnalysisState,
  deconvParams,
  deconvResult,
  error,
  loading,
  setSidecarStatus,
  setSpectrum,
  sidecarStatus,
  spectrum,
} from "./state/store";

/* Visit ?demo=1 in the browser to load a synthetic spectrum without the
   Tauri sidecar — useful for SPA-only UI work and screenshot capture. */
function maybeLoadDemoSpectrum() {
  if (typeof window === "undefined") return;
  if (!window.location.search.includes("demo=1")) return;
  const N = 4000;
  const mz: number[] = new Array(N);
  const intensity: number[] = new Array(N);
  // synthetic charge envelope around m/z 3500–5500 with a few peaks
  const centers = [3850, 4120, 4480, 4910, 5440];
  const widths = [12, 13, 14, 15, 17];
  const amps = [800_000, 1_100_000, 950_000, 720_000, 480_000];
  for (let i = 0; i < N; i++) {
    const x = 600 + (i / (N - 1)) * 5400;
    mz[i] = x;
    let y = 4000 + 1500 * Math.exp(-(((x - 4000) / 1800) ** 2)); // baseline
    for (let k = 0; k < centers.length; k++) {
      y += amps[k] * Math.exp(-(((x - centers[k]) / widths[k]) ** 2));
    }
    // add narrow noise
    y += Math.random() * 8000;
    intensity[i] = y;
  }
  setSpectrum({
    name: "demo_spectrum.d",
    path: "(synthetic)",
    format: "timsTOF",
    calibration: "synthetic demo data",
    n_frames: 285,
    mz_range: [600, 6000],
    bin_width: 1.35,
    mz,
    intensity,
    n_points_full: N,
    downsampled: false,
  });
}

export function App() {
  onMount(async () => {
    maybeLoadDemoSpectrum();
    // ?autorun=1 triggers a run-deconvolution after demo load (handy for
    // headless screenshots and end-to-end smoke checks).
    if (typeof window !== "undefined" && window.location.search.includes("autorun=1")) {
      // Defer one tick so the spectrumIdentity effect's clearAnalysisState
      // has run before we kick off the deconv.
      queueMicrotask(() => {
        import("./state/analysis").then(({ runDeconvolution }) => {
          runDeconvolution();
        });
      });
    }
    if (!isTauri()) {
      setSidecarStatus({
        kind: "error",
        message: "Browser dev mode (no Tauri runtime). Use `npm run tauri:dev`.",
      });
      return;
    }
    setSidecarStatus({ kind: "starting" });
    try {
      const status = await getSidecarStatus();
      setSidecarStatus(status);
    } catch (e) {
      setSidecarStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  /* New spectrum -> clear any analysis state and cancel pending work. */
  const spectrumIdentity = createMemo(() => spectrum()?.path ?? null);
  createEffect(
    on(spectrumIdentity, (path, prev) => {
      if (path !== prev) {
        cancelInFlightForNewSpectrum();
        clearAnalysisState();
      }
    })
  );

  /* Debounced auto-rerun of deconvolution on parameter changes (800ms). */
  createEffect(() => {
    // Subscribe to all top-level deconvParams keys.
    deconvParams.mz_min;
    deconvParams.mz_max;
    deconvParams.charge_low;
    deconvParams.charge_high;
    deconvParams.mass_low;
    deconvParams.mass_high;
    deconvParams.mass_bin;
    deconvParams.peak_fwhm;
    deconvParams.peak_shape;
    deconvParams.iterations;
    deconvParams.convergence;
    deconvParams.beta_charge;
    deconvParams.beta_mass;
    deconvParams.background_subtraction;
    deconvParams.noise_threshold;
    scheduleDeconvRerun();
  });

  function statusDot() {
    const s = sidecarStatus();
    if (s.kind === "ready") return "ok";
    if (s.kind === "starting") return "busy";
    if (s.kind === "busy") return "busy";
    if (s.kind === "error") return "err";
    return "idle";
  }

  function statusLabel() {
    const s = sidecarStatus();
    switch (s.kind) {
      case "absent":   return "sidecar: not started";
      case "starting": return "sidecar: starting…";
      case "ready":    return `sidecar: ready (${s.commands.length} cmds)`;
      case "busy":     return `sidecar: ${s.command}…`;
      case "error":    return `sidecar error: ${s.message}`;
    }
  }

  return (
    <div class="app">
      <header class="app__titlebar">
        melonMS
        <small>native top-down · v1</small>
      </header>

      <Toolbar />

      <main class="app__main">
        <ParameterPane />

        <section class="app__center">
          <Show
            when={spectrum() || loading() || error()}
            fallback={<DropZone />}
          >
            <Show when={deconvResult()} fallback={<SpectrumView />}>
              <div class="app__centersplit">
                <SpectrumView />
                <MassView />
              </div>
            </Show>
          </Show>
        </section>

        <FilterPane />
      </main>

      <footer class="app__statusbar">
        <span>
          <span class={`dot ${statusDot()}`} />
          {statusLabel()}
        </span>
        <Show when={spectrum()}>
          {(s) => (
            <span>
              {s().format} · {s().calibration.split(" ").slice(0, 3).join(" ")} ·{" "}
              {s().n_frames} frames
            </span>
          )}
        </Show>
        <span style={{ "margin-left": "auto" }}>
          {isTauri() ? "tauri" : "browser-dev"}
        </span>
      </footer>

      <Toasts />
    </div>
  );
}
