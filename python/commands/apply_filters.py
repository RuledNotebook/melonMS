"""
apply_filters command.

Wraps the validated `posthoc_filter` stack (F1 clustering, F2 mass-aware
charge-state coherence, F4a strict cluster-aware ghost satellite, F4b
envelope coherence) without re-implementing any of the logic.

JSON contract
=============

Request:
    {
      "command": "apply_filters",
      "params": {
        "mass_list": [
          # Same shape as the deconvolve command's response. Required keys:
          #   mass, intensity, rel_intensity, fdr, n_z, envelope_score,
          #   avg_charge (optional), charge_range (optional)
          {"mass": 72886.01, "intensity": 1234567.0, "rel_intensity": 0.057,
           "fdr": 0.025, "n_z": 13, "envelope_score": 0.93,
           "avg_charge": 11.5, "charge_range": [8, 16]}, ...
        ],
        "filters": {
          "f1_enabled":               bool,  default true
          "f2_enabled":               bool,  default true
          "f4a_enabled":              bool,  default true
          "f4b_enabled":              bool,  default true

          "f1_min_cluster_size":      int,   default 3
          "f1_max_gap_da":            float, default 200
          "f1_window_da":             float, default 1500   (extension)
          "f1_relax":                 bool,  default true   (extension)

          "f2_threshold_vlight":      int,   default 6
          "f2_threshold_light":       int,   default 8
          "f2_threshold_heavy":       int,   default 12
          "f2_vlight_boundary_da":    float, default 20000
          "f2_light_heavy_boundary_da": float, default 35000

          "f4a_ratio_strict":         float, default 5.0
          "f4a_ratio_permissive":     float, default 1.2  (extension)
          "f4a_offset_low_da":        float, default 3000
          "f4a_offset_high_da":       float, default 5000
          "f4a_use_strict":           bool,  default true (use F4a_pass_strict
                                                          for all_pass; if
                                                          false, uses the
                                                          permissive flag)

          "f4b_env_r2_min":           float, default 0.70  (extension)
          "f4b_centering_max":        float, default 0.30  (extension)

          "sample":                   str,   default "current"  (single-sample
                                                                tag attached
                                                                so F1/F4a
                                                                run sample-
                                                                local)
        }
      }
    }

Response:
    {
      "ok": true,
      "result": {
        "filtered_mass_list": [
          {
            "mass":          float,
            "intensity":     float,
            "rel_intensity": float,
            "fdr":           float,
            "n_z":           int,
            "envelope_score":float,
            "f1_pass":       bool,
            "f2_pass":       bool,
            "f4a_pass":      bool,    # uses strict ratio if f4a_use_strict
            "f4b_pass":      bool,
            "cluster_id":    str | null,
            "all_pass":      bool,    # F1 AND F2 AND F4a AND F4b (if enabled)
            "diagnostics": {           # passthrough of filter internals for UI
              "f1_pass_strict":   bool,
              "f1_relax_clause":  str | null,
              "f1_cluster_size":  int,
              "f2_threshold":     int,
              "f2_tier":          "vlight"|"light"|"heavy",
              "f4a_anchors_strict_n":     int,
              "f4a_anchors_permissive_n": int,
              "f4b_envelope_R2":      float,
              "f4b_centering":        float | null,
              "f4b_coherence_score":  float
            }
          },
          ...
        ],
        "summary": {
          "total_input":     int,
          "f1_passing":      int,
          "f2_passing":      int,
          "f4_passing":      int,    # F4a AND F4b
          "f4a_passing":     int,
          "f4b_passing":     int,
          "all_passing":     int     # full stack with `*_enabled` flags honored
        }
      }
    }

Notes for the front-end agent
-----------------------------
* This command operates on a SINGLE sample's mass list. The validated
  pipeline supports cross-sample filters (F3) but those need multi-sample
  context the FE doesn't pass in the v1 contract; F3 is therefore not
  applied here.
* When `f4a_enabled` is true, the same input mass_list is used as the F4a
  "full peak list" anchor pool. This matches the deconv->filter pipeline
  where the deconv output IS the full peak list for that spectrum.
* Setting any `*_enabled=false` skips that filter stage AND removes it from
  the `all_pass` AND from the summary count. The per-hit boolean is still
  returned for completeness but is forced to True when the filter is
  disabled (so disabled filters do not block all_pass).
* F1 is run per-sample. Because the FE submits a single spectrum, every hit
  is tagged with the same sample, and clustering effectively runs over the
  full input — which is the desired behavior.
"""
from __future__ import annotations

# posthoc_filter lives in troponin-experiments/, added to sys.path by sidecar.py
from posthoc_filter import (  # type: ignore
    filter_F1_clustering,
    filter_F2_charge_coherence,
    filter_F4a_ghost_satellite,
    filter_F4b_envelope_coherence,
    F1_WINDOW_DA,
    F1_MAX_GAP_DA,
    F1_MIN_MEMBERS,
    F2_NZ_THRESHOLD,
    F2_NZ_THRESHOLD_LIGHT,
    F2_NZ_THRESHOLD_VLIGHT,
    F2_LIGHT_HEAVY_BOUNDARY_DA,
    F2_VLIGHT_LIGHT_BOUNDARY_DA,
    F4A_OFFSET_LOW_DA,
    F4A_OFFSET_HIGH_DA,
    F4A_STRICT_RATIO,
    F4A_PERMISSIVE_RATIO,
    F4B_ENV_R2_MIN,
    F4B_CENTERING_MAX,
)


