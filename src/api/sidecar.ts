/* Thin wrapper around Tauri's `invoke` for talking to the Python sidecar.

   Two Rust commands are exposed in src-tauri/src/main.rs:
     - sidecar_status()   -> SidecarStatus
     - sidecar_call(cmd, params) -> JSON value

   When the page is loaded in a plain browser (no Tauri runtime), invoke() is
   undefined, so we fall back to a clear error. This lets `npm run dev` boot
   the SPA for UI work without confusingly silent failures. */

import type {
  DeconvParams,
  DeconvResult,
  FilterParams,
  FilterResult,
  ListDFoldersResult,
  LoadSpectrumParams,
  MassPeak,
  SidecarStatus,
  SpectrumResult,
} from "../state/types";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function getInvoke(): InvokeFn | null {
  // Tauri 2.x exposes the API via window.__TAURI_INTERNALS__ once the runtime
  // is alive. We import lazily so this module remains usable in pure-browser
  // dev mode (where `@tauri-apps/api` works but invoke() throws).
  const w = globalThis as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return null;
  return async <T,>(cmd: string, args?: Record<string, unknown>) => {
    const mod = await import("@tauri-apps/api/core");
    return (await mod.invoke(cmd, args)) as T;
  };
}

export function isTauri(): boolean {
  return getInvoke() !== null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error(
      "Tauri runtime not available. Run via `npm run tauri:dev` (not plain `npm run dev`)."
    );
  }
  return invoke<T>(cmd, args);
}

export async function getSidecarStatus(): Promise<SidecarStatus> {
  return call<SidecarStatus>("sidecar_status");
}

export async function loadSpectrum(
  params: LoadSpectrumParams
): Promise<SpectrumResult> {
  return call<SpectrumResult>("sidecar_call", {
    command: "load_spectrum",
    params,
  });
}

/* Walks a parent folder and returns the list of `.d` subdirectories so the
   sidebar can show an inline sample picker for multi-acquisition workflows.
   See python/commands/list_d_folders.py for the contract. */
export async function listDFolders(path: string): Promise<ListDFoldersResult> {
  return call<ListDFoldersResult>("sidecar_call", {
    command: "list_d_folders",
    params: { path },
  });
}

/* Generic escape hatch — useful while wiring v1 commands. */
export async function sidecarCall<T = unknown>(
  command: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return call<T>("sidecar_call", { command, params });
}

/* ---- Progress events ----
   The Python sidecar can emit interim "progress" events while a long
   command runs (load_spectrum streams stage + frame counts). The Rust
   reader thread forwards them as Tauri events on the channel
   "sidecar-progress". This helper wraps event subscription so callers
   don't need to import @tauri-apps/api/event directly. */
export interface SidecarProgressData {
  stage?: string;
  step?: number;
  steps?: number;
  frame?: number;
  frames?: number;
  [key: string]: unknown;
}

export async function subscribeProgress(
  cb: (data: SidecarProgressData) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<{ id: string; data: SidecarProgressData }>(
    "sidecar-progress",
    (e) => {
      if (e.payload?.data) cb(e.payload.data);
    }
  );
  return unlisten;
}

/* ---- v1: deconvolution ----
   The Python contract uses `mz_array`, `intensity_array`, `deconv_params`
   (see python/commands/deconvolve.py header). We translate FE shapes to
   that contract here so the rest of the FE can use ergonomic names. The
   FE's `background_subtraction: boolean` is collapsed onto the Python
   `background: "none" | "linear" | "polynomial"` triple-state. */
export interface DeconvolveCallParams {
  mz: number[];
  intensity: number[];
  params: DeconvParams;
  /** Override n_decoys (default sidecar value 200). Set to 20 for
      Quick-FDR preview mode. */
  n_decoys?: number;
}

function toEngineDeconvParams(
  p: DeconvParams,
  n_decoys?: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    mass_low: p.mass_low,
    mass_high: p.mass_high,
    charge_low: p.charge_low,
    charge_high: p.charge_high,
    mass_bin: p.mass_bin,
    peak_fwhm: p.peak_fwhm,
    peak_shape: p.peak_shape,
    iterations: p.iterations,
    convergence: p.convergence,
    beta_charge: p.beta_charge,
    beta_mass: p.beta_mass,
    background: p.background_subtraction ? "linear" : "none",
    noise_threshold: p.noise_threshold,
  };
  if (typeof n_decoys === "number") out.n_decoys = n_decoys;
  return out;
}

export async function deconvolve(
  args: DeconvolveCallParams
): Promise<DeconvResult> {
  return sidecarCall<DeconvResult>("deconvolve", {
    mz_array: args.mz,
    intensity_array: args.intensity,
    deconv_params: toEngineDeconvParams(args.params, args.n_decoys),
  });
}

/* ---- v1: post-hoc filters ----
   Python expects `filters`, not `params`. */
export interface ApplyFiltersCallParams {
  mass_list: MassPeak[];
  params: FilterParams;
}

export async function applyFilters(
  args: ApplyFiltersCallParams
): Promise<FilterResult> {
  return sidecarCall<FilterResult>("apply_filters", {
    mass_list: args.mass_list,
    filters: args.params,
  });
}
