"""
load_spectrum command.

Wraps `bruker_reader.TimsTOFReader.summed_spectrum()` so the front-end can
get a calibrated profile-mode m/z spectrum from a Bruker .d folder without
duplicating any of the validated pipeline code.

Request params (all optional except path):
  path:      str   absolute path to a .d folder
  mz_min:    float default 600
  mz_max:    float default 6000
  bin_width: float default 0.5  (profile-mode resolution; do NOT centroid)
  downsample_target: int  optional max number of points returned to UI
                          (default 200000 for smooth uPlot rendering)

Response:
  {
    "name":           str,
    "format":         "timsTOF" | ...,
    "calibration":    str,
    "n_frames":       int,
    "mz_range":       [float, float],
    "bin_width":      float,
    "mz":             [float, ...],   # downsampled if requested
    "intensity":      [float, ...],
    "n_points_full":  int,
    "downsampled":    bool,
  }
"""
from __future__ import annotations

from pathlib import Path
import numpy as np

# bruker_reader lives in the existing troponin-experiments folder, which
# sidecar.py adds to sys.path before invoking us.
from bruker_reader import TimsTOFReader, detect_format  # type: ignore


DEFAULTS = {
    "mz_min": 600.0,
    "mz_max": 6000.0,
    "bin_width": 0.5,
    "downsample_target": 200_000,
}


def _downsample(mz: np.ndarray, intensity: np.ndarray, target: int) -> tuple[np.ndarray, np.ndarray, bool]:
    """Block-max downsample so peaks survive at low zoom levels.

    Block-max preserves the visual envelope; mean would smear narrow peaks.
    """
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


def run(params: dict) -> dict:
    path_str = params.get("path")
    if not path_str:
        raise ValueError("Missing required parameter: path")

    d_path = Path(path_str).expanduser().resolve()
    if not d_path.exists():
        raise FileNotFoundError(f".d folder not found: {d_path}")
    if not d_path.is_dir():
        raise NotADirectoryError(f"Path is not a directory (.d folders are directories): {d_path}")

    fmt = detect_format(d_path)
    if fmt != "timsTOF":
        raise ValueError(
            f"Format {fmt!r} not yet supported in v0; only timsTOF .d folders are wired."
        )

    mz_min = float(params.get("mz_min", DEFAULTS["mz_min"]))
    mz_max = float(params.get("mz_max", DEFAULTS["mz_max"]))
    bin_width = float(params.get("bin_width", DEFAULTS["bin_width"]))
    downsample_target = int(params.get("downsample_target", DEFAULTS["downsample_target"]))

    reader = TimsTOFReader(d_path)
    spec = reader.summed_spectrum(mz_min=mz_min, mz_max=mz_max, bin_width=bin_width)

    full_n = int(len(spec.mz))
    mz_out, int_out, ds = _downsample(spec.mz, spec.intensity, downsample_target)

    return {
        "name": d_path.name,
        "path": str(d_path),
        "format": fmt,
        "calibration": str(spec.metadata.get("calibration", "unknown")),
        "n_frames": int(spec.metadata.get("n_frames", reader.n_frames)),
        "mz_range": [float(mz_min), float(mz_max)],
        "bin_width": bin_width,
        "mz": mz_out.tolist(),
        "intensity": int_out.tolist(),
        "n_points_full": full_n,
        "downsampled": bool(ds),
    }
