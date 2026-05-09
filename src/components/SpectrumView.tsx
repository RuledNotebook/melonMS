import { createEffect, onCleanup, onMount, Show } from "solid-js";
import uPlot from "uplot";
import type { Options as UPlotOptions } from "uplot";
import { error, loadProgress, loading, spectrum } from "../state/store";
import { LoadingBar } from "./LoadingBar";

/* uPlot wrapper.

   We treat the plot as a pure function of the spectrum signal: when it
   changes we destroy the old uPlot instance and rebuild. uPlot is fast enough
   that this is negligible vs. setData() for v0; we'll switch to in-place
   setData when streaming/refit lands in v1. */

export function SpectrumView() {
  let plotEl!: HTMLDivElement;
  let plotInstance: uPlot | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let lastSize = { w: 0, h: 0 };

  onMount(() => {
    // Round to whole pixels and ignore no-op deltas so that micro-jitter
    // (sub-pixel layout shifts, or the plot canvas itself triggering a
    // 1-px reflow) can't kick off a setSize feedback loop. Without this
    // guard the plot's own redraw can grow the parent by a fraction
    // each frame, which manifests as the y-axis label slowly drifting.
    resizeObserver = new ResizeObserver(() => {
      if (!plotInstance || !plotEl) return;
      const w = Math.round(plotEl.clientWidth);
      const h = Math.round(plotEl.clientHeight);
      if (w <= 0 || h <= 0) return;
      if (w === lastSize.w && h === lastSize.h) return;
      lastSize = { w, h };
      plotInstance.setSize({ width: w, height: h });
    });
    resizeObserver.observe(plotEl);
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    plotInstance?.destroy();
    plotInstance = null;
  });

  createEffect(() => {
    const s = spectrum();

    // Always tear the previous plot down first, including when the
    // spectrum is cleared (s == null) — otherwise an old chart can sit
    // underneath the loading overlay and continue receiving resize
    // events.
    plotInstance?.destroy();
    plotInstance = null;
    lastSize = { w: 0, h: 0 };

    if (!s || !plotEl) return;

    const data: uPlot.AlignedData = [
      Float64Array.from(s.mz),
      Float64Array.from(s.intensity),
    ];

    const axisStroke = "#c8c8c8";
    const gridStroke = "rgba(255,255,255,0.08)";
    const seriesStroke = "#00d108";
    const seriesFill = "rgba(0,209,8,0.14)";

    const opts: UPlotOptions = {
      width: plotEl.clientWidth || 800,
      height: plotEl.clientHeight || 400,
      pxAlign: false,
      cursor: {
        drag: { x: true, y: false, uni: 50 },
        focus: { prox: 16 },
      },
      scales: {
        x: { time: false },
        y: { auto: true, range: (_u, _min, max) => [0, max * 1.05] },
      },
      axes: [
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
          label: "m/z",
          labelSize: 22,
          labelFont: "12px ui-monospace, monospace",
          font: "11px ui-monospace, monospace",
        },
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
          label: "intensity",
          labelSize: 30,
          labelFont: "12px ui-monospace, monospace",
          font: "11px ui-monospace, monospace",
          values: (_u, ticks) =>
            ticks.map((t) => {
              const abs = Math.abs(t);
              if (abs >= 1e6) return (t / 1e6).toFixed(1) + "M";
              if (abs >= 1e3) return (t / 1e3).toFixed(1) + "k";
              return String(t);
            }),
        },
      ],
      series: [
        { label: "m/z" },
        {
          label: "intensity",
          stroke: seriesStroke,
          width: 1,
          fill: seriesFill,
          points: { show: false },
        },
      ],
      // Header already carries the file/calibration meta; suppress the
      // bottom legend so it can't be clipped on small viewports.
      legend: { show: false },
    };

    plotInstance = new uPlot(opts, data, plotEl);
  });

  return (
    <div class="spectrum">
      <div class="spectrum__header">
        <Show when={spectrum()} fallback={<span class="spectrum__title">no spectrum loaded</span>}>
          {(s) => (
            <>
              <span class="spectrum__title" title={s().path}>
                {s().name}
              </span>
              <span class="spectrum__title" style={{ "text-align": "right" }}>
                {s().n_points_full.toLocaleString()} pts
                {s().downsampled ? ` (showing ${s().mz.length.toLocaleString()})` : ""}
                {" · "}bin {s().bin_width} m/z
              </span>
            </>
          )}
        </Show>
      </div>

      <div class="spectrum__plot" ref={plotEl}>
        <Show when={loading()}>
          <div class="spectrum__loading">
            <div class="spectrum__loading-bar">
              {(() => {
                const progressFraction = () => {
                  const p = loadProgress();
                  if (!p) return undefined;
                  if (
                    typeof p.step === "number" &&
                    typeof p.steps === "number" &&
                    p.steps > 0
                  ) {
                    let inStep = p.step === p.steps ? 1 : 0.5;
                    if (
                      typeof p.frame === "number" &&
                      typeof p.frames === "number" &&
                      p.frames > 0
                    ) {
                      inStep = p.frame / p.frames;
                    }
                    return Math.min(1, ((p.step - 1) + inStep) / p.steps);
                  }
                  return undefined;
                };
                const subline = () => {
                  const p = loadProgress();
                  if (!p) return undefined;
                  const parts: string[] = [];
                  if (
                    typeof p.frame === "number" &&
                    typeof p.frames === "number"
                  ) {
                    parts.push(
                      `frame ${p.frame.toLocaleString()} / ${p.frames.toLocaleString()}`
                    );
                  }
                  if (
                    typeof p.step === "number" &&
                    typeof p.steps === "number"
                  ) {
                    parts.push(`step ${p.step}/${p.steps}`);
                  }
                  return parts.length ? parts.join(" · ") : undefined;
                };
                return (
                  <LoadingBar
                    label={
                      loadProgress()?.stage ??
                      "Reading .d folder and computing calibrated spectrum…"
                    }
                    sublabel={subline()}
                    progress={progressFraction()}
                    expectedSeconds={90}
                  />
                );
              })()}
            </div>
            <div class="note" style={{ "margin-top": "12px" }}>
              Live progress streams from the Python sidecar.
              The Reading-frames stage dominates total runtime for large .d folders.
            </div>
          </div>
        </Show>

        <Show when={!loading() && error()}>
          <div class="spectrum__error">
            <strong>Failed to load spectrum</strong>
            <div class="note" style={{ color: "inherit", "margin-top": "6px" }}>
              {error()}
            </div>
          </div>
        </Show>

        <Show when={!loading() && !error() && !spectrum()}>
          <div class="spectrum__empty">
            <div style={{ "font-size": "32px", opacity: 0.4 }}>m/z</div>
            <div style={{ "margin-top": "8px" }}>
              Drop a Bruker <code>.d</code> folder in the left sidebar
              to render the calibrated spectrum.
            </div>
            <div class="note" style={{ "margin-top": "10px" }}>
              Drag-select a region of the plot to zoom in.
              Double-click to reset.
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
