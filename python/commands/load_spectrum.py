"""
load_spectrum command.

Reads a calibrated profile-mode m/z spectrum from a Bruker .d folder and
streams stage / frame progress while it works. The histogram loop mirrors
``bruker_reader.TimsTOFReader.summed_spectrum`` so we can emit per-frame
progress without forking that module — the math is identical.

Request params (all optional except path):
  path:      str   absolute path to a .d folder
  mz_min:    float default 600
  mz_max:    float default 6000
  bin_width: float default 0.5  (profile-mode resolution; do NOT centroid)
  downsample_target: int  optional max number of points returned to UI
                          (default 200000 for smooth uPlot rendering)

Progress events (when emit is provided):
  {"stage": "Detecting format",       "step": 1, "steps": 4}
  {"stage": "Opening TDF + calibrating", "step": 2, "steps": 4}
  {"stage": "Reading frames",         "step": 3, "steps": 4,
   "frame": 1234, "frames": 7890}
  {"stage": "Downsampling for display", "step": 4, "steps": 4}

Response: see top of file in v0 history; same shape as before.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

# bruker_reader lives in the existing troponin-experiments folder, which
# sidecar.py adds to sys.path before invoking us.
from bruker_reader import (  # type: ignore
    FTICRReader,
    TimsTOFReader,
    detect_format,
)


DEFAULTS = {
    "mz_min": 600.0,
    "mz_max": 6000.0,
    "bin_width": 0.5,
    "downsample_target": 200_000,
}

# Cap progress events to ~5 Hz so we don't drown the JSON-stdio link on
# very fast machines. The UI updates faster than the eye anyway.
PROGRESS_THROTTLE_S = 0.2


def _downsample(mz: np.ndarray, intensity: np.ndarray, target: int):
    """Block-max downsample so peaks survive at low zoom levels.

    Block-max preserves the visual envelope; mean would smear narrow peaks."""
    n = len(mz)
    if target <= 0 or n <= target:
        return mz, intensity, False

    block = int(np.ceil(n / target))
    n_blocks = int(np.ceil(n / block))
    pad = n_blocks * block - n
    if pad:
        mz_p = np.pad(mz, (0, pad), mode="edge")
        int_p = np.pad(intensity, (0, pad), mode="constant")
    else:
        mz_p = mz
        int_p = intensity

    mz_blk = mz_p.reshape(n_blocks, block).mean(axis=1)
    int_blk = int_p.reshape(n_blocks, block).max(axis=1)
    return mz_blk, int_blk, True


def _summed_spectrum_with_progress(
    reader: TimsTOFReader,
    mz_min: float,
    mz_max: float,
    bin_width: float,
    emit,
):
    """Mirror of TimsTOFReader.summed_spectrum that emits per-frame progress.

    Reaches into reader._at (the AlphaTims handle) intentionally — same as
    the original method — so we don't pay the per-frame TimsFrame
    construction cost that read_frame() incurs. The math is identical:
    weighted histogram into the m/z bin grid."""
    at = reader._at
    n_frames = len(at.frames)

    mz_bins = np.arange(mz_min, mz_max + bin_width, bin_width)
    hist = np.zeros(len(mz_bins) - 1, dtype=np.float64)

    last_emit = time.monotonic()
    if emit is not None:
        emit({
            "stage": "Reading frames",
            "step": 3,
            "steps": 4,
            "frame": 0,
            "frames": int(n_frames),
        })

    for fi in range(n_frames):
        indices = at[fi, :, :, :, "raw"]
        if len(indices) > 0:
            tof_idx = at.tof_indices[indices]
            ints = at.intensity_values[indices].astype(np.float64)
            mz_vals = reader._calibrated_mz_values[tof_idx]
            h, _ = np.histogram(mz_vals, bins=mz_bins, weights=ints)
            hist += h

        if emit is not None:
            now = time.monotonic()
            if now - last_emit >= PROGRESS_THROTTLE_S:
                emit({
                    "stage": "Reading frames",
                    "step": 3,
                    "steps": 4,
                    "frame": fi + 1,
                    "frames": int(n_frames),
                })
                last_emit = now

    if emit is not None:
        emit({
            "stage": "Reading frames",
            "step": 3,
            "steps": 4,
            "frame": int(n_frames),
            "frames": int(n_frames),
        })

    centers = (mz_bins[:-1] + mz_bins[1:]) / 2
    return centers, hist, int(n_frames)


def run(params: dict, emit=None) -> dict:
    path_str = params.get("path")
    if not path_str:
        raise ValueError("Missing required parameter: path")

    d_path = Path(path_str).expanduser().resolve()
    if not d_path.exists():
        raise FileNotFoundError(f".d folder not found: {d_path}")
    if not d_path.is_dir():
        raise NotADirectoryError(
            f"Path is not a directory (.d folders are directories): {d_path}"
        )

    if emit is not None:
        emit({"stage": "Detecting format", "step": 1, "steps": 4})

    fmt = detect_format(d_path)

    mz_min = float(params.get("mz_min", DEFAULTS["mz_min"]))
    mz_max = float(params.get("mz_max", DEFAULTS["mz_max"]))
    bin_width = float(params.get("bin_width", DEFAULTS["bin_width"]))
    downsample_target = int(
        params.get("downsample_target", DEFAULTS["downsample_target"])
    )

    if fmt == "timsTOF":
        return _load_timstof(
            d_path, mz_min, mz_max, bin_width, downsample_target, emit
        )
    if fmt == "FTICR":
        return _load_fticr(
            d_path, mz_min, mz_max, bin_width, downsample_target, emit
        )
    if fmt == "QTOF":
        raise ValueError(
            f"QTOF .d folder ({d_path.name}) requires a Docker-based "
            f".baf → mzML conversion before it can be loaded; that "
            f"path is not wired into the Mac-native pipeline. Re-acquire "
            f"as timsTOF or pre-convert to mzML."
        )
    raise ValueError(f"Could not detect a supported format for {d_path.name}.")


def _load_timstof(d_path, mz_min, mz_max, bin_width, downsample_target, emit):
    if emit is not None:
        emit({"stage": "Opening TDF + calibrating", "step": 2, "steps": 4})

    reader = TimsTOFReader(d_path)

    centers, hist, n_frames = _summed_spectrum_with_progress(
        reader, mz_min, mz_max, bin_width, emit
    )

    if emit is not None:
        emit({"stage": "Downsampling for display", "step": 4, "steps": 4})

    full_n = int(len(centers))
    mz_out, int_out, ds = _downsample(centers, hist, downsample_target)

    return {
        "name": d_path.name,
        "path": str(d_path),
        "format": "timsTOF",
        "calibration": str(getattr(reader.calibration, "method", "unknown")),
        "n_frames": int(n_frames),
        "mz_range": [float(mz_min), float(mz_max)],
        "bin_width": bin_width,
        "mz": mz_out.tolist(),
        "intensity": int_out.tolist(),
        "n_points_full": full_n,
        "downsampled": bool(ds),
    }


def _load_fticr(d_path, mz_min, mz_max, bin_width, downsample_target, emit):
    """Mac-native FTICR path: read raw fid, FFT in numpy, calibrate from
    apexAcquisition.method ML1/ML2/ML3 constants. No Bruker libraries
    involved, so this works on Mac/Linux/Windows uniformly. The
    FTICRReader caches its result, so the only meaningful "stage" here
    is the FFT itself."""
    if emit is not None:
        emit({"stage": "Reading apexAcquisition.method", "step": 2, "steps": 4})

    reader = FTICRReader(d_path)

    if emit is not None:
        emit({
            "stage": f"FFT (TD={reader.TD:,} pts, zero-fill ×2)",
            "step": 3,
            "steps": 4,
        })

    spec = reader.spectrum(zero_fill=2, mz_min=mz_min, mz_max=mz_max)

    if emit is not None:
        emit({"stage": "Downsampling for display", "step": 4, "steps": 4})

    full_n = int(len(spec.mz))
    mz_out, int_out, ds = _downsample(spec.mz, spec.intensity, downsample_target)

    return {
        "name": d_path.name,
        "path": str(d_path),
        "format": "FTICR",
        "calibration": (
            f"3-param Bruker (ML1={reader.ML1:.6g}, "
            f"ML2={reader.ML2:.6g}, ML3={reader.ML3:.6g})"
        ),
        # FTICR data is a single transient → expose it as 1 "frame" so the
        # status bar / metadata still reads sensibly.
        "n_frames": 1,
        "mz_range": [float(mz_min), float(mz_max)],
        "bin_width": bin_width,
        "mz": mz_out.tolist(),
        "intensity": int_out.tolist(),
        "n_points_full": full_n,
        "downsampled": bool(ds),
    }
