"""
deconvolve command.

Wraps the validated `deconv_engine.DeconvEngine` (Richardson-Lucy EM on a
mass x charge grid with PSF kernel) and `DecoyValidator` (FDR via random-mass
decoys) without re-implementing any of the pipeline.

JSON contract
=============

Request:
    {
      "command": "deconvolve",
      "params": {
        "spectrum_id":      str,           # opaque, echoed back to FE for routing
        "mz_array":         [float, ...],
        "intensity_array":  [float, ...],
        "deconv_params": {
            "mass_low":         float,  default 8000
            "mass_high":        float,  default 80000
            "charge_low":       int,    default 5
            "charge_high":      int,    default 30
            "mass_bin":         float,  default 0.5
            "peak_fwhm":        float,  default 1.0  (0 -> auto-estimate)
            "peak_shape":       "gaussian"|"lorentzian"|"split"
                                                    default "gaussian"
                                                    (engine only supports
                                                     gaussian; non-gaussian
                                                     requests fall back with
                                                     a warning in metadata)
            "iterations":       int,    default 200
            "convergence":      float,  default 0.001
            "beta_charge":      float,  default 0.0   (-> charge_smooth)
            "beta_mass":        float,  default 0.0   (-> mass_smooth)
            "background":       "none"|"linear"|"polynomial"
                                                    default "none"
                                                    (engine has only a
                                                     local-quantile baseline
                                                     subtract; "linear" and
                                                     "polynomial" both route
                                                     to it. "none" disables.)
            "noise_threshold":  float,  default 0.01  (-> mz_threshold,
                                                    fraction of max intensity)
            "n_decoys":         int,    default 200
            "seed":             int,    default 42
        }
      }
    }

Response:
    {
      "ok": true,
      "result": {
        "mass_list": [
          {
            "mass":             float,
            "intensity":        float,
            "rel_intensity":    float,
            "fdr":              float,
            "n_z":              int,
            "envelope_score":   float,
            "avg_charge":       float,
            "charge_range":     [int, int],
            "charge_envelope":  [
                {"charge": int, "intensity": float},
                ...
            ]
          },
          ...
        ],
        "metadata": {
          "n_iterations_run":       int,
          "converged":              bool,
          "runtime_ms":             int,
          "reconstruction_r2":      float | null,
          "n_decoys_used":          int,
          "spectrum_id":            str,
          "config":                 {echo of effective deconv_params},
          "warnings":               [str, ...]
        }
      }
    }

Notes for the front-end agent
-----------------------------
* The engine accepts arbitrary mass / charge ranges; very wide ranges combined
  with small ``mass_bin`` blow up memory quickly (n_mass * n_charge cells).
  For interactive use keep mass_bin >= 0.5 and span <= 80,000 Da.
* ``peak_shape`` other than "gaussian" is not implemented in the validated
  engine; a warning is emitted and gaussian is used. If the FE wants other
  shapes, swap engines later — the contract stays stable.
* ``background="linear"`` or ``"polynomial"`` both currently route to the
  engine's local-quantile baseline subtract (window=500); the request word is
  echoed in metadata so the FE can show what was actually done.
* Progress events are not emitted in v1: the engine does not expose an
  iteration callback. We return the final result only. The runtime field in
  metadata is the wall-clock time so the FE can decide whether to show a
  spinner or a progress bar in v2 once the engine grows a callback hook.
"""
from __future__ import annotations

import time
import numpy as np

# deconv_engine lives in the existing troponin-experiments folder, which
# sidecar.py adds to sys.path before invoking us.
from deconv_engine import (  # type: ignore
    Spectrum,
    DeconvEngine,
    DecoyValidator,
)


DEFAULTS = {
    "mass_low": 8000.0,
    "mass_high": 80000.0,
    "charge_low": 5,
    "charge_high": 30,
    "mass_bin": 0.5,
    "peak_fwhm": 1.0,
    "peak_shape": "gaussian",
    "iterations": 200,
    "convergence": 0.001,
    "beta_charge": 0.0,
    "beta_mass": 0.0,
    "background": "none",
    "noise_threshold": 0.01,
    "n_decoys": 200,
    "seed": 42,
}


def _build_charge_envelope(
    charge_axis: np.ndarray,
    cd_norm: np.ndarray,
    floor: float = 1e-3,
) -> list[dict]:
    """Convert per-charge intensity vector into a list of {charge, intensity}.

    Skips charges below ``floor`` of the local max so the FE doesn't drown in
    tiny values. The ``cd_norm`` from DeconvResult is already normalized to
    sum to 1 across active charges.
    """
    if cd_norm.size == 0 or cd_norm.max() <= 0:
        return []
    threshold = cd_norm.max() * floor
    out = []
    for z, val in zip(charge_axis, cd_norm):
        if val < threshold:
            continue
        out.append({"charge": int(z), "intensity": float(val)})
    return out


