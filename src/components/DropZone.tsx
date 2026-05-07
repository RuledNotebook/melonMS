import { createSignal, Show } from "solid-js";
import { isTauri, loadSpectrum } from "../api/sidecar";
import { setError, setLoading, setSpectrum, deconvParams } from "../state/store";

/* Drop zone for Bruker .d folders.

   Two paths to a folder:
     1) Drag-drop: Tauri 2 emits a tauri://drag-drop window event with native
        OS paths. We listen for it and pick the first directory.
     2) Click: opens the system folder picker via @tauri-apps/plugin-dialog.

   Browser-mode (no Tauri): drag-drop won't give us a native path (security),
   so we degrade to a manual paste-text fallback for headless dev. */

export function DropZone() {
  const [active, setActive] = createSignal(false);
  const [showFallback, setShowFallback] = createSignal(false);
  const [fallbackPath, setFallbackPath] = createSignal("");

  async function loadFromPath(rawPath: string) {
    const path = rawPath.trim().replace(/^["']|["']$/g, "");
    if (!path) return;
    if (!path.toLowerCase().endsWith(".d") && !path.toLowerCase().endsWith(".d/") && !path.toLowerCase().endsWith(".d\\")) {
      setError(`Path does not look like a Bruker .d folder: ${path}`);
      return;
    }

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
        title: "Select a Bruker .d folder",
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
    <div
      class="dropzone"
      classList={{ "is-active": active() }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={pickFolder}
    >
      <div class="dropzone__icon">▼</div>
      <div class="dropzone__title">Drop a Bruker .d folder here</div>
      <div class="dropzone__hint">or click to browse</div>

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
            Browser mode: paste the absolute path to your .d folder
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
  );
}
