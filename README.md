# melonMS

Mac-native top-down native MS deconvolution tool (v0 scaffold).

The app is the user-facing front-end for the validated Python deconvolution
pipeline at `../troponin-experiments`. Goal of v0: drag-drop a Bruker `.d`
folder and see the calibrated m/z spectrum rendered in the UI, with the full
Tier-1 UniDec parameter set scaffolded in the side panel ready for v1 wiring.

## Architecture

```
+----------------------+        +-----------------+        +-----------------+
|  Solid + uPlot SPA   | <----> |  Tauri (Rust)   | <----> |  Python sidecar |
|   (src/)             |  IPC   |  src-tauri/     | stdio  |   python/       |
+----------------------+        +-----------------+        +-----------------+
                                                                   |
                                                                   v
                                                          bruker_reader.py
                                                          deconv_engine.py
                                                          posthoc_filter.py
                                                       (../troponin-experiments)
```

- The **SPA** (Solid + uPlot, Vite) lives in `src/`. uPlot does the 1D
  spectrum plot at 60fps with pan/zoom.
- The **Rust shell** (`src-tauri/`) hosts the webview, owns window lifecycle,
  spawns the Python sidecar at startup, and exposes two IPC commands:
  - `sidecar_status()` -> sidecar lifecycle state for the status bar
  - `sidecar_call(command, params)` -> JSON pass-through to the sidecar
- The **Python sidecar** (`python/sidecar.py`) is a JSON-stdio loop that
  dispatches to per-command modules under `python/commands/`. It re-uses
  the existing `troponin-experiments/.venv` virtualenv and imports the
  validated `bruker_reader`, `deconv_engine`, and `posthoc_filter` modules
  directly — no rewrites.

### Why JSON-stdio instead of PyO3?

PyO3 is the long-term path, but for v0 a JSON-stdio sidecar:
- avoids ABI lock to a specific Python version,
- lets us reuse the existing 3.14 venv unmodified,
- keeps each command isolated (a hung deconv can't hang the UI),
- ports trivially to Mac since `python3` + venv is identical there.

## Repository layout

```
troponin-tdms-app/
  src-tauri/                        Rust shell
    src/main.rs                     Tauri entry, IPC commands
    src/sidecar.rs                  Python sidecar lifecycle (spawn, send/recv JSON)
    Cargo.toml
    tauri.conf.json                 Window config, bundle resources
    capabilities/default.json       Tauri 2 ACL
    icons/                          Placeholder icons (replace before ship)
    build.rs
  src/                              Solid SPA
    components/
      DropZone.tsx                  Drag-drop / folder-picker for .d folders
      SpectrumView.tsx              uPlot-backed m/z spectrum view
      ParameterPane.tsx             Tier-1 deconv params (full set, stub-wired)
      FilterPane.tsx                F1/F2/F4 toggles + selected-peak panel
      MassView.tsx                  Mass-domain output (v1 stub)
      PeakDetail.tsx                Per-peak detail (v1 stub)
    state/
      store.ts                      Solid signals + stores
      types.ts                      Shapes mirroring the sidecar JSON contract
    api/
      sidecar.ts                    Wrapper around Tauri invoke()
    App.tsx                         Top-level layout
    main.tsx                        Solid entry
    index.css                       Hand-tuned dark theme
  python/
    sidecar.py                      JSON-stdio dispatch loop
    commands/
      __init__.py
      load_spectrum.py              Wraps TimsTOFReader.summed_spectrum()
    requirements.txt                Reference only — venv is reused from troponin-experiments
  index.html                        Vite root
  vite.config.ts
  tsconfig.json
  package.json
```

## Dev setup

### Prerequisites

| Tool       | Tested version | Notes                                            |
| ---------- | -------------- | ------------------------------------------------ |
| Node.js    | 20+            | 24.x verified locally                             |
| Rust       | 1.77+          | install via `rustup` (stable channel)            |
| Python     | 3.14           | reused from `../troponin-experiments/.venv`      |
| OS         | Windows / Mac  | Mac is the primary ship target                   |

The Python venv at `../troponin-experiments/.venv` is reused as-is. Override
with `TRP_TDMS_PYTHON=/abs/path/to/python` if you want a different interpreter.

### One-time install

```bash
cd troponin-tdms-app
npm install
```

### Run in dev

```bash
npm run tauri:dev
```

This boots Vite on `http://localhost:1420`, then launches the Tauri shell,
which in turn spawns `python/sidecar.py` using the venv described above.

For pure SPA work without the Rust shell (no IPC, drag-drop falls back to a
manual path-paste input):

```bash
npm run dev
```

### Production build

```bash
npm run tauri:build
```

Outputs platform-native installers under `src-tauri/target/release/bundle/`.

## Adding a new sidecar command

1. Drop a module under `python/commands/<name>.py` exposing
   `def run(params: dict) -> dict:` — raise on bad input, return JSON-safe
   data. See `commands/load_spectrum.py` as the canonical example.
2. Register it in `python/sidecar.py` `COMMAND_REGISTRY`.
3. Add a typed wrapper in `src/api/sidecar.ts`:
   ```ts
   export async function myCommand(params: MyParams): Promise<MyResult> {
     return sidecarCall<MyResult>("my_command", params);
   }
   ```
4. Add the result/param types to `src/state/types.ts` so the UI stays typed.

No Rust changes required — `sidecar_call` is generic.

## v0 status

| Item                                              | Status        |
| ------------------------------------------------- | ------------- |
| Tauri scaffold boots                              | scaffolded †  |
| Python sidecar JSON-stdio loop                    | working       |
| `load_spectrum` returns calibrated m/z + intensity| working       |
| Drag-drop / folder-picker → IPC                   | wired         |
| uPlot renders m/z vs intensity with pan/zoom      | wired         |
| Tier-1 parameter UI (full set, stub-wired)        | wired         |
| F1/F2/F4 filter toggles                           | scaffolded    |
| Mass-domain view                                  | stub          |
| Per-peak detail                                   | stub          |
| Deconvolution wired to compute                    | not in v0     |

† `cargo check` blocked locally by Windows Smart App Control (SAC) — see the
"Known issues" section. The Tauri wiring is correct; on a machine without
SAC restrictions (any Mac, or Windows with SAC off) `npm run tauri:dev`
launches the window directly.

## Known issues / blockers

### Smart App Control on Windows blocks `cargo` build

If you see `os error 4551` ("Application Control policy has blocked this
file") during `cargo check`/`cargo build`, your machine has Windows Smart
App Control enabled. SAC blocks unsigned executables, including the
intermediate binaries cargo emits during compilation.

To unblock:
- **Recommended for shipping:** build on Mac (which is the primary ship
  target anyway). All the Tauri config in this repo is cross-platform.
- Or disable SAC on Windows: Settings → Privacy & security → Windows
  Security → App & browser control → Smart App Control → "Off". This is a
  one-way switch on Windows 11 and requires a Windows reset to re-enable.

### Icons are placeholders

`src-tauri/icons/*` are 32x32 solid-color placeholders. Replace before
shipping a real build.
