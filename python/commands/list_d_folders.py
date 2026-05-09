"""
list_d_folders command.

Walks a parent directory recursively (up to a small max depth) and reports
every entry that ends with ``.d``. Each entry is classified as one of:

  - ``timsTOF`` — has ``analysis.tdf`` + ``analysis.tdf_bin``. Loadable.
  - ``FTICR``   — has a ``.baf`` + a raw ``fid`` transient. Loadable
                  Mac-natively via numpy FFT (no Bruker libs needed).
  - ``QTOF``    — has a ``.baf`` only. Not loadable without a prior
                  Docker-based mzML conversion; surfaced as ``valid=false``
                  so the picker can grey it out with a clear reason.
  - ``unknown`` — none of the above; ``valid=false``.

The walk stops descending into any ``.d`` directory it finds (Bruker .d
folders contain ``.m`` method subdirectories which we never want to recurse
into) and skips dotfile / system directories. This handles real datasets
where acquisitions live under ``parent/raw/<study_name>/*.d`` rather than
directly under ``parent/``.

Used by the sidebar to support the realistic workflow where a researcher's
folder holds many ``.d`` subdirectories — possibly nested — rather than a
single ``.d``.

Request params:
  path:      str   absolute path to the parent directory to scan
  max_depth: int   optional, default 4. Maximum directory depth from
                   ``path`` to descend looking for ``.d`` folders.

Response:
  {
    "parent": "/abs/path/to/parent",
    "samples": [
      {
        "name":   "BSA_20um_Native_isCID-0eV_1.d",
        "path":   "/abs/path/to/parent/raw/Native Troponin/BSA_...d",
        "size_mb": 234.5,
        "valid":  true
      },
      ...
    ]
  }

The ``samples`` list is sorted alphabetically by ``name``. ``size_mb`` is
the sum of file sizes at the top level of the ``.d`` directory in
megabytes (rounded to 1 decimal). ``valid`` is False when ``analysis.tdf``
or ``analysis.tdf_bin`` is missing, which lets the UI grey out
non-loadable entries instead of dropping them silently.
"""
from __future__ import annotations

from pathlib import Path

# bruker_reader lives in the existing troponin-experiments folder, which
# sidecar.py adds to sys.path before invoking us.
from bruker_reader import detect_format  # type: ignore


DEFAULT_MAX_DEPTH = 4
HARD_SAMPLE_CAP = 500
SKIP_DIR_NAMES = {"node_modules", "dist", "build", ".git", "__pycache__"}

# Formats we can actually load via load_spectrum on this platform.
LOADABLE_FORMATS = ("timsTOF", "FTICR")


def _dir_size_mb(d: Path) -> float:
    """Sum top-level file sizes in MB. analysis.tdf_bin dominates so the
    top-level total is a fine proxy without recursing into .m subfolders."""
    total = 0
    try:
        for entry in d.iterdir():
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except OSError:
                    continue
    except OSError:
        return 0.0
    return round(total / (1024 * 1024), 1)


def _walk_for_d(root: Path, max_depth: int):
    """Yield Path objects for every ``.d`` directory at depth <= max_depth.

    Iterative BFS so a malformed symlink loop can't blow the stack. Stops
    descending into ``.d`` (treated as a leaf) and skips dotfiles + obvious
    project-junk dirs."""
    queue: list[tuple[Path, int]] = [(root, 0)]
    while queue:
        current, depth = queue.pop(0)
        try:
            entries = list(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            name = entry.name
            if name.startswith("."):
                continue
            if not entry.is_dir():
                continue
            if name.lower().endswith(".d"):
                yield entry
                continue  # never recurse into a .d
            if name in SKIP_DIR_NAMES:
                continue
            if depth + 1 <= max_depth:
                queue.append((entry, depth + 1))


def run(params: dict, emit=None) -> dict:
    path_str = params.get("path")
    if not path_str:
        raise ValueError("Missing required parameter: path")

    raw_max_depth = params.get("max_depth", DEFAULT_MAX_DEPTH)
    try:
        max_depth = int(raw_max_depth)
    except (TypeError, ValueError):
        max_depth = DEFAULT_MAX_DEPTH
    if max_depth < 0:
        max_depth = 0

    parent = Path(path_str).expanduser().resolve()
    if not parent.exists():
        raise FileNotFoundError(f"Parent folder not found: {parent}")
    if not parent.is_dir():
        raise NotADirectoryError(f"Path is not a directory: {parent}")

    def _classify(d: Path) -> dict:
        try:
            fmt = detect_format(d)
        except Exception:
            fmt = "unknown"
        return {
            "name": d.name,
            "path": str(d),
            "size_mb": _dir_size_mb(d),
            "format": fmt,
            "valid": fmt in LOADABLE_FORMATS,
        }

    # The user dropped a .d itself: short-circuit with that one entry. The
    # sidebar normally routes a .d straight to load_spectrum, but if it
    # somehow lands here we want a sensible response.
    if parent.name.lower().endswith(".d"):
        return {
            "parent": str(parent.parent),
            "samples": [_classify(parent)],
        }

    samples: list[dict] = []
    for d_path in _walk_for_d(parent, max_depth):
        samples.append(_classify(d_path))
        if len(samples) >= HARD_SAMPLE_CAP:
            break

    samples.sort(key=lambda s: s["name"].lower())

    return {
        "parent": str(parent),
        "samples": samples,
    }
