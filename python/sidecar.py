"""
JSON-stdio sidecar for the troponin-tdms-app.

Reads one JSON request per line on stdin, dispatches to a command in
`commands/`, writes one JSON response per line on stdout. All log/diagnostic
output goes to stderr so it never pollutes the protocol stream.

Protocol
--------
Request:  {"id": "<uuid>", "command": "<name>", "params": {...}}
Response: {"id": "<uuid>", "ok": true,  "result": {...}}
          {"id": "<uuid>", "ok": false, "error": {"type": "...", "message": "..."}}

Adding a new command
--------------------
1. Drop a module under python/commands/<name>.py exposing `run(params: dict) -> dict`.
2. Register it in COMMAND_REGISTRY below.
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

# Ensure the package root and the existing troponin-experiments folder are
# importable so commands can reuse the validated pipeline modules without
# duplication. The path to the experiments folder is resolved relative to this
# file; if the user moves the app, set TROPONIN_EXPERIMENTS env var instead.
import os

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

EXPERIMENTS_DIR = Path(
    os.environ.get(
        "TROPONIN_EXPERIMENTS",
        HERE.parent.parent / "troponin-experiments",
    )
).resolve()
if EXPERIMENTS_DIR.exists():
    sys.path.insert(0, str(EXPERIMENTS_DIR))

from commands import load_spectrum  # noqa: E402
from commands import deconvolve  # noqa: E402
from commands import apply_filters  # noqa: E402
from commands import list_d_folders  # noqa: E402

COMMAND_REGISTRY = {
    "load_spectrum": load_spectrum.run,
    "deconvolve": deconvolve.run,
    "apply_filters": apply_filters.run,
    "list_d_folders": list_d_folders.run,
    "ping": lambda params: {"pong": True, "echo": params},
}


def log(msg: str) -> None:
    """Diagnostic log, written to stderr so stdout stays JSON-only."""
    print(f"[sidecar] {msg}", file=sys.stderr, flush=True)


def write_response(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def handle_request(req: dict) -> dict:
    req_id = req.get("id")
    cmd_name = req.get("command")
    params = req.get("params") or {}

    if cmd_name not in COMMAND_REGISTRY:
        return {
            "id": req_id,
            "ok": False,
            "error": {
                "type": "UnknownCommand",
                "message": f"Unknown command: {cmd_name!r}",
            },
        }

    try:
        result = COMMAND_REGISTRY[cmd_name](params)
        return {"id": req_id, "ok": True, "result": result}
    except Exception as e:  # noqa: BLE001 - sidecar must never crash on bad input
        return {
            "id": req_id,
            "ok": False,
            "error": {
                "type": type(e).__name__,
                "message": str(e),
                "traceback": traceback.format_exc(),
            },
        }


def main() -> None:
    log(f"sidecar online; experiments dir = {EXPERIMENTS_DIR}")
    log(f"registered commands: {sorted(COMMAND_REGISTRY)}")
    write_response({"event": "ready", "commands": sorted(COMMAND_REGISTRY)})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            write_response(
                {
                    "id": None,
                    "ok": False,
                    "error": {"type": "JSONDecodeError", "message": str(e)},
                }
            )
            continue
        write_response(handle_request(req))


if __name__ == "__main__":
    main()
