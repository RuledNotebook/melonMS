/* Save / Load configuration JSON.

   Tauri path: uses @tauri-apps/plugin-dialog for save/open + plugin-fs for
     the actual write/read. We import those modules lazily so the file-loaders
     aren't bundled into the SPA when running in the browser.
   Browser path: triggers an <a download> for save and reads File text on load.

   The JSON envelope is { version: 1, deconvParams, filterParams } so we can
   migrate cleanly later. */

import { unwrap } from "solid-js/store";
import { isTauri } from "../api/sidecar";
import {
  deconvParams,
  filterParams,
  setDeconvParams,
  setFilterParams,
} from "../state/store";
import {
  DEFAULT_DECONV_PARAMS,
  DEFAULT_FILTER_PARAMS,
  type AppConfig,
} from "../state/types";

function buildConfigJson(): string {
  const cfg: AppConfig = {
    version: 1,
    deconvParams: { ...unwrap(deconvParams) },
    filterParams: { ...unwrap(filterParams) },
  };
  return JSON.stringify(cfg, null, 2);
}

function applyConfig(parsed: unknown) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Config file is not a JSON object.");
  }
  const cfg = parsed as Partial<AppConfig>;
  if (cfg.version !== 1) {
    throw new Error(`Unsupported config version: ${String(cfg.version)}`);
  }
  // Merge over defaults so missing keys are filled rather than nuking the store.
  setDeconvParams({ ...DEFAULT_DECONV_PARAMS, ...(cfg.deconvParams ?? {}) });
  setFilterParams({ ...DEFAULT_FILTER_PARAMS, ...(cfg.filterParams ?? {}) });
}

/* ---- Tauri ---- */

/* Dynamic import via a variable so Vite's static analyzer doesn't try to
   resolve the optional plugin at dev-server transform time. The runtime
   try/catch handles the missing-package case. */
type TauriFsModule = {
  writeTextFile: (path: string, contents: string) => Promise<void>;
  readTextFile: (path: string) => Promise<string>;
};

async function importTauriFs(): Promise<TauriFsModule> {
  const moduleId = "@tauri-apps/plugin-fs";
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const dyn = new Function("id", "return import(id)") as (id: string) => Promise<TauriFsModule>;
  return dyn(moduleId);
}

export async function saveConfigToTauri(): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: "Save melonMS config",
    defaultPath: "melonms-config.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return null;
  try {
    const fs = await importTauriFs();
    await fs.writeTextFile(path, buildConfigJson());
    return path;
  } catch (e) {
    throw new Error(
      `Could not write config (is @tauri-apps/plugin-fs installed?): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}

export async function loadConfigFromTauri(): Promise<boolean> {
  if (!isTauri()) return false;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selection = await open({
    title: "Load melonMS config",
    multiple: false,
    directory: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof selection !== "string") return false;
  try {
    const fs = await importTauriFs();
    const txt = await fs.readTextFile(selection);
    applyConfig(JSON.parse(txt));
    return true;
  } catch (e) {
    throw new Error(
      `Could not read config (is @tauri-apps/plugin-fs installed?): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}

/* ---- Browser fallback ---- */

export function saveConfigToBrowser(filename = "melonms-config.json") {
  const blob = new Blob([buildConfigJson()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function loadConfigFromBrowser(text: string) {
  applyConfig(JSON.parse(text));
}
