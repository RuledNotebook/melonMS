import { createEffect, createMemo, onCleanup, onMount, Show, untrack } from "solid-js";
import uPlot from "uplot";
import type { Options as UPlotOptions } from "uplot";
import {
  deconvResult,
  filterResult,
  selectedMass,
  setSelectedMass,
  setShowOnlyPassing,
  showOnlyPassing,
} from "../state/store";

/* Mass-domain plot.

   Series 1 ("All masses"): every entry in deconvResult.mass_list as a
                            visible vertical bar.
   Series 2 ("Passing"): subset where filtered_mass_list[i].all_pass is
                         true, drawn as a thicker overlay bar.

   The previous implementation used a stem trick (3 points per peak with
   eps=0.001 Da) which produced sub-pixel-wide verticals at typical
   spectrum scales (a 70 kDa range across 800 px is ~90 Da/px, so a
   0.001 Da-wide stem occupied ~0.00001 px). Switched to a custom path
   that draws an explicit pixel-rounded vertical bar from y=0 up to
   y=value at each mass. Always visible regardless of zoom. */

function verticalBarsPath(barWidthPx = 2) {
  return (u: uPlot, seriesIdx: number, idx0: number, idx1: number) => {
    const series = u.series[seriesIdx];
    const stroke = (typeof series.stroke === "function"
      ? (series.stroke as (u: uPlot, i: number) => string | CanvasGradient)(u, seriesIdx)
      : series.stroke) as string | CanvasGradient | undefined;

    const data = u.data;
    const xs = data[0];
    const ys = data[seriesIdx];
    if (!xs || !ys) return null;

    const ctx = u.ctx;
    ctx.save();
    // Clip drawing to the chart bbox so over-cap bars don't bleed
    // outside the plot area when the y-axis is capped below the true
    // maximum (visual "off-scale" indicator stays inside the chart).
    ctx.beginPath();
    ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    ctx.clip();

    ctx.strokeStyle = (stroke as string) || "#fff";
    ctx.lineWidth = barWidthPx;
    ctx.lineCap = "butt";
    ctx.beginPath();
    // Use the chart bottom (not y=0) as the bar base. Robust against
    // log scales and any range that doesn't include 0.
    const baseY = u.bbox.top + u.bbox.height;
    for (let i = idx0; i <= idx1; i++) {
      const yv = ys[i] as number | null | undefined;
      if (yv == null || Number.isNaN(yv) || !Number.isFinite(yv)) continue;
      const xv = xs[i] as number;
      const px = Math.round(u.valToPos(xv, "x", true)) + 0.5;
      const py = u.valToPos(yv, "y", true);
      if (!Number.isFinite(py)) continue;
      ctx.moveTo(px, baseY);
      ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
    return null;
  };
}

/* Tick values are bare numbers in kDa — the axis label carries the
   unit, so repeating "kDa" on every tick was just visual noise. */
function fmtMassKDa(da: number): string {
  const k = da / 1000;
  if (Math.abs(k) >= 100) return k.toFixed(0);
  if (Math.abs(k) >= 10) return k.toFixed(1);
  return k.toFixed(2);
}

export function MassView() {
  let plotEl!: HTMLDivElement;
  let plotInstance: uPlot | null = null;
  let resizeObserver: ResizeObserver | null = null;

  /* Memoize the prepared plot data so we only re-derive it when inputs
     change. */
  const plotData = createMemo<{
    masses: number[];
    intensities: number[];
    passingMask: boolean[];
  } | null>(() => {
    const dec = deconvResult();
    if (!dec) return null;
    const list = Array.isArray(dec.mass_list) ? dec.mass_list : [];
    console.log(
      `[MassView] deconvResult arrived: ${list.length} masses,`,
      `metadata:`,
      dec.metadata
    );
    const flt = filterResult();
    const passingByMass = new Map<number, boolean>();
    if (flt) {
      for (const f of flt.filtered_mass_list) passingByMass.set(f.mass, f.all_pass);
    }
    const masses = list.map((m) => m.mass);
    const intensities = list.map((m) => m.intensity);
    const passingMask = masses.map((m) => passingByMass.get(m) ?? false);
    return { masses, intensities, passingMask };
  });

  /* Title text reflects total / passing counts and flags when the chart
     is dynamic-range-clipped (one or more peaks far above the rest). */
  const title = createMemo(() => {
    const dec = deconvResult();
    if (!dec) return "no deconvolution result";
    const total = dec.mass_list.length;
    const flt = filterResult();
    const intensities = dec.mass_list.map((m) => m.intensity);
    const trueMax = intensities.length
      ? intensities.reduce((m, v) => (v > m ? v : m), 0)
      : 0;
    let cap = 0;
    if (flt && flt.summary.all_passing > 0) {
      const passingByMass = new Map<number, boolean>();
      for (const f of flt.filtered_mass_list)
        passingByMass.set(f.mass, f.all_pass);
      for (const m of dec.mass_list) {
        if (passingByMass.get(m.mass)) cap = Math.max(cap, m.intensity);
      }
    } else if (intensities.length > 0) {
      const sorted = [...intensities].sort((a, b) => a - b);
      cap = sorted[Math.floor(sorted.length * 0.95)] || 1;
    }
    const overflow = cap > 0 && trueMax > cap * 1.5;
    const counts = flt ? `${total} total · ${flt.summary.all_passing} passing` : `${total} masses`;
    return overflow
      ? `${counts} · ${trueMax.toExponential(1)} max (clipped)`
      : counts;
  });

  let lastSize = { w: 0, h: 0 };
  onMount(() => {
    // Same guard as SpectrumView — round + dedupe to avoid the
    // ResizeObserver feedback loop that drifts the y-axis upward.
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

  /* Build / rebuild the uPlot whenever the prepared data changes. */
  createEffect(() => {
    const data = plotData();
    if (!plotEl) return;

    plotInstance?.destroy();
    plotInstance = null;
    lastSize = { w: 0, h: 0 };

    if (!data || data.masses.length === 0) return;

    // Sort by mass so uPlot's x-axis stays monotonic.
    const order = data.masses
      .map((_, i) => i)
      .sort((a, b) => data.masses[a] - data.masses[b]);
    const xs = Float64Array.from(order.map((i) => data.masses[i]));

    // Normalize to the strongest passing peak so the y-axis reads as
    // 0–100% relative intensity instead of an awkward 1e-9..1e-6 range.
    // Outlier peaks above the cap render as bars going off the top
    // (clipped by ctx.clip in the bars renderer).
    let yNorm = 0;
    let passingMax = 0;
    for (let i = 0; i < data.masses.length; i++) {
      if (data.passingMask[i]) {
        passingMax = Math.max(passingMax, data.intensities[i]);
      }
    }
    if (passingMax > 0) {
      yNorm = passingMax;
    } else {
      const sortedInts = [...data.intensities].sort((a, b) => a - b);
      yNorm = sortedInts[Math.floor(sortedInts.length * 0.95)] || 1;
    }

    const allY = new Float64Array(order.length);
    const passY = new Float64Array(order.length);
    for (let i = 0; i < order.length; i++) {
      const idx = order[i];
      const rel = data.intensities[idx] / yNorm;
      allY[i] = rel;
      passY[i] = data.passingMask[idx] ? rel : Number.NaN;
    }
    const aligned: uPlot.AlignedData = [xs, allY, passY];

    const trueMax = data.intensities.reduce((m, v) => (v > m ? v : m), 0);
    console.log(
      "[MassView] building uPlot,",
      `${data.masses.length} masses,`,
      `mass range: ${Math.min(...data.masses).toFixed(0)} – ${Math.max(...data.masses).toFixed(0)} Da,`,
      `intensity true max: ${trueMax.toExponential(2)},`,
      `normalize to: ${yNorm.toExponential(2)} (`,
      passingMax > 0 ? "max passing" : "95th pct",
      `),`,
      `plotEl dims: ${plotEl.clientWidth} x ${plotEl.clientHeight}`
    );

    // Match SpectrumView's visual: a single bright leaf-green series
    // for the meaningful peaks, with a faint mint background series
    // for context (only visible when the user toggles "only passing"
    // off). Bar widths echo SpectrumView's line stroke for visual
    // consistency.
    const allBars = verticalBarsPath(1);
    const passBars = verticalBarsPath(3);

    const axisStroke = "#c8c8c8";
    const gridStroke = "rgba(255,255,255,0.08)";
    // Faint context layer for non-passing peaks (only visible when the
    // user toggles "only passing" off). Stays subtle so it reads as
    // background noise rather than competing with the signal.
    const allStroke = "rgba(136,255,129,0.18)";
    // Same leaf-green as SpectrumView's line — gives the two charts a
    // matching look.
    const passStroke = "#00d108";

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
        y: {
          auto: false,
          // Normalized to fraction of strongest passing peak; over-cap
          // outliers render up to chart top and get clipped by the
          // bars renderer's bbox clip.
          range: () => [0, 1.15],
        },
      },
      axes: [
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
          label: "mass (kDa)",
          labelSize: 22,
          labelFont: "12px ui-monospace, monospace",
          font: "11px ui-monospace, monospace",
          values: (_u, ticks) => ticks.map(fmtMassKDa),
        },
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
          label: "rel. intensity",
          labelSize: 30,
          labelFont: "12px ui-monospace, monospace",
          font: "11px ui-monospace, monospace",
          values: (_u, ticks) => ticks.map((t) => `${Math.round(t * 100)}%`),
        },
      ],
      series: [
        { label: "mass" },
        {
          label: "all masses",
          stroke: allStroke,
          width: 2,
          paths: allBars,
          points: { show: false },
        },
        {
          label: "passing",
          stroke: passStroke,
          width: 4,
          paths: passBars,
          points: { show: false },
          show: true, // toggled via setSeries in a later effect
        },
      ],
      hooks: {
        ready: [
          (u) => {
            // Click-to-select: convert click x -> nearest mass and update store.
            u.over.addEventListener("click", () => {
              const mz = u.posToVal(u.cursor.left ?? 0, "x");
              if (!Number.isFinite(mz)) return;
              const masses = data.masses;
              let bestIdx = 0;
              let bestDist = Infinity;
              for (let i = 0; i < masses.length; i++) {
                const d = Math.abs(masses[i] - mz);
                if (d < bestDist) {
                  bestDist = d;
                  bestIdx = i;
                }
              }
              if (bestDist < masses[bestIdx] * 0.05 + 100) {
                setSelectedMass(masses[bestIdx]);
              }
            });
          },
        ],
        draw: [
          (u) => {
            // Vertical guideline at the selected mass. untrack() so this hook
            // doesn't cause Solid to rebuild the whole plot when selectedMass
            // changes — the second effect calls u.redraw() instead.
            const sel = untrack(() => selectedMass());
            if (sel == null || !Number.isFinite(sel)) return;
            const ctx = u.ctx;
            const x = u.valToPos(sel, "x", true);
            if (!Number.isFinite(x)) return;
            ctx.save();
            ctx.strokeStyle = "#ff185d";
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x, u.bbox.top);
            ctx.lineTo(x, u.bbox.top + u.bbox.height);
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
      // The header bar already shows total/passing counts. uPlot's bottom
      // legend would steal vertical space and on small windows it ends
      // up clipped below the visible plot area, which reads as
      // "something under the chart that I can't see".
      legend: { show: false },
    };

    try {
      plotInstance = new uPlot(opts, aligned, plotEl);
    } catch (e) {
      console.error("[MassView] uPlot construction failed:", e);
      return;
    }

    // Centersplit-mount race: when deconv lands, App swaps the centre
    // pane from <SpectrumView /> alone to <SpectrumView /> + <MassView />.
    // MassView's effect runs immediately, but the new grid layout hasn't
    // been calculated yet so plotEl.clientWidth/Height read 0. uPlot
    // falls back to its 800×400 default and the canvas paints into a
    // still-0×0 parent. ResizeObserver then never sees a "change"
    // because the parent transitions cleanly to its real size while
    // we already cached lastSize=0 in the no-op skip path.
    //
    // Fix: poll over a few animation frames after construction. As soon
    // as plotEl reports a non-zero size we push setSize in and stop.
    let attempts = 8;
    const captured = plotInstance;
    const tryResize = () => {
      if (plotInstance !== captured || !plotEl) return;
      const w = Math.round(plotEl.clientWidth);
      const h = Math.round(plotEl.clientHeight);
      if (w > 0 && h > 0) {
        if (w !== lastSize.w || h !== lastSize.h) {
          lastSize = { w, h };
          captured.setSize({ width: w, height: h });
          console.log("[MassView] post-mount setSize:", w, "x", h);
        }
        return;
      }
      if (--attempts > 0) requestAnimationFrame(tryResize);
      else
        console.warn(
          "[MassView] plotEl still 0-sized after 8 frames — parent layout never resolved"
        );
    };
    requestAnimationFrame(tryResize);
  });

  /* Re-draw on selectedMass / showOnlyPassing changes. */
  createEffect(() => {
    selectedMass();
    showOnlyPassing();
    plotInstance?.redraw();
  });

  /* When showOnlyPassing toggles, hide/show the "all masses" series. */
  createEffect(() => {
    const onlyPass = showOnlyPassing();
    if (!plotInstance) return;
    plotInstance.setSeries(1, { show: !onlyPass });
    plotInstance.setSeries(2, { show: true });
  });

  return (
    <div class="spectrum">
      <div class="spectrum__header">
        <span class="spectrum__title">{title()}</span>
        <span style={{ display: "flex", gap: "12px", "align-items": "center" }}>
          <label class="masstoggle" title="Hide non-passing peaks">
            <input
              type="checkbox"
              checked={showOnlyPassing()}
              onChange={(e) => setShowOnlyPassing(e.currentTarget.checked)}
            />
            <span>only passing</span>
          </label>
        </span>
      </div>

      <div class="spectrum__plot" ref={plotEl}>
        <Show when={!deconvResult()}>
          <div class="spectrum__empty">
            <div style={{ "font-size": "32px", opacity: 0.4 }}>kDa</div>
            <div style={{ "margin-top": "8px" }}>
              Run deconvolution to populate the mass-domain plot.
            </div>
          </div>
        </Show>
        <Show
          when={
            deconvResult() &&
            (deconvResult()!.mass_list?.length ?? 0) === 0
          }
        >
          <div class="spectrum__empty">
            <div style={{ "font-size": "32px", opacity: 0.4 }}>∅</div>
            <div style={{ "margin-top": "8px" }}>
              Deconvolution returned no peaks above the noise threshold.
            </div>
            <div class="note" style={{ "margin-top": "10px" }}>
              Try a wider mass range or a lower noise threshold preset.
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
