import { createSignal, Show } from "solid-js";
import { isTauri, listDFolders, loadSpectrum } from "../api/sidecar";
import { setError, setLoading, setSpectrum, deconvParams } from "../state/store";
import { SamplePicker } from "./SamplePicker";
import type { Sample } from "../state/types";

/* Drop zone for Bruker .d folders (single sample) or a parent folder
   containing multiple .d acquisitions. The realistic researcher workflow
   has many .d directories in one project folder, so we don't force them
   to drill in to a single sample to get started.

   Two paths to a folder:
     1) Drag-drop: Tauri 2 emits a tauri://drag-drop window event with native
        OS paths. We listen for it and pick the first directory.
     2) Click: opens the system folder picker via @tauri-apps/plugin-dialog.

   Routing rule:
     - path ends in `.d`            -> loadSpectrum directly
     - else (parent dir)            -> listDFolders, render SamplePicker
     - listDFolders returns 0 valid -> error toast

   Browser-mode (no Tauri): drag-drop won't give us a native path (security),
   so we degrade to a manual paste-text fallback for headless dev. The
   `?demo=1` query string short-circuits listDFolders to return mock data
   so SPA-only screenshot work can exercise the picker UI. */

function endsWithD(path: string): boolean {
  const p = path.toLowerCase();
  return p.endsWith(".d") || p.endsWith(".d/") || p.endsWith(".d\\");
}

function isDemoMode(): boolean {
  return typeof window !== "undefined" && window.location.search.includes("demo=1");
}

function mockListDFolders(parent: string) {
  // Synthetic data so the picker renders in `?demo=1` without a sidecar.
  const samples: Sample[] = [
    { name: "BSA_20um_Native_isCID-0eV_1.d", path: `${parent}/BSA_20um_Native_isCID-0eV_1.d`, size_mb: 24.4, valid: true },
    { name: "BSA_20um_Native_isCID-100eV_1.d", path: `${parent}/BSA_20um_Native_isCID-100eV_1.d`, size_mb: 22.6, valid: true },
    { name: "YG54_cTn-NP_Native_JBA09_0mM-EGTA_.d", path: `${parent}/YG54_cTn-NP_Native_JBA09_0mM-EGTA_.d`, size_mb: 78.4, valid: true },
    { name: "YG54_cTn-NP_Native_MW6_4C-3h_100mM-EGTA_.d", path: `${parent}/YG54_cTn-NP_Native_MW6_4C-3h_100mM-EGTA_.d`, size_mb: 89.4, valid: true },
    { name: "ADH_SEC.d", path: `${parent}/ADH_SEC.d`, size_mb: 200.7, valid: false },
    { name: "20230501_denat_cTn000585.d", path: `${parent}/20230501_denat_cTn000585.d`, size_mb: 1971.9, valid: false },
  ];
  samples.sort((a, b) => a.name.localeCompare(b.name));
  return { parent, samples };
}

