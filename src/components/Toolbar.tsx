import { Show } from "solid-js";
import { isTauri } from "../api/sidecar";
import {
  loadConfigFromBrowser,
  loadConfigFromTauri,
  saveConfigToBrowser,
  saveConfigToTauri,
} from "../config/io";
import { runDeconvolution } from "../state/analysis";
import {
  deconvResult,
  deconvRunning,
  pushToast,
  spectrum,
} from "../state/store";

/* App-level action bar: Run Deconvolution, Save/Load Config.
   Lives between the titlebar and the main 3-column layout. */
export function Toolbar() {
  let loadInputEl: HTMLInputElement | undefined;

  async function onRun() {
    const ok = await runDeconvolution();
    if (ok) pushToast("success", "Deconvolution complete", 2500);
  }

  async function onSave() {
    try {
      if (isTauri()) {
        const written = await saveConfigToTauri();
        if (written) pushToast("success", `Config saved to ${written}`, 3000);
      } else {
        saveConfigToBrowser();
        pushToast("info", "Config downloaded (browser dev mode)", 3000);
      }
    } catch (e) {
      pushToast("error", `Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onLoad() {
    try {
      if (isTauri()) {
        const loaded = await loadConfigFromTauri();
        if (loaded) pushToast("success", "Config loaded", 2500);
      } else {
        loadInputEl?.click();
      }
    } catch (e) {
      pushToast("error", `Load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function onBrowserFilePick(e: Event) {
    const target = e.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        loadConfigFromBrowser(txt);
        pushToast("success", "Config loaded", 2500);
      } catch (err) {
        pushToast("error", `Load failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        target.value = ""; // allow re-selecting the same file
      }
    });
  }

  function runDisabled() {
    return !spectrum() || deconvRunning();
  }

  return (
    <div class="toolbar">
      <button
        class="toolbar__primary"
        disabled={runDisabled()}
        onClick={onRun}
        title={
          !spectrum()
            ? "Load a spectrum first"
            : deconvRunning()
            ? "Deconvolution in progress"
            : "Run deconvolution"
        }
      >
        <Show when={deconvRunning()} fallback={<span>Run Deconvolution</span>}>
          <span class="toolbar__spinner" />
          <span>Running…</span>
        </Show>
      </button>

      <Show when={deconvResult()}>
        {(d) => (
          <span class="toolbar__meta">
            {d().mass_list.length} masses · {d().metadata.runtime_ms} ms ·{" "}
            {d().metadata.converged ? "converged" : "not converged"} ·{" "}
            {d().metadata.n_iterations_run} iters
          </span>
        )}
      </Show>

      <span style={{ "margin-left": "auto", display: "flex", gap: "6px" }}>
        <button onClick={onSave} title="Save deconv + filter params as JSON">
          Save Config
        </button>
        <button onClick={onLoad} title="Load saved deconv + filter params">
          Load Config
        </button>
        <input
          ref={loadInputEl}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={onBrowserFilePick}
        />
      </span>
    </div>
  );
}
