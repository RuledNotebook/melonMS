import { createSignal, For, Show } from "solid-js";
import {
  isTauri,
  listDFolders,
  loadSpectrum,
  subscribeProgress,
} from "../api/sidecar";
import { runDeconvolution } from "../state/analysis";
import {
  deconvParams,
  deconvRunning,
  loadProgress,
  loading,
  pushToast,
  setDeconvParams,
  setError,
  setLoading,
  setLoadProgress,
  setSpectrum,
  spectrum,
} from "../state/store";
import type { DeconvParams, Sample } from "../state/types";
import { DEFAULT_DECONV_PARAMS } from "../state/types";
import { Dropdown } from "./Dropdown";
import { LoadingBar } from "./LoadingBar";

/* Left-rail project browser: drag-drop / pick a Bruker .d folder (or a
   parent folder containing many), then choose a deconvolution preset and
   run. Presets write a full DeconvParams snapshot into the store so the
   right-rail agent (planned) can read/tune the same fields. */

type Preset = "default" | "quick" | "high_res" | "wide_mass";

const PRESETS: Record<
  Preset,
  { label: string; description: string; params: DeconvParams }
> = {
  default: {
    label: "Default — Tier-1 native",
    description: "Balanced: 100 RL iterations, 1 Da mass bin, gaussian peak.",
    params: { ...DEFAULT_DECONV_PARAMS },
  },
  quick: {
    label: "Quick scan",
    description: "Fast triage: 30 iterations, 2 Da bin. Good for a first look.",
    params: {
      ...DEFAULT_DECONV_PARAMS,
      iterations: 30,
      mass_bin: 2,
      peak_fwhm: 0.6,
    },
  },
  high_res: {
    label: "High resolution",
    description: "Slow + accurate: 250 iterations, 0.25 Da bin, tight FWHM.",
    params: {
      ...DEFAULT_DECONV_PARAMS,
      iterations: 250,
      mass_bin: 0.25,
      peak_fwhm: 0.3,
      convergence: 1e-6,
    },
  },
  wide_mass: {
    label: "Wide mass window",
    description: "5–500 kDa search range. Pair with Quick scan for broad samples.",
    params: {
      ...DEFAULT_DECONV_PARAMS,
      mass_low: 5000,
      mass_high: 500_000,
      mass_bin: 2,
    },
  },
};

function endsWithD(path: string): boolean {
  const p = path.toLowerCase();
  return p.endsWith(".d") || p.endsWith(".d/") || p.endsWith(".d\\");
}

function isDemoMode(): boolean {
  return typeof window !== "undefined" && window.location.search.includes("demo=1");
}

function mockListDFolders(parent: string) {
  const samples: Sample[] = [
    {
      name: "BSA_20um_Native_isCID-0eV_1.d",
      path: `${parent}/BSA_20um_Native_isCID-0eV_1.d`,
      size_mb: 24.4,
      format: "timsTOF",
      valid: true,
    },
    {
      name: "Native-cTn_YG54_JBA-1_no-pool.d",
      path: `${parent}/Native-cTn_YG54_JBA-1_no-pool.d`,
      size_mb: 1248.4,
      format: "FTICR",
      valid: true,
    },
    {
      name: "20230501_denat_cTn000585.d",
      path: `${parent}/20230501_denat_cTn000585.d`,
      size_mb: 1971.9,
      format: "QTOF",
      valid: false,
    },
  ];
  samples.sort((a, b) => a.name.localeCompare(b.name));
  return { parent, samples };
}

