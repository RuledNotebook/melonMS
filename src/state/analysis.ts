/* Orchestration layer between the Solid stores and the sidecar.
   Owns:
     - The "run deconv" action (manual button + debounced auto-rerun on params).
     - The debounced filter pipeline that follows every successful deconv.
     - Cancel-in-flight semantics on new spectrum loads.

   We don't have AbortController for invoke()-style sidecar calls, so "cancel"
   here means "ignore the result if it arrives after we've moved on." A token
   counter on each call provides cheap, race-safe identity. */

import { unwrap } from "solid-js/store";
import {
  applyFilters,
  deconvolve,
  isTauri,
  subscribeProgress,
} from "../api/sidecar";
import {
  deconvParams,
  deconvResult,
  deconvRunning,
  filterParams,
  pushToast,
  setDeconvError,
  setDeconvProgress,
  setDeconvResult,
  setDeconvRunning,
  setFilterResult,
  setFilterRunning,
  setSelectedMass,
  spectrum,
} from "./store";
import type { DeconvResult, FilterResult, MassPeak } from "./types";

let deconvToken = 0;
let queuedRerun = false;
let filterToken = 0;
let filterDebounce: ReturnType<typeof setTimeout> | null = null;
let deconvDebounce: ReturnType<typeof setTimeout> | null = null;

/* Run deconvolution against the currently-loaded spectrum. Resolves true on
   success. If `silent` is true, no error toast is raised (used by the
   debounced auto-rerun so a transient error doesn't spam the user). */
export async function runDeconvolution(opts: { silent?: boolean } = {}): Promise<boolean> {
  const s = spectrum();
  if (!s) return false;

  // If something is already running, queue a re-run; the in-flight call's
  // .finally() will trigger another runDeconvolution() once it returns.
  if (deconvRunning()) {
    queuedRerun = true;
    return false;
  }

  const myToken = ++deconvToken;
  setDeconvRunning(true);
  setDeconvError(null);
  setDeconvProgress({ stage: "Starting…" });

  // Snapshot params so a mid-flight store change doesn't desync them from the
  // call's actual inputs.
  const params = { ...unwrap(deconvParams) };

  // Subscribe to sidecar progress events for the duration of this call.
  // When the sidecar.py emits a stage change, refresh the deconvProgress
  // signal so the UI bar can update.
  const unsub = await subscribeProgress((data) => {
    setDeconvProgress({
      stage: typeof data.stage === "string" ? data.stage : "Working…",
      step: typeof data.step === "number" ? data.step : undefined,
      steps: typeof data.steps === "number" ? data.steps : undefined,
    });
  });

  try {
    let result: DeconvResult;
    if (isTauri()) {
      result = await deconvolve({
        mz: s.mz,
        intensity: s.intensity,
        params,
      });
    } else {
      // Browser dev: synthesize a plausible mass list so the UI is exercisable
      // without the real sidecar. Picks peaks at the paper baselines so the
      // identity matcher in PeakDetail has something to bite.
      result = await fakeAsync(makeDemoDeconvResult(), 350);
    }
    if (myToken !== deconvToken) return false; // superseded
    setDeconvResult(result);
    setSelectedMass(result.mass_list[0]?.mass ?? null);
    triggerFilterPipeline();
    return true;
  } catch (e) {
    if (myToken !== deconvToken) return false;
    const msg = e instanceof Error ? e.message : String(e);
    setDeconvError(msg);
    if (!opts.silent) pushToast("error", `Deconvolution failed: ${msg}`);
    return false;
  } finally {
    unsub();
    if (myToken === deconvToken) {
      setDeconvRunning(false);
      setDeconvProgress(null);
      if (queuedRerun) {
        queuedRerun = false;
        // schedule a microtask so callers see a "stopped running" tick first
        Promise.resolve().then(() => runDeconvolution({ silent: true }));
      }
    }
  }
}

/* Debounced auto re-run when deconv params change (800ms window). Only
   triggers once the user has explicitly run deconv at least once — otherwise
   adjusting parameters before the first run would auto-fire. */
export function scheduleDeconvRerun() {
  if (deconvDebounce) clearTimeout(deconvDebounce);
  deconvDebounce = setTimeout(() => {
    deconvDebounce = null;
    if (!spectrum()) return;
    if (!deconvResult()) return;
    runDeconvolution({ silent: true });
  }, 800);
}

/* Reset state and cancel any in-flight work — call this when a new spectrum
   is loaded. */
