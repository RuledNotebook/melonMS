"""
list_d_folders command.

Walks a parent directory (non-recursively) and reports every entry that ends
with ``.d``. Each entry is validated as a Bruker timsTOF acquisition by
checking that it is a directory containing both ``analysis.tdf`` (SQLite
metadata) and ``analysis.tdf_bin`` (binary frames).

Used by the DropZone to support the realistic workflow where a researcher's
folder holds many ``.d`` subdirectories (one per acquisition) rather than a
single ``.d``.

Request params:
  path: str   absolute path to the parent directory to scan

Response:
  {
    "parent": "/abs/path/to/parent",
    "samples": [
      {
        "name":   "BSA_20um_Native_isCID-0eV_1.d",
        "path":   "/abs/path/to/parent/BSA_20um_Native_isCID-0eV_1.d",
        "size_mb": 234.5,
        "valid":  true
      },
      ...
    ]
  }

The ``samples`` list is sorted alphabetically by ``name``. ``size_mb`` is the
sum of file sizes at the top level of the ``.d`` directory in megabytes
(rounded to 1 decimal). ``valid`` is False when ``analysis.tdf`` or
``analysis.tdf_bin`` is missing, which lets the UI grey out non-loadable
entries instead of dropping them silently.
"""
from __future__ import annotations

from pathlib import Path


REQUIRED_FILES = ("analysis.tdf", "analysis.tdf_bin")


def _dir_size_mb(d: Path) -> float:
    """Sum top-level file sizes in MB.

    We deliberately avoid recursion: for Bruker .d folders the analysis.tdf_bin
    blob dominates, and the recursive case for nested .m method folders would
    inflate every entry by similar boilerplate without telling the user
    anything new.
    """
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


def run(params: dict) -> dict:
    path_str = params.get("path")
    if not path_str:
        raise ValueError("Missing required parameter: path")

    parent = Path(path_str).expanduser().resolve()
    if not parent.exists():
        raise FileNotFoundError(f"Parent folder not found: {parent}")
    if not parent.is_dir():
        raise NotADirectoryError(f"Path is not a directory: {parent}")

    samples = []
    try:
        entries = list(parent.iterdir())
    except OSError as e:
        raise RuntimeError(f"Could not list {parent}: {e}") from e

    for entry in entries:
        if not entry.name.lower().endswith(".d"):
            continue
        is_dir = entry.is_dir()
        valid = is_dir and all((entry / req).is_file() for req in REQUIRED_FILES)
        size_mb = _dir_size_mb(entry) if is_dir else 0.0
        samples.append(
            {
                "name": entry.name,
                "path": str(entry),
                "size_mb": size_mb,
                "valid": bool(valid),
            }
        )

    samples.sort(key=lambda s: s["name"].lower())

    return {
        "parent": str(parent),
        "samples": samples,
    }