export function ProjectSidebar() {
  const [active, setActive] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);
  const [pickerSamples, setPickerSamples] = createSignal<Sample[] | null>(null);
  const [pickerParent, setPickerParent] = createSignal<string | null>(null);
  const [showFallback, setShowFallback] = createSignal(false);
  const [fallbackPath, setFallbackPath] = createSignal("");
  const [preset, setPreset] = createSignal<Preset>("default");

  function clearPicker() {
    setPickerSamples(null);
    setPickerParent(null);
  }

  async function loadFromPath(rawPath: string) {
    const path = rawPath.trim().replace(/^["']|["']$/g, "");
    if (!path) return;

    if (endsWithD(path)) {
      // Intentionally do NOT clearPicker() here — the user expects the
      // multi-sample list to stay around so they can switch between
      // acquisitions in the same project without re-scanning the folder.
      setError(null);
      setLoading(true);
      setSpectrum(null);
      setLoadProgress({ stage: "Starting…" });
      const unsub = await subscribeProgress((data) => {
        setLoadProgress({
          stage: typeof data.stage === "string" ? data.stage : "Working…",
          step: typeof data.step === "number" ? data.step : undefined,
          steps: typeof data.steps === "number" ? data.steps : undefined,
          frame: typeof data.frame === "number" ? data.frame : undefined,
          frames: typeof data.frames === "number" ? data.frames : undefined,
        });
      });
      try {
        const result = await loadSpectrum({
          path,
          mz_min: deconvParams.mz_min,
          mz_max: deconvParams.mz_max,
          bin_width:
            deconvParams.peak_fwhm > 0
              ? Math.min(deconvParams.peak_fwhm, 0.5)
              : 0.5,
        });
        setSpectrum(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        unsub();
        setLoading(false);
        setLoadProgress(null);
      }
      return;
    }

    setError(null);
    setScanning(true);
    try {
      let result;
      if (isDemoMode()) {
        result = mockListDFolders(path);
      } else if (!isTauri()) {
        setError(
          "Browser mode supports a single `.d` folder only — open via `npm run tauri:dev` to scan a parent folder."
        );
        return;
      } else {
        result = await listDFolders(path);
      }
      if (result.samples.length === 0) {
        setError(`No \`.d\` folders found in ${result.parent}`);
        clearPicker();
        return;
      }
      setPickerParent(result.parent);
      setPickerSamples(result.samples);
    } catch (e) {
      setError(`Could not scan folder: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
    }
  }

  // Tauri 2 emits drop events at the OS level for the whole window, so the
  // listener is global even though the affordance lives in the sidebar.
  if (isTauri()) {
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      getCurrentWebview().onDragDropEvent((evt) => {
        if (evt.payload.type === "over") setActive(true);
        else if (evt.payload.type === "leave") setActive(false);
        else if (evt.payload.type === "drop") {
          setActive(false);
          if (evt.payload.paths.length > 0) loadFromPath(evt.payload.paths[0]);
        }
      });
    });
  }

  async function pickFolder() {
    console.log("[pickFolder] click handler entered");
    pushToast("info", "Opening folder picker…", 1500);

    if (!isTauri()) {
      console.warn("[pickFolder] not in Tauri runtime, showing path-paste fallback");
      setShowFallback(true);
      return;
    }

    // 1) Try the native Rust command first (Mac → osascript). If the
    //    command isn't registered (older binary still running), the
    //    invoke will reject with "Command pick_folder not found" — that's
    //    our cue to fall back to the plugin-dialog path.
    try {
      console.log("[pickFolder] invoking pick_folder Rust command");
      const { invoke } = await import("@tauri-apps/api/core");
      const selection = await invoke<string | null>("pick_folder", {
        title: "Select a Bruker .d folder, or a folder containing multiple",
      });
      console.log("[pickFolder] pick_folder returned:", selection);
      if (typeof selection === "string" && selection) {
        loadFromPath(selection);
      } else {
        console.log("[pickFolder] user cancelled");
      }
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[pickFolder] pick_folder threw:", msg);
      const notFound =
        msg.toLowerCase().includes("not found") ||
        msg.toLowerCase().includes("not registered") ||
        msg.toLowerCase().includes("mac-only");
      if (!notFound) {
        pushToast("error", `Folder picker failed: ${msg}`);
        return;
      }
      console.warn(
        "[pickFolder] native pick_folder unavailable, falling back to plugin-dialog"
      );
    }

    // 2) Fallback: tauri-plugin-dialog. Known to panic on some Mac
    //    configs (objc2-app-kit 0.3.2 / NSOpenPanel NULL), but works on
    //    Linux + Windows and on Mac builds where NSApp activates cleanly.
    try {
      console.log("[pickFolder] invoking plugin-dialog open(directory)");
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({
        directory: true,
        multiple: false,
        title: "Select a Bruker .d folder, or a folder containing multiple",
      });
      console.log("[pickFolder] plugin-dialog returned:", selection);
      if (typeof selection === "string") loadFromPath(selection);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[pickFolder] plugin-dialog threw:", msg);
      pushToast("error", `Folder picker failed: ${msg}`);
      setError(`Folder picker failed: ${msg}`);
    }
  }

  function applyPreset(p: Preset) {
    setPreset(p);
    setDeconvParams(PRESETS[p].params);
  }

  return (
    <aside class="sidebar">
      <div class="sidebar__header">
        <span class="sidebar__brand">Project</span>
        <button
          class="sidebar__new"
          onClick={pickFolder}
          title="Pick a .d folder or a parent folder containing many"
        >
          + New Project
        </button>
      </div>

      <div class="sidebar__body">
        <div
          class="sidebar__drop"
          classList={{ "is-active": active() }}
          onClick={pickFolder}
          onDragOver={(e) => {
            e.preventDefault();
            setActive(true);
          }}
          onDragLeave={() => setActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setActive(false);
            if (!isTauri()) setShowFallback(true);
          }}
        >
          <div class="sidebar__drop-icon">▼</div>
          <div class="sidebar__drop-title">
            Drop a Bruker <code>.d</code> folder
          </div>
          <div class="sidebar__drop-hint">or a folder containing many</div>
        </div>

        <Show when={scanning()}>
          <LoadingBar
            label="Scanning for .d folders…"
            expectedSeconds={2}
          />
        </Show>
        <Show when={loading()}>
          {(() => {
            const lp = loadProgress;
            const progressFraction = () => {
              const p = lp();
              if (!p) return undefined;
              if (
                typeof p.frame === "number" &&
                typeof p.frames === "number" &&
                p.frames > 0
              ) {
                // Frame loop is the dominant cost (~80% of total). Map
                // frame progress into a 5–95% window so the bar still
                // moves during the format-detect / open / downsample
                // bookend stages.
                return 0.05 + 0.9 * (p.frame / p.frames);
              }
              if (typeof p.step === "number" && typeof p.steps === "number" && p.steps > 0) {
                return p.step / p.steps;
              }
              return undefined;
            };
            const subline = () => {
              const p = lp();
              if (!p) return undefined;
              const parts: string[] = [];
              if (typeof p.frame === "number" && typeof p.frames === "number") {
                parts.push(`frame ${p.frame.toLocaleString()} / ${p.frames.toLocaleString()}`);
              }
              if (typeof p.step === "number" && typeof p.steps === "number") {
                parts.push(`step ${p.step}/${p.steps}`);
              }
              return parts.length ? parts.join(" · ") : undefined;
            };
            return (
              <LoadingBar
                label={lp()?.stage ?? "Reading .d folder · calibrating spectrum"}
                sublabel={subline()}
                progress={progressFraction()}
                expectedSeconds={90}
              />
            );
          })()}
        </Show>

        <Show when={showFallback() && !isTauri()}>
          <div class="sidebar__fallback" onClick={(e) => e.stopPropagation()}>
            <div class="sidebar__fallback-note">
              Browser mode: paste an absolute path to a <code>.d</code> folder.
            </div>
            <input
              type="text"
              value={fallbackPath()}
              onInput={(e) => setFallbackPath(e.currentTarget.value)}
              placeholder="/path/to/sample.d"
            />
            <button onClick={() => loadFromPath(fallbackPath())}>Load</button>
          </div>
        </Show>

        <Show when={pickerSamples()}>
          {(samples) => (
            <div class="sidebar__samples">
              <div class="sidebar__samples-head">
                <span class="sidebar__samples-count">
                  {samples().length} <code>.d</code> found
                </span>
                <button class="sidebar__samples-cancel" onClick={clearPicker}>
                  ×
                </button>
              </div>
              <div
                class="sidebar__samples-parent"
                title={pickerParent() ?? ""}
              >
                {pickerParent() ?? ""}
              </div>
              <ul class="sidebar__samples-list">
                <For each={samples()}>
                  {(s) => {
                    const isLoaded = () => spectrum()?.path === s.path;
                    const isCurrentlyLoading = () =>
                      loading() && spectrum() === null;
                    return (
                      <li
                        classList={{
                          "is-invalid": !s.valid,
                          "is-loaded": isLoaded(),
                        }}
                      >
                        <button
                          class="sidebar__sample-row"
                          classList={{ "is-loaded": isLoaded() }}
                          disabled={!s.valid || (isCurrentlyLoading() && !isLoaded())}
                          title={
                            s.valid
                              ? `${s.format} · ${s.path}`
                              : s.format === "QTOF"
                              ? "QTOF .d — needs Docker .baf → mzML conversion (not wired in v0)"
                              : `${s.format} — not a loadable format`
                          }
                          onClick={() => {
                            if (isLoaded()) return;
                            loadFromPath(s.path);
                          }}
                        >
                          <span class="sidebar__sample-name">{s.name}</span>
                          <span
                            class="sidebar__sample-fmt"
                            classList={{
                              "is-tims": s.format === "timsTOF",
                              "is-fticr": s.format === "FTICR",
                              "is-qtof": s.format === "QTOF",
                              "is-unknown": s.format === "unknown",
                            }}
                          >
                            {s.format}
                          </span>
                          <span class="sidebar__sample-size">
                            {s.size_mb.toFixed(1)} MB
                          </span>
                        </button>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </div>
          )}
        </Show>

        <Show when={spectrum()}>
          {(s) => (
            <div class="sidebar__loaded">
              <div class="sidebar__section-head">Loaded</div>
              <div class="sidebar__loaded-name" title={s().path}>
                {s().name}
              </div>
              <div class="sidebar__loaded-meta">
                {s().n_frames.toLocaleString()} frames ·{" "}
                {s().n_points_full.toLocaleString()} pts · bin {s().bin_width}
              </div>
            </div>
          )}
        </Show>

        <Show when={spectrum()}>
          <div class="sidebar__deconv">
            <div class="sidebar__section-head">Deconvolution</div>
            <Dropdown<Preset>
              value={preset()}
              options={(Object.entries(PRESETS) as [Preset, (typeof PRESETS)[Preset]][]).map(
                ([k, v]) => ({
                  value: k,
                  label: v.label,
                  description: v.description,
                })
              )}
              onChange={(v) => applyPreset(v)}
            />
            <button
              class="sidebar__run"
              disabled={deconvRunning() || loading()}
              onClick={() => runDeconvolution()}
            >
              <Show
                when={deconvRunning()}
                fallback={<span>Run Deconvolution</span>}
              >
                <span class="sidebar__run-spinner" />
                <span>Running…</span>
              </Show>
            </button>
          </div>
        </Show>
      </div>
    </aside>
  );
}
