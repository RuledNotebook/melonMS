import { Show } from "solid-js";
import { isTauri } from "../api/sidecar";
import {
  loadConfigFromBrowser,
  loadConfigFromTauri,
  saveConfigToBrowser,
  saveConfigToTauri,
} from "../config/io";
import { deconvResult, pushToast } from "../state/store";

/* Compact action bar between the titlebar and main grid. Run Deconvolution
   moved to the left ProjectSidebar; this row is now Save/Load Config plus
   a one-line stats readout once a deconv result lands. */
export function Toolbar() {
  let loadInputEl: HTMLInputElement | undefined;

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
        pushToast(
          "error",
          `Load failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        target.value = "";
      }
    });
  }

  return (
    <div class="toolbar">
      <Show when={deconvResult()}>
        {(d) => (
          <span class="toolbar__meta">
            {d().mass_list.length} masses · {d().metadata.runtime_ms} ms ·{" "}
            {d().metadata.converged ? "converged" : "not converged"} ·{" "}
            {d().metadata.n_iterations_run} iters
          </span>
        )}
      </Show>

      <span class="toolbar__actions">
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
