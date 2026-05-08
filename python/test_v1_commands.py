"""End-to-end smoke test for the v1 sidecar JSON-stdio commands.

Spawns sidecar.py as a subprocess and exchanges JSON requests for:
  1. load_spectrum  (real .d folder)
  2. deconvolve     (using load_spectrum's response)
  3. apply_filters  (using deconvolve's mass_list)

Reports per-command wall clock, JSON-shape conformance, and a small
snapshot of the contents so the operator can confirm the contract holds.

Run from inside the troponin-experiments venv:
    python troponin-tdms-app/python/test_v1_commands.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SIDECAR = HERE / "sidecar.py"
D_PATH = (
    Path(__file__).resolve().parents[2]
    / "raw_data"
    / "raw"
    / "Native Troponin"
    / "YG54_cTn-NP_Native_JBA09_0mM-EGTA_.d"
)


def send(proc: subprocess.Popen, request: dict) -> dict:
    """Send one request and read responses until we get the matching id.

    The sidecar emits an unprompted {"event": "ready", ...} on startup; we
    drain non-id'd events here and only return the id-matched payload.
    """
    line = json.dumps(request) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()
    while True:
        raw = proc.stdout.readline()
        if not raw:
            stderr_text = ""
            try:
                stderr_text = proc.stderr.read() or ""
            except Exception:
                pass
            raise RuntimeError(
                f"Sidecar closed stdout unexpectedly. stderr:\n{stderr_text}"
            )
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            print(f"  [non-JSON line, skipping]: {raw.rstrip()}", file=sys.stderr)
            continue
        if payload.get("id") == request.get("id"):
            return payload
        # event/notification or stale message; log and continue
        if payload.get("event"):
            print(f"  [sidecar event] {payload}", file=sys.stderr)
        else:
            print(f"  [unmatched payload] {payload}", file=sys.stderr)


def fmt_ms(t0: float) -> str:
    return f"{(time.time() - t0) * 1000:.0f} ms"


def print_drained_stderr(proc: subprocess.Popen) -> None:
    # Best-effort: drain any pending stderr lines without blocking.
    pass


def main() -> int:
    if not D_PATH.exists():
        print(f"FATAL: test .d folder not found: {D_PATH}")
        return 2

    print("=" * 70)
    print("v1 sidecar end-to-end test")
    print("=" * 70)
    print(f"sidecar:  {SIDECAR}")
    print(f"d-folder: {D_PATH}")
    print()

    proc = subprocess.Popen(
        [sys.executable, str(SIDECAR)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    try:
        # ---- 1) load_spectrum ----------------------------------------------
        print("[1/3] load_spectrum")
        t0 = time.time()
        resp_load = send(proc, {
            "id": "t1",
            "command": "load_spectrum",
            "params": {
                "path": str(D_PATH),
                "mz_min": 600,
                "mz_max": 6000,
                "bin_width": 0.5,
                "downsample_target": 0,  # no downsample so we feed the full
                                          # profile array to the deconvolver
            },
        })
        load_ms = fmt_ms(t0)
        if not resp_load.get("ok"):
            print(f"  FAIL: {resp_load}")
            return 1
        load_result = resp_load["result"]
        n_full = load_result["n_points_full"]
        mz_arr = load_result["mz"]
        int_arr = load_result["intensity"]
        print(f"  OK  ({load_ms})  n_points={n_full}  "
              f"n_frames={load_result['n_frames']}  "
              f"calibration={load_result['calibration']}")
        for required in ("name", "format", "mz", "intensity", "n_points_full"):
            assert required in load_result, f"load_spectrum missing key {required}"

        # ---- 2) deconvolve --------------------------------------------------
        # Reasonable interactive defaults: tighter mass range than the full
        # 8-80 kDa default to keep the kernel manageable for the smoke test.
        print()
        print("[2/3] deconvolve")
        t0 = time.time()
        resp_dec = send(proc, {
            "id": "t2",
            "command": "deconvolve",
            "params": {
                "spectrum_id": load_result["name"],
                "mz_array": mz_arr,
                "intensity_array": int_arr,
                "deconv_params": {
                    "mass_low": 60000,
                    "mass_high": 80000,
                    "charge_low": 8,
                    "charge_high": 22,
                    "mass_bin": 1.0,
                    "peak_fwhm": 1.0,
                    "iterations": 80,
                    "convergence": 0.001,
                    "beta_charge": 1.0,
                    "beta_mass": 2.0,
                    "noise_threshold": 0.0,
                    "background": "linear",
                    "n_decoys": 50,
                    "seed": 42,
                },
            },
        })
        dec_ms = fmt_ms(t0)
        if not resp_dec.get("ok"):
            print(f"  FAIL: {json.dumps(resp_dec, indent=2)[:1500]}")
            return 1
        dec_result = resp_dec["result"]
        mass_list = dec_result["mass_list"]
        meta = dec_result["metadata"]
        print(f"  OK  ({dec_ms})  n_peaks={len(mass_list)}  "
              f"runtime_ms={meta.get('runtime_ms')}  "
              f"R2={meta.get('reconstruction_r2')}")
        if meta.get("warnings"):
            print(f"  warnings: {meta['warnings']}")
        for required in ("mass_list", "metadata"):
            assert required in dec_result, f"deconvolve missing key {required}"
        if mass_list:
            top = mass_list[0]
            print(f"  top peak: mass={top['mass']:.2f}  rel={top['rel_intensity']:.3f}  "
                  f"n_z={top['n_z']}  fdr={top['fdr']:.3f}  "
                  f"env={top['envelope_score']:.3f}  "
                  f"|charge_envelope|={len(top['charge_envelope'])}")
            for required in ("mass", "intensity", "rel_intensity", "fdr",
                             "n_z", "envelope_score", "charge_envelope"):
                assert required in top, f"mass_list[0] missing key {required}"

        # ---- 3) apply_filters ----------------------------------------------
        print()
        print("[3/3] apply_filters")
        t0 = time.time()
        resp_filt = send(proc, {
            "id": "t3",
            "command": "apply_filters",
            "params": {
                "mass_list": mass_list,
                "filters": {
                    "f1_enabled": True,
                    "f2_enabled": True,
                    "f4a_enabled": True,
                    "f4b_enabled": True,
                    "f1_min_cluster_size": 3,
                    "f1_max_gap_da": 200,
                    "f2_threshold_vlight": 6,
                    "f2_threshold_light": 8,
                    "f2_threshold_heavy": 12,
                    "f2_vlight_boundary_da": 20000,
                    "f2_light_heavy_boundary_da": 35000,
                    "f4a_ratio_strict": 5.0,
                    "f4a_offset_low_da": 3000,
                    "f4a_offset_high_da": 5000,
                    "sample": "YG54_test",
                },
            },
        })
        filt_ms = fmt_ms(t0)
        if not resp_filt.get("ok"):
            print(f"  FAIL: {json.dumps(resp_filt, indent=2)[:1500]}")
            return 1
        filt_result = resp_filt["result"]
        summary = filt_result["summary"]
        print(f"  OK  ({filt_ms})")
        print(f"  summary: {json.dumps(summary)}")
        for required in ("filtered_mass_list", "summary"):
            assert required in filt_result, f"apply_filters missing key {required}"
        for required in ("total_input", "f1_passing", "f2_passing",
                         "f4_passing", "all_passing"):
            assert required in summary, f"summary missing key {required}"
        if filt_result["filtered_mass_list"]:
            top = filt_result["filtered_mass_list"][0]
            print(f"  top filtered peak: mass={top['mass']:.2f}  "
                  f"f1={top['f1_pass']} f2={top['f2_pass']} "
                  f"f4a={top['f4a_pass']} f4b={top['f4b_pass']} "
                  f"all={top['all_pass']}  cluster={top['cluster_id']}")
            for required in ("mass", "f1_pass", "f2_pass", "f4a_pass",
                             "f4b_pass", "cluster_id", "all_pass",
                             "diagnostics"):
                assert required in top, f"filtered hit missing key {required}"

        print()
        print("=" * 70)
        print(f"ALL THREE COMMANDS PASSED")
        print(f"  load_spectrum: {load_ms}")
        print(f"  deconvolve:    {dec_ms}")
        print(f"  apply_filters: {filt_ms}")
        print("=" * 70)
        return 0
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
