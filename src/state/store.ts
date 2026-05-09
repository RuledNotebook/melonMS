import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import {
  DEFAULT_DECONV_PARAMS,
  DEFAULT_FILTER_PARAMS,
  type DeconvParams,
  type DeconvResult,
  type FilterParams,
  type FilterResult,
  type SidecarStatus,
  type SpectrumResult,
  type Toast,
} from "./types";

/* Single global store. Solid's signals are fine-grained, so components only
   re-render when the slice they read actually changes. */

export const [spectrum, setSpectrum] = createSignal<SpectrumResult | null>(null);
export const [loading, setLoading] = createSignal(false);
export const [error, setError] = createSignal<string | null>(null);

/* Streaming progress for long-running commands (load_spectrum mainly).
   Updated by the sidecar-progress Tauri event subscription in
   ProjectSidebar; consumed by LoadingBar. */
export interface LoadProgress {
  stage: string;
  step?: number;
  steps?: number;
  frame?: number;
  frames?: number;
}
export const [loadProgress, setLoadProgress] = createSignal<LoadProgress | null>(null);

export const [sidecarStatus, setSidecarStatus] = createSignal<SidecarStatus>({
  kind: "absent",
});

/* Tier-1 parameter store, fully wired in v1. */
export const [deconvParams, setDeconvParams] = createStore<DeconvParams>({
  ...DEFAULT_DECONV_PARAMS,
});

export const [filterParams, setFilterParams] = createStore<FilterParams>({
  ...DEFAULT_FILTER_PARAMS,
});

export function resetDeconvParams() {
  setDeconvParams({ ...DEFAULT_DECONV_PARAMS });
}

export function resetFilterParams() {
  setFilterParams({ ...DEFAULT_FILTER_PARAMS });
}

/* ---- Deconvolution state ---- */

export const [deconvResult, setDeconvResult] = createSignal<DeconvResult | null>(null);
export const [deconvRunning, setDeconvRunning] = createSignal(false);
export const [deconvError, setDeconvError] = createSignal<string | null>(null);

/* ---- Filtering state ---- */

export const [filterResult, setFilterResult] = createSignal<FilterResult | null>(null);
export const [filterRunning, setFilterRunning] = createSignal(false);

/* Selected peak (from MassView click) — keyed by mass value. */
export const [selectedMass, setSelectedMass] = createSignal<number | null>(null);

/* Toggle in MassView: show only filter-passing peaks vs. all. */
export const [showOnlyPassing, setShowOnlyPassing] = createSignal(false);

/* ---- Toast notifications ---- */

const [toasts, setToasts] = createSignal<Toast[]>([]);
let toastCounter = 0;

export { toasts };

export function pushToast(kind: Toast["kind"], message: string, ttlMs = 5000) {
  const id = ++toastCounter;
  setToasts((cur) => [...cur, { id, kind, message }]);
  if (ttlMs > 0) {
    setTimeout(() => dismissToast(id), ttlMs);
  }
  return id;
}

export function dismissToast(id: number) {
  setToasts((cur) => cur.filter((t) => t.id !== id));
}

/* ---- Reset everything related to a spectrum on new load. ---- */

export function clearAnalysisState() {
  setDeconvResult(null);
  setDeconvError(null);
  setDeconvRunning(false);
  setFilterResult(null);
  setFilterRunning(false);
  setSelectedMass(null);
}
