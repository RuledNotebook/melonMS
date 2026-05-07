/* TypeScript shapes that mirror the JSON contract emitted by python/sidecar.py.
   Keep these in lockstep with python/commands/load_spectrum.py. */

export type SidecarOk<T> = { id: string; ok: true; result: T };
export type SidecarErr = {
  id: string;
  ok: false;
  error: { type: string; message: string; traceback?: string };
};
export type SidecarResponse<T> = SidecarOk<T> | SidecarErr;

export interface LoadSpectrumParams {
  path: string;
  mz_min?: number;
  mz_max?: number;
  bin_width?: number;
  downsample_target?: number;
}

export interface SpectrumResult {
  name: string;
  path: string;
  format: string;
  calibration: string;
  n_frames: number;
  mz_range: [number, number];
  bin_width: number;
  mz: number[];
  intensity: number[];
  n_points_full: number;
  downsampled: boolean;
}

/* ----- Tier-1 UniDec-equivalent parameters ----- */

export type PeakShape = "gaussian" | "lorentzian" | "split_gl";

export interface DeconvParams {
  // m/z and charge windows
  mz_min: number;
  mz_max: number;
  charge_low: number;
  charge_high: number;

  // mass-domain grid
  mass_low: number;
  mass_high: number;
  mass_bin: number;

  // peak model
  peak_fwhm: number;
  peak_shape: PeakShape;

  // EM / RL solver
  iterations: number;
  convergence: number;

  // smoothing priors
  beta_charge: number;
  beta_mass: number;

  // preprocessing
  background_subtraction: boolean;
  noise_threshold: number;
}

export const DEFAULT_DECONV_PARAMS: DeconvParams = {
  mz_min: 600,
  mz_max: 6000,
  charge_low: 5,
  charge_high: 50,
  mass_low: 5000,
  mass_high: 200000,
  mass_bin: 1.0,
  peak_fwhm: 0.5,
  peak_shape: "gaussian",
  iterations: 100,
  convergence: 1e-4,
  beta_charge: 0.0,
  beta_mass: 0.0,
  background_subtraction: false,
  noise_threshold: 0,
};

/* ----- F1 / F2 / F4 post-hoc filters (stub) ----- */

export interface FilterParams {
  f1_enabled: boolean;
  f1_threshold: number;

  f2_enabled: boolean;
  f2_threshold: number;

  f4_enabled: boolean;
  f4_threshold: number;
}

export const DEFAULT_FILTER_PARAMS: FilterParams = {
  f1_enabled: false,
  f1_threshold: 0.5,
  f2_enabled: false,
  f2_threshold: 0.5,
  f4_enabled: false,
  f4_threshold: 0.5,
};

/* ----- Sidecar lifecycle ----- */

export type SidecarStatus =
  | { kind: "absent" }
  | { kind: "starting" }
  | { kind: "ready"; commands: string[] }
  | { kind: "busy"; command: string }
  | { kind: "error"; message: string };