FILTER_DEFAULTS = {
    "f1_enabled": True,
    "f2_enabled": True,
    "f4a_enabled": True,
    "f4b_enabled": True,
    "f1_min_cluster_size": F1_MIN_MEMBERS,
    "f1_max_gap_da": F1_MAX_GAP_DA,
    "f1_window_da": F1_WINDOW_DA,
    "f1_relax": True,
    "f2_threshold_vlight": F2_NZ_THRESHOLD_VLIGHT,
    "f2_threshold_light": F2_NZ_THRESHOLD_LIGHT,
    "f2_threshold_heavy": F2_NZ_THRESHOLD,
    "f2_vlight_boundary_da": F2_VLIGHT_LIGHT_BOUNDARY_DA,
    "f2_light_heavy_boundary_da": F2_LIGHT_HEAVY_BOUNDARY_DA,
    "f4a_ratio_strict": F4A_STRICT_RATIO,
    "f4a_ratio_permissive": F4A_PERMISSIVE_RATIO,
    "f4a_offset_low_da": F4A_OFFSET_LOW_DA,
    "f4a_offset_high_da": F4A_OFFSET_HIGH_DA,
    "f4a_use_strict": True,
    "f4b_env_r2_min": F4B_ENV_R2_MIN,
    "f4b_centering_max": F4B_CENTERING_MAX,
    "sample": "current",
}


def _coerce_input_hit(p: dict, sample: str) -> dict:
    """Map the deconvolve-response shape onto the dict shape posthoc_filter
    expects (matches `posthoc_filter._coerce_hit`)."""
    cr = p.get("charge_range", [0, 0])
    if not isinstance(cr, (list, tuple)) or len(cr) < 2:
        cr = [0, 0]
    # The deconvolve command emits `n_z`, but the filter stack expects
    # `n_charge_states`; map both ways for resilience.
    n_z = p.get("n_charge_states", p.get("n_z", 0))
    return {
        "sample": sample,
        "mass": float(p.get("mass", 0.0)),
        "intensity": float(p.get("intensity", 0.0)),
        "rel_intensity": float(p.get("rel_intensity", 0.0)),
        "n_charge_states": int(n_z),
        "avg_charge": float(p.get("avg_charge", 0.0)),
        "charge_range": [int(cr[0]), int(cr[1])],
        "envelope_score": float(p.get("envelope_score", 0.0)),
        "score": float(p.get("score", 0.0)),
        "fdr": float(p.get("fdr", 1.0)),
    }


