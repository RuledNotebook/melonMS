/* TypeScript shapes that mirror the JSON contract emitted by python/sidecar.py.
   Keep these in lockstep with python/commands/*.py. */

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

/* ----- F1 / F2 / F4 post-hoc filters ----- */

export interface FilterParams {
  f1_enabled: boolean;
  f2_enabled: boolean;
  f4a_enabled: boolean;
  f4b_enabled: boolean;

  f1_min_cluster_size: number;       // default 3
  f1_max_gap_da: number;             // default 200

  f2_threshold_vlight: number;       // default 6
  f2_threshold_light: number;        // default 8
  f2_threshold_heavy: number;        // default 12
  f2_vlight_boundary_da: number;     // default 20000
  f2_light_heavy_boundary_da: number; // default 35000

  f4a_ratio_strict: number;          // default 5.0
  f4a_offset_low_da: number;         // default 3000
  f4a_offset_high_da: number;        // default 5000
}

export const DEFAULT_FILTER_PARAMS: FilterParams = {
  f1_enabled: true,
  f2_enabled: true,
  f4a_enabled: true,
  f4b_enabled: true,

  f1_min_cluster_size: 3,
  f1_max_gap_da: 200,

  f2_threshold_vlight: 6,
  f2_threshold_light: 8,
  f2_threshold_heavy: 12,
  f2_vlight_boundary_da: 20000,
  f2_light_heavy_boundary_da: 35000,

  f4a_ratio_strict: 5.0,
  f4a_offset_low_da: 3000,
  f4a_offset_high_da: 5000,
};

/* ----- Deconvolution result (matches sidecar `deconvolve` response.result) ----- */

export interface ChargeEnvelopeEntry {
  charge: number;
  intensity: number;
}

export interface MassPeak {
  mass: number;            // Da
  intensity: number;       // raw absolute
  rel_intensity: number;   // 0..1
  fdr: number;             // 0..1
  n_z: number;             // number of supporting charge states
  envelope_score: number;  // 0..1 Gaussian R²
  charge_envelope: ChargeEnvelopeEntry[];
}

export interface DeconvMetadata {
  n_iterations_run: number;
  converged: boolean;
  runtime_ms: number;
}

export interface DeconvResult {
  mass_list: MassPeak[];
  metadata: DeconvMetadata;
}

/* ----- Filter result (matches sidecar `apply_filters` response.result) ----- */

export interface FilteredMass {
  mass: number;
  f1_pass: boolean;
  f2_pass: boolean;
  f4a_pass: boolean;
  f4b_pass: boolean;
  cluster_id?: string;
  all_pass: boolean;
}

export interface FilterSummary {
  total_input: number;
  f1_passing: number;
  f2_passing: number;
  f4_passing: number;
  all_passing: number;
}

export interface FilterResult {
  filtered_mass_list: FilteredMass[];
  summary: FilterSummary;
}

/* ----- Sidecar lifecycle ----- */

export type SidecarStatus =
  | { kind: "absent" }
  | { kind: "starting" }
  | { kind: "ready"; commands: string[] }
  | { kind: "busy"; command: string }
  | { kind: "error"; message: string };

/* ----- Toast / notifications ----- */

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  message: string;
}

/* ----- Persisted config (Save / Load) ----- */

export interface AppConfig {
  version: 1;
  deconvParams: DeconvParams;
  filterParams: FilterParams;
}
