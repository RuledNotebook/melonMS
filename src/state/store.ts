import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import {
  DEFAULT_DECONV_PARAMS,
  DEFAULT_FILTER_PARAMS,
  type DeconvParams,
  type FilterParams,
  type SidecarStatus,
  type SpectrumResult,
} from "./types";

/* Single global store. Solid's signals are fine-grained, so components only
   re-render when the slice they read actually changes. */

export const [spectrum, setSpectrum] = createSignal<SpectrumResult | null>(null);
export const [loading, setLoading] = createSignal(false);
export const [error, setError] = createSignal<string | null>(null);

export const [sidecarStatus, setSidecarStatus] = createSignal<SidecarStatus>({
  kind: "absent",
});

/* Tier-1 parameter store, fully scaffolded for v1 wiring. */
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