def run(params: dict, emit=None) -> dict:
    raw_mass_list = params.get("mass_list")
    if raw_mass_list is None:
        raise ValueError("Missing required parameter: mass_list")
    if not isinstance(raw_mass_list, list):
        raise TypeError("mass_list must be a list of objects")

    fcfg = dict(FILTER_DEFAULTS)
    fcfg.update(params.get("filters") or {})

    sample = str(fcfg["sample"]) or "current"
    hits = [_coerce_input_hit(p, sample) for p in raw_mass_list]
    n_input = len(hits)

    # ---- F1 ----------------------------------------------------------------
    if fcfg["f1_enabled"]:
        # NOTE: filter_F1_clustering uses the module-level F1_WINDOW_DA for
        # span; we override min_members / max_gap via kwargs but window_da is
        # also kwargs-overridable.
        hits = filter_F1_clustering(
            hits,
            window_da=float(fcfg["f1_window_da"]),
            max_gap_da=float(fcfg["f1_max_gap_da"]),
            min_members=int(fcfg["f1_min_cluster_size"]),
            by_sample=True,
            relax=bool(fcfg["f1_relax"]),
        )
    else:
        for h in hits:
            h["F1_pass"] = True
            h["F1_pass_strict"] = True
            h["F1_cluster_id"] = None
            h["F1_cluster_size"] = 1
            h["F1_relax_clause"] = None

    # ---- F2 ----------------------------------------------------------------
    if fcfg["f2_enabled"]:
        hits = filter_F2_charge_coherence(
            hits,
            nz_threshold=int(fcfg["f2_threshold_heavy"]),
            nz_threshold_light=int(fcfg["f2_threshold_light"]),
            light_heavy_boundary_da=float(fcfg["f2_light_heavy_boundary_da"]),
            nz_threshold_vlight=int(fcfg["f2_threshold_vlight"]),
            vlight_light_boundary_da=float(fcfg["f2_vlight_boundary_da"]),
        )
    else:
        for h in hits:
            h["F2_pass"] = True
            h["F2_threshold"] = 0
            h["F2_threshold_applied"] = "disabled"

    # ---- F4a ---------------------------------------------------------------
    if fcfg["f4a_enabled"]:
        # The "full peak list" anchor pool for a single spectrum IS the input
        # mass_list. We feed the same hits in as the per-sample peak lookup so
        # F4a can cross-reference them.
        full_peak_lookup = {
            sample: [
                {
                    "mass": h["mass"],
                    "rel_intensity": h["rel_intensity"],
                    "n_charge_states": h["n_charge_states"],
                    "fdr": h["fdr"],
                }
                for h in hits
            ]
        }
        cluster_lookup = {
            (h["sample"], round(h["mass"], 2)): h.get("F1_cluster_id")
            for h in hits
        }
        # Treat any F1-strict-cluster member or F1-relaxA passer as biological
        # (matches posthoc_filter.apply_all_filters' default).
        biological_lookup = {
            (h["sample"], round(h["mass"], 2)): bool(
                h.get("F1_pass_strict")
                or h.get("F1_relax_clause") == "a_isolated_strong_envelope"
            )
            for h in hits
        }
        hits = filter_F4a_ghost_satellite(
            hits,
            sample_peak_lookup=full_peak_lookup,
            offset_low_da=float(fcfg["f4a_offset_low_da"]),
            offset_high_da=float(fcfg["f4a_offset_high_da"]),
            strict_ratio=float(fcfg["f4a_ratio_strict"]),
            permissive_ratio=float(fcfg["f4a_ratio_permissive"]),
            cluster_membership_lookup=cluster_lookup,
            biological_cluster_lookup=biological_lookup,
        )
    else:
        for h in hits:
            h["F4a_pass"] = True
            h["F4a_pass_strict"] = True
            h["F4a_anchors_strict"] = []
            h["F4a_anchors_permissive"] = []

    # ---- F4b ---------------------------------------------------------------
    if fcfg["f4b_enabled"]:
        hits = filter_F4b_envelope_coherence(
            hits,
            env_r2_min=float(fcfg["f4b_env_r2_min"]),
            centering_max=float(fcfg["f4b_centering_max"]),
        )
    else:
        for h in hits:
            h["F4b_pass"] = True
            h["F4b_envelope_R2"] = float(h.get("envelope_score", 0.0))
            h["F4b_envelope_centering"] = None
            h["F4b_coherence_score"] = float(h.get("envelope_score", 0.0))

    # ---- assemble response --------------------------------------------------
    use_strict_f4a = bool(fcfg["f4a_use_strict"])
    f4a_key = "F4a_pass_strict" if use_strict_f4a else "F4a_pass"

    filtered_mass_list = []
    n_f1 = n_f2 = n_f4a = n_f4b = n_f4 = n_all = 0
    for h in hits:
        f1 = bool(h.get("F1_pass", True)) if fcfg["f1_enabled"] else True
        f2 = bool(h.get("F2_pass", True)) if fcfg["f2_enabled"] else True
        f4a = bool(h.get(f4a_key, True)) if fcfg["f4a_enabled"] else True
        f4b = bool(h.get("F4b_pass", True)) if fcfg["f4b_enabled"] else True
        all_pass = f1 and f2 and f4a and f4b

        if f1: n_f1 += 1
        if f2: n_f2 += 1
        if f4a: n_f4a += 1
        if f4b: n_f4b += 1
        if f4a and f4b: n_f4 += 1
        if all_pass: n_all += 1

        filtered_mass_list.append({
            "mass": round(float(h["mass"]), 4),
            "intensity": float(h["intensity"]),
            "rel_intensity": round(float(h["rel_intensity"]), 6),
            "fdr": round(float(h["fdr"]), 6),
            "n_z": int(h["n_charge_states"]),
            "envelope_score": round(float(h["envelope_score"]), 6),
            "f1_pass": f1,
            "f2_pass": f2,
            "f4a_pass": f4a,
            "f4b_pass": f4b,
            "cluster_id": h.get("F1_cluster_id"),
            "all_pass": all_pass,
            "diagnostics": {
                "f1_pass_strict": bool(h.get("F1_pass_strict", False)),
                "f1_relax_clause": h.get("F1_relax_clause"),
                "f1_cluster_size": int(h.get("F1_cluster_size", 0) or 0),
                "f2_threshold": int(h.get("F2_threshold", 0) or 0),
                "f2_tier": h.get("F2_threshold_applied"),
                "f4a_anchors_strict_n": len(h.get("F4a_anchors_strict") or []),
                "f4a_anchors_permissive_n": len(h.get("F4a_anchors_permissive") or []),
                "f4b_envelope_R2": float(h.get("F4b_envelope_R2", 0.0) or 0.0),
                "f4b_centering": h.get("F4b_envelope_centering"),
                "f4b_coherence_score": float(h.get("F4b_coherence_score", 0.0) or 0.0),
            },
        })

    return {
        "filtered_mass_list": filtered_mass_list,
        "summary": {
            "total_input": n_input,
            "f1_passing": n_f1,
            "f2_passing": n_f2,
            "f4_passing": n_f4,
            "f4a_passing": n_f4a,
            "f4b_passing": n_f4b,
            "all_passing": n_all,
        },
    }
