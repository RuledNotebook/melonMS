/* Thin wrapper around Tauri's `invoke` for talking to the Python sidecar.

   Two Rust commands are exposed in src-tauri/src/main.rs:
     - sidecar_status()   -> SidecarStatus
     - sidecar_call(cmd, params) -> JSON value

   When the page is loaded in a plain browser (no Tauri runtime), invoke() is
   undefined, so we fall back to a clear error. This lets `npm run dev` boot
   the SPA for UI work without confusingly silent failures. */

import type {
  LoadSpectrumParams,
  SidecarStatus,
  SpectrumResult,
} from "../state/types";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function getInvoke(): InvokeFn | null {
  // Tauri 2.x exposes the API via window.__TAURI_INTERNALS__ once the runtime
  // is alive. We import lazily so this module remains usable in pure-browser
  // dev mode (where `@tauri-apps/api` works but invoke() throws).
  const w = globalThis as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return null;
  return async <T,>(cmd: string, args?: Record<string, unknown>) => {
    const mod = await import("@tauri-apps/api/core");
    return (await mod.invoke(cmd, args)) as T;
  };
}

export function isTauri(): boolean {
  return getInvoke() !== null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error(
      "Tauri runtime not available. Run via `npm run tauri:dev` (not plain `npm run dev`)."
    );
  }
  return invoke<T>(cmd, args);
}

export async function getSidecarStatus(): Promise<SidecarStatus> {
  return call<SidecarStatus>("sidecar_status");
}

export async function loadSpectrum(
  params: LoadSpectrumParams
): Promise<SpectrumResult> {
  return call<SpectrumResult>("sidecar_call", {
    command: "load_spectrum",
    params,
  });
}

/* Generic escape hatch — useful while wiring v1 commands. */
export async function sidecarCall<T = unknown>(
  command: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return call<T>("sidecar_call", { command, params });
}