export function DropZone() {
  const [active, setActive] = createSignal(false);
  const [showFallback, setShowFallback] = createSignal(false);
  const [fallbackPath, setFallbackPath] = createSignal("");
  const [pickerSamples, setPickerSamples] = createSignal<Sample[] | null>(null);
  const [pickerParent, setPickerParent] = createSignal<string | null>(null);
  const [scanning, setScanning] = createSignal(false);

  function clearPicker() {
    setPickerSamples(null);
    setPickerParent(null);
  }

  async function loadFromPath(rawPath: string) {
    const path = rawPath.trim().replace(/^["']|["']$/g, "");
    if (!path) return;

    // Single .d folder: load directly via existing pipeline.
    if (endsWithD(path)) {
      clearPicker();
      setError(null);
      setLoading(true);
      setSpectrum(null);
      try {
        const result = await loadSpectrum({
          path,
          mz_min: deconvParams.mz_min,
          mz_max: deconvParams.mz_max,
          bin_width: deconvParams.peak_fwhm > 0 ? Math.min(deconvParams.peak_fwhm, 0.5) : 0.5,
        });
        setSpectrum(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Parent folder: list its .d children and show inline picker.
    setError(null);
    setScanning(true);
    try {
      let result;
      if (isDemoMode()) {
        // Browser-only dev/screenshot mode: fabricate samples so the picker
        // renders without a Tauri runtime.
        result = mockListDFolders(path);
      } else if (!isTauri()) {
        setError("Browser mode supports a single `.d` folder only — open via `npm run tauri:dev` to scan parent folders.");
        return;
      } else {
        result = await listDFolders(path);
      }

      if (result.samples.length === 0) {
        setError(`No \`.d\` folders found in ${result.parent}`);
        clearPicker();
        return;
      }
      const validCount = result.samples.filter((s) => s.valid).length;
      if (validCount === 0) {
        setError(
          `Found ${result.samples.length} \`.d\` folder(s) in ${result.parent} but none are valid timsTOF acquisitions (analysis.tdf_bin missing).`
        );
        // Still show the picker so the user can see what's there.
      }
      setPickerParent(result.parent);
      setPickerSamples(result.samples);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not scan folder: ${msg}`);
    } finally {
      setScanning(false);
    }
  }

  // Tauri 2 drag-drop — register listener once.
  if (isTauri()) {
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      getCurrentWebview().onDragDropEvent((evt) => {
        if (evt.payload.type === "over") {
          setActive(true);
        } else if (evt.payload.type === "leave") {
          setActive(false);
        } else if (evt.payload.type === "drop") {
          setActive(false);
          const paths = evt.payload.paths;
          if (paths.length > 0) loadFromPath(paths[0]);
        }
      });
    });
  }

  async function pickFolder() {
    if (!isTauri()) {
      setShowFallback(true);
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({
        directory: true,
        multiple: false,
        title: "Select a Bruker `.d` folder, or a folder containing multiple",
      });
      if (typeof selection === "string") {
        loadFromPath(selection);
      }
    } catch (e) {
      setError(`Folder picker failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function onDragOver(e: DragEvent) {
    // We still preventDefault so the browser doesn't navigate when hosted
    // in plain dev mode, even though Tauri uses its own native event.
    e.preventDefault();
    setActive(true);
  }
  function onDragLeave() {
    setActive(false);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setActive(false);
    // In plain-browser mode the File API does not expose absolute paths,
    // so we just nudge the user toward the fallback.
    if (!isTauri()) {
      setShowFallback(true);
    }
  }

  return (
    <Show
      when={pickerSamples() !== null}
      fallback={
        <div
          class="dropzone"
          classList={{ "is-active": active() }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={pickFolder}
        >
          <div class="dropzone__icon">▼</div>
          <div class="dropzone__title">
            Drop a Bruker `.d` folder, or a folder containing multiple `.d` folders
          </div>
          <div class="dropzone__hint">or click to browse</div>

          <Show when={scanning()}>
            <div class="note">Scanning folder…</div>
          </Show>

          <Show when={showFallback()}>
            <div
              style={{
                "margin-top": "16px",
                display: "flex",
                "flex-direction": "column",
                gap: "6px",
                width: "100%",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div class="note" style={{ color: "var(--warn)" }}>
                Browser mode: paste the absolute path to a `.d` folder or a
                folder containing many `.d` folders
              </div>
              <input
                type="text"
                value={fallbackPath()}
                onInput={(e) => setFallbackPath(e.currentTarget.value)}
                placeholder="C:\path\to\sample.d"
                style={{ width: "100%", padding: "6px", "font-family": "var(--mono)" }}
              />
              <button onClick={() => loadFromPath(fallbackPath())}>Load</button>
            </div>
          </Show>
        </div>
      }
    >
      <SamplePicker
        parent={pickerParent() ?? ""}
        samples={pickerSamples() ?? []}
        onSelect={(sample) => {
          // Sidestep handler races: clear the picker before kicking off the
          // load so the spectrum view gets a clean transition.
          clearPicker();
          loadFromPath(sample.path);
        }}
        onCancel={clearPicker}
      />
    </Show>
  );
}