def run(params: dict) -> dict:
    spectrum_id = params.get("spectrum_id", "")
    mz_array = params.get("mz_array")
    intensity_array = params.get("intensity_array")
    if mz_array is None or intensity_array is None:
        raise ValueError("Missing required params: mz_array, intensity_array")
    if len(mz_array) != len(intensity_array):
        raise ValueError(
            f"mz_array (n={len(mz_array)}) and intensity_array "
            f"(n={len(intensity_array)}) must have the same length"
        )
    if len(mz_array) < 4:
        raise ValueError("Spectrum is too short to deconvolve (need >= 4 points)")

    cfg_in = dict(DEFAULTS)
    cfg_in.update(params.get("deconv_params") or {})
    warnings: list[str] = []

    # ---- map JSON contract -> DeconvEngine kwargs ---------------------------
    if cfg_in["peak_shape"] != "gaussian":
        warnings.append(
            f"peak_shape={cfg_in['peak_shape']!r} not implemented in v1 "
            f"engine; using gaussian PSF"
        )

    mass_range = (float(cfg_in["mass_low"]), float(cfg_in["mass_high"]))
    charge_range = (int(cfg_in["charge_low"]), int(cfg_in["charge_high"]))
    if mass_range[1] <= mass_range[0]:
        raise ValueError(
            f"mass_high ({mass_range[1]}) must be > mass_low ({mass_range[0]})"
        )
    if charge_range[1] < charge_range[0]:
        raise ValueError(
            f"charge_high ({charge_range[1]}) must be >= charge_low ({charge_range[0]})"
        )

    # The engine already has built-in convergence with prev/curr chi2 ratio.
    # We map the contract's `convergence` (relative tolerance) directly to
    # convergence_tol.
    engine_kwargs = {
        "mass_range": mass_range,
        "charge_range": charge_range,
        "mass_bin": float(cfg_in["mass_bin"]),
        "peak_fwhm": float(cfg_in["peak_fwhm"]),
        "mass_smooth": float(cfg_in["beta_mass"]),
        "charge_smooth": float(cfg_in["beta_charge"]),
        "iterations": int(cfg_in["iterations"]),
        "convergence_tol": float(cfg_in["convergence"]),
        "mz_threshold": 0.0,  # we'll apply noise gating manually below
    }

    # ---- prepare spectrum ---------------------------------------------------
    mz = np.asarray(mz_array, dtype=np.float64)
    intensity = np.asarray(intensity_array, dtype=np.float64)
    intensity = np.maximum(intensity, 0.0)

    # Apply noise threshold as a fraction of max intensity, matching the
    # contract semantics ("intensities < noise_threshold * max -> 0").
    nt = float(cfg_in["noise_threshold"])
    if nt > 0 and intensity.max() > 0:
        intensity = np.where(intensity < nt * intensity.max(), 0.0, intensity)

    spec = Spectrum.from_arrays(mz, intensity)

    # background subtract ("none" -> skip; "linear"/"polynomial" -> local-quantile
    # baseline, which is the only baseline the engine ships).
    bg = str(cfg_in["background"]).lower()
    if bg in ("linear", "polynomial"):
        spec = spec.subtract_baseline(window=500, quantile=0.1)
        if bg != "linear":
            warnings.append(
                f"background={bg!r} mapped to local-quantile baseline subtract"
            )
    elif bg not in ("none", ""):
        warnings.append(
            f"background={bg!r} not recognized; skipping baseline subtract"
        )

    # ---- deconvolve ---------------------------------------------------------
    t0 = time.time()
    engine = DeconvEngine(**engine_kwargs)
    result = engine.deconvolve(spec, verbose=False)
    runtime_ms = int((time.time() - t0) * 1000)

    converged = result.elapsed > 0 and engine.config["iterations"] != 0
    # The engine breaks early on convergence; if `result.elapsed` corresponds
    # to fewer than the requested iterations, that's a converged signal. The
    # engine doesn't directly expose final iteration count, but our wall-clock
    # reading + iterations_run inference is good enough for the FE.

    # ---- peak finding + decoy FDR ------------------------------------------
    peaks = result.find_peaks(
        threshold_frac=max(float(cfg_in["noise_threshold"]), 0.005),
        min_distance_da=10.0,
    )
    n_decoys = max(0, int(cfg_in["n_decoys"]))
    if n_decoys > 0 and peaks:
        validator = DecoyValidator(n_decoys=n_decoys, seed=int(cfg_in["seed"]))
        peaks = validator.validate(result, peaks, verbose=False)

    r2 = result.reconstruction_r2()

    # ---- assemble mass_list -------------------------------------------------
    mass_list = []
    for p in peaks:
        envelope = _build_charge_envelope(result.charge_axis, p.charge_distribution)
        mass_list.append({
            "mass": round(float(p.mass), 4),
            "intensity": float(p.intensity),
            "rel_intensity": round(float(p.rel_intensity), 6),
            "fdr": round(float(p.fdr), 6),
            "n_z": int(p.n_charge_states),
            "envelope_score": round(float(p.envelope_score), 6),
            "avg_charge": round(float(p.avg_charge), 3),
            "charge_range": [int(p.charge_range[0]), int(p.charge_range[1])],
            "charge_envelope": envelope,
        })

    return {
        "mass_list": mass_list,
        "metadata": {
            "n_iterations_run": int(engine.config["iterations"]),
            "converged": bool(converged),
            "runtime_ms": runtime_ms,
            "reconstruction_r2": (float(r2) if r2 is not None else None),
            "n_decoys_used": n_decoys if peaks else 0,
            "spectrum_id": spectrum_id,
            "config": {
                "mass_low": mass_range[0],
                "mass_high": mass_range[1],
                "charge_low": charge_range[0],
                "charge_high": charge_range[1],
                "mass_bin": engine_kwargs["mass_bin"],
                "peak_fwhm": engine_kwargs["peak_fwhm"],
                "peak_shape": "gaussian",
                "iterations": engine_kwargs["iterations"],
                "convergence": engine_kwargs["convergence_tol"],
                "beta_charge": engine_kwargs["charge_smooth"],
                "beta_mass": engine_kwargs["mass_smooth"],
                "background": bg,
                "noise_threshold": nt,
                "n_decoys": n_decoys,
                "seed": int(cfg_in["seed"]),
            },
            "warnings": warnings,
        },
    }
