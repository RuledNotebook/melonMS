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

   Series 1 ("All masses"): every entry in deconvResult.mass_list as a thin
                            stem-style line.
   Series 2 ("Passing"): subset where filtered_mass_list[i].all_pass is true.
                         Drawn as a thicker overlay.

   uPlot needs aligned data. Since masses are sparse, we render them as zero-
   height baselines + per-peak verticals. Easiest approach: use a "bars" path
   with width 0 and points shown — but uPlot doesn't have great support for
   that pattern. Instead we duplicate each x with adjacent zero values to
   produce vertical sticks. */

function buildStemSeries(masses: number[], intensities: number[]) {
  // For each (m, i), emit (m-eps, 0), (m, i), (m+eps, 0) so the line draws a
  // vertical stick. eps must be smaller than the mass bin to avoid bleed.
  const n = masses.length;
  const xs = new Float64Array(n * 3);
  const ys = new Float64Array(n * 3);
  const eps = 1e-3;
  for (let i = 0; i < n; i++) {
    const m = masses[i];
    const v = intensities[i];
    xs[3 * i] = m - eps;
    xs[3 * i + 1] = m;
    xs[3 * i + 2] = m + eps;
    ys[3 * i] = 0;
    ys[3 * i + 1] = v;
    ys[3 * i + 2] = 0;
  }
  return { xs, ys };
}

function fmtMass(t: number): string {
  if (Math.abs(t) >= 1000) return (t / 1000).toFixed(1) + " kDa";
  return t.toFixed(0);
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
    const flt = filterResult();
    const passingByMass = new Map<number, boolean>();
    if (flt) {
      for (const f of flt.filtered_mass_list) passingByMass.set(f.mass, f.all_pass);
    }
    const masses = dec.mass_list.map((m) => m.mass);
    const intensities = dec.mass_list.map((m) => m.intensity);
    const passingMask = masses.map((m) => passingByMass.get(m) ?? false);
    return { masses, intensities, passingMask };
  });

  /* Title text reflects total / passing counts. */
  const title = createMemo(() => {
    const dec = deconvResult();
    if (!dec) return "no deconvolution result";
    const total = dec.mass_list.length;
    const flt = filterResult();
    if (!flt) return `${total} masses`;
    return `${total} total · ${flt.summary.all_passing} passing`;
  });

  onMount(() => {
    resizeObserver = new ResizeObserver(() => {
      if (!plotInstance || !plotEl) return;
      const w = plotEl.clientWidth;
      const h = plotEl.clientHeight;
      if (w > 0 && h > 0) plotInstance.setSize({ width: w, height: h });
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

    if (!data || data.masses.length === 0) return;

    const passingMasses: number[] = [];
    const passingIntensities: number[] = [];
    for (let i = 0; i < data.masses.length; i++) {
      if (data.passingMask[i]) {
        passingMasses.push(data.masses[i]);
        passingIntensities.push(data.intensities[i]);
      }
    }

    const allStems = buildStemSeries(data.masses, data.intensities);
    const passStems = buildStemSeries(passingMasses, passingIntensities);

    // Solid quirk: uPlot needs a single x axis shared across series. We pad
    // each series to the *combined* x range by using a master x array that is
    // the union of all stem x's. Easier: draw two separate uPlots? No — we
    // align by feeding both series' y arrays against a single sorted x.
    const allX = new Set<number>();
    for (const x of allStems.xs) allX.add(x);
    for (const x of passStems.xs) allX.add(x);
    const xs = Float64Array.from(Array.from(allX).sort((a, b) => a - b));

    // Build y maps keyed by x, defaulting to NaN so uPlot renders gaps.
    const allYMap = new Map<number, number>();
    for (let i = 0; i < allStems.xs.length; i++) {
      allYMap.set(allStems.xs[i], allStems.ys[i]);
    }
    const passYMap = new Map<number, number>();
    for (let i = 0; i < passStems.xs.length; i++) {
      passYMap.set(passStems.xs[i], passStems.ys[i]);
    }
    const allY = new Float64Array(xs.length);
    const passY = new Float64Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      allY[i] = allYMap.has(x) ? (allYMap.get(x) as number) : NaN;
      passY[i] = passYMap.has(x) ? (passYMap.get(x) as number) : NaN;
    }

    const aligned: uPlot.AlignedData = [xs, allY, passY];

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
          stroke: "#b1bac4",
          grid: { stroke: "#2d343d", width: 1 },
          ticks: { stroke: "#2d343d" },
          label: "mass (Da)",
          labelSize: 22,
          labelFont: "12px ui-monospace, monospace",
          font: "11px ui-monospace, monospace",
          values: (_u, ticks) => ticks.map(fmtMass),
        },
        {
          stroke: "#b1bac4",
          grid: { stroke: "#2d343d", width: 1 },
          ticks: { stroke: "#2d343d" },
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
        { label: "mass" },
        {
          label: "all masses",
          stroke: "#58a6ff",
          width: 1,
          spanGaps: false,
          points: { show: false },
        },
        {
          label: "passing",
          stroke: "#3fb950",
          width: 2,
          spanGaps: false,
          points: { show: false },
          show: true, // overlay; toggled in a later effect
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
            ctx.strokeStyle = "#f0b04a";
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
      legend: { show: true, live: true },
    };

    plotInstance = new uPlot(opts, aligned, plotEl);
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
            <div style={{ "font-size": "32px", opacity: 0.4 }}>Da</div>
            <div style={{ "margin-top": "8px" }}>
              Run deconvolution to populate the mass-domain plot.
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