export function cancelInFlightForNewSpectrum() {
  deconvToken++;            // bumps token, in-flight result will be ignored
  filterToken++;
  queuedRerun = false;
  if (deconvDebounce) {
    clearTimeout(deconvDebounce);
    deconvDebounce = null;
  }
  if (filterDebounce) {
    clearTimeout(filterDebounce);
    filterDebounce = null;
  }
}

/* ---- Filter pipeline ---- */

export function triggerFilterPipeline() {
  if (filterDebounce) clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => {
    filterDebounce = null;
    runFilterPipelineNow();
  }, 300);
}

export async function runFilterPipelineNow(): Promise<void> {
  const dec = deconvResult();
  if (!dec) return;
  const myToken = ++filterToken;
  setFilterRunning(true);
  const params = { ...unwrap(filterParams) };
  try {
    let result: FilterResult;
    if (isTauri()) {
      result = await applyFilters({
        mass_list: dec.mass_list,
        params,
      });
    } else {
      result = await fakeAsync(makeDemoFilterResult(dec.mass_list), 80);
    }
    if (myToken !== filterToken) return;
    setFilterResult(result);
  } catch (e) {
    if (myToken !== filterToken) return;
    const msg = e instanceof Error ? e.message : String(e);
    pushToast("error", `Filter pass failed: ${msg}`);
  } finally {
    if (myToken === filterToken) setFilterRunning(false);
  }
}

/* ---- Browser-mode synthetic results (so the SPA is testable in dev) ---- */

function fakeAsync<T>(value: T, ms: number): Promise<T> {
  return new Promise((res) => setTimeout(() => res(value), ms));
}

function makeDemoDeconvResult(): DeconvResult {
  // Hand-picked baselines roughly matching paper masses so PeakDetail's
  // identity matcher finds a match.
  const seeds = [
    { mass: 77144, intensity: 1.0 },
    { mass: 72886, intensity: 0.78 },
    { mass: 33000, intensity: 0.62 },
    { mass: 24000, intensity: 0.55 },
    { mass: 19728, intensity: 0.48 },
    { mass: 18481, intensity: 0.42 },
    // Some noise peaks too:
    { mass: 12500, intensity: 0.21 },
    { mass: 41200, intensity: 0.18 },
    { mass: 55600, intensity: 0.14 },
    { mass: 91300, intensity: 0.11 },
  ];
  const maxRaw = 1_500_000;
  const mass_list: MassPeak[] = seeds.map((seed) => {
    const raw = seed.intensity * maxRaw;
    const n_z = 8 + Math.round(Math.random() * 6);
    const charge_envelope = Array.from({ length: n_z }, (_, k) => {
      const z = 8 + k;
      const peak = n_z / 2 + 7;
      const env = Math.exp(-Math.pow((z - peak) / 3, 2));
      return { charge: z, intensity: raw * env * 0.6 };
    });
    return {
      mass: seed.mass,
      intensity: raw,
      rel_intensity: seed.intensity,
      fdr: 0.005 + Math.random() * 0.05,
      n_z,
      envelope_score: 0.6 + Math.random() * 0.39,
      charge_envelope,
    };
  });
  return {
    mass_list,
    metadata: {
      n_iterations_run: 100,
      converged: true,
      runtime_ms: 1234,
    },
  };
}

function makeDemoFilterResult(mass_list: MassPeak[]): FilterResult {
  let f1 = 0, f2 = 0, f4 = 0, all = 0;
  const filtered_mass_list = mass_list.map((p) => {
    // toy logic: pass thresholds correlated with rel_intensity
    const f1_pass = p.n_z >= 3 && p.rel_intensity >= 0.15;
    const f2_pass = p.envelope_score >= 0.5;
    const f4a_pass = p.fdr < 0.05;
    const f4b_pass = p.fdr < 0.05;
    const all_pass = f1_pass && f2_pass && f4a_pass && f4b_pass;
    if (f1_pass) f1++;
    if (f2_pass) f2++;
    if (f4a_pass && f4b_pass) f4++;
    if (all_pass) all++;
    return {
      mass: p.mass,
      f1_pass,
      f2_pass,
      f4a_pass,
      f4b_pass,
      cluster_id: f1_pass ? `c${Math.floor(p.mass / 10000)}` : undefined,
      all_pass,
    };
  });
  return {
    filtered_mass_list,
    summary: {
      total_input: mass_list.length,
      f1_passing: f1,
      f2_passing: f2,
      f4_passing: f4,
      all_passing: all,
    },
  };
}
