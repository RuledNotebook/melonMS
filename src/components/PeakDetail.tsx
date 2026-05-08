import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import uPlot from "uplot";
import type { Options as UPlotOptions } from "uplot";
import {
  deconvResult,
  filterResult,
  selectedMass,
} from "../state/store";
import type { FilteredMass, MassPeak } from "../state/types";

/* Hard-coded paper baselines for "suggested identity" matching.
   See task spec §3 for the source masses. */
const PAPER_BASELINES: Array<{ mass: number; name: string }> = [
  { mass: 77144, name: "Heterotrimer (cTnI·cTnT·TnC)" },
  { mass: 72886, name: "Calpain cTnI(2-174)" },
  { mass: 19728, name: "Calpain cTnI(40-210)" },
  { mass: 24000, name: "Free cTnI" },
  { mass: 33000, name: "Free cTnT" },
  { mass: 18481, name: "Free TnC" },
];

const ID_TOL_DA = 50;

function findIdentity(mass: number) {
  let best: (typeof PAPER_BASELINES)[number] | null = null;
  let bestDelta = Infinity;
  for (const cand of PAPER_BASELINES) {
    const d = Math.abs(cand.mass - mass);
    if (d < bestDelta) {
      bestDelta = d;
      best = cand;
    }
  }
  if (!best || bestDelta > ID_TOL_DA) return null;
  return { ...best, delta: mass - best.mass };
}

/* Find the nearest baseline regardless of tolerance, used for the "Δ from
   nearest paper baseline" readout in the header. */
function nearestBaseline(mass: number) {
  let best: (typeof PAPER_BASELINES)[number] | null = null;
  let bestDelta = Infinity;
  for (const cand of PAPER_BASELINES) {
    const d = Math.abs(cand.mass - mass);
    if (d < bestDelta) {
      bestDelta = d;
      best = cand;
    }
  }
  if (!best) return null;
  return { ...best, delta: mass - best.mass };
}

function fmt(n: number, digits = 2): string {
  if (Number.isNaN(n) || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function PassBadge(props: { label: string; pass?: boolean | undefined }) {
  return (
    <span
      class="badge"
      classList={{
        "badge--pass": props.pass === true,
        "badge--fail": props.pass === false,
        "badge--unknown": props.pass === undefined,
      }}
      title={
        props.pass === undefined
          ? `${props.label} not evaluated yet`
          : props.pass
          ? `${props.label} pass`
          : `${props.label} fail`
      }
    >
      {props.label}
    </span>
  );
}

export function PeakDetail() {
  // chargeEl is rendered conditionally inside <Show when={peak()}>, so the
  // ref isn't set until the user selects a peak. Type as nullable; init
  // ResizeObserver lazily when the element first appears.
  let chargeEl: HTMLDivElement | undefined;
  let chargePlot: uPlot | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let observedEl: HTMLDivElement | null = null;

  /* Currently-selected MassPeak (full record) and matching FilteredMass. */
  const peak = createMemo<MassPeak | null>(() => {
    const dec = deconvResult();
    const m = selectedMass();
    if (!dec || m == null) return null;
    return dec.mass_list.find((x) => x.mass === m) ?? null;
  });

  const flt = createMemo<FilteredMass | null>(() => {
    const f = filterResult();
    const m = selectedMass();
    if (!f || m == null) return null;
    return f.filtered_mass_list.find((x) => x.mass === m) ?? null;
  });

  const identity = createMemo(() => {
    const p = peak();
    if (!p) return null;
    return findIdentity(p.mass);
  });

  const nearest = createMemo(() => {
    const p = peak();
    if (!p) return null;
    return nearestBaseline(p.mass);
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    chargePlot?.destroy();
    chargePlot = null;
  });

  /* Mini uPlot of the charge envelope. */
  createEffect(() => {
    const p = peak();
    chargePlot?.destroy();
    chargePlot = null;
    if (!p || !chargeEl) return;
    // Lazy-init / re-attach the resize observer once the conditional
    // <Show>-rendered chargeEl is in the DOM.
    if (chargeEl !== observedEl) {
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => {
        if (!chargePlot || !chargeEl) return;
        const w = chargeEl.clientWidth;
        const h = chargeEl.clientHeight;
        if (w > 0 && h > 0) chargePlot.setSize({ width: w, height: h });
      });
      resizeObserver.observe(chargeEl);
      observedEl = chargeEl;
    }
    if (p.charge_envelope.length === 0) return;

    // sort by charge ascending
    const sorted = [...p.charge_envelope].sort((a, b) => a.charge - b.charge);
    // Stem-style: pad so each charge becomes a vertical bar.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const e of sorted) {
      xs.push(e.charge - 0.001, e.charge, e.charge + 0.001);
      ys.push(0, e.intensity, 0);
    }
    const data: uPlot.AlignedData = [
      Float64Array.from(xs),
      Float64Array.from(ys),
    ];
    const opts: UPlotOptions = {
      width: chargeEl.clientWidth || 280,
      height: chargeEl.clientHeight || 110,
      pxAlign: false,
      cursor: { drag: { x: false, y: false } },
      legend: { show: false },
      scales: {
        x: { time: false, range: [sorted[0].charge - 1, sorted[sorted.length - 1].charge + 1] },
        y: { auto: true, range: (_u, _min, max) => [0, max * 1.05] },
      },
      axes: [
        {
          stroke: "#b1bac4",
          grid: { stroke: "#2d343d", width: 1 },
          ticks: { stroke: "#2d343d" },
          font: "10px ui-monospace, monospace",
          incrs: [1, 2, 5, 10],
          values: (_u, ticks) => ticks.map((t) => String(Math.round(t))),
        },
        {
          stroke: "#b1bac4",
          grid: { stroke: "#2d343d", width: 1 },
          ticks: { stroke: "#2d343d" },
          font: "10px ui-monospace, monospace",
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
        { label: "z" },
        {
          label: "intensity",
          stroke: "#58a6ff",
          fill: "rgba(88,166,255,0.2)",
          width: 1,
          spanGaps: false,
          points: { show: false },
        },
      ],
    };
    chargePlot = new uPlot(opts, data, chargeEl);
  });

  return (
    <div class="section peakdetail">
      <h4>Peak detail</h4>

      <Show
        when={peak()}
        fallback={<div class="note">Click a peak in the mass plot to inspect it.</div>}
      >
        {(p) => (
          <>
            <div class="peakdetail__mass">
              <strong>{fmt(p().mass, 1)}</strong>
              <span class="unit">Da</span>
              <Show when={nearest()}>
                {(n) => (
                  <span
                    class="peakdetail__delta"
                    title={`Nearest paper baseline: ${n().name} @ ${n().mass} Da`}
                  >
                    Δ {n().delta >= 0 ? "+" : ""}{fmt(n().delta, 1)} Da from {n().name.split(" ")[0]}
                  </span>
                )}
              </Show>
            </div>

            <div class="peakdetail__grid">
              <div>
                <span class="k">FDR</span>
                <span class="v">{fmt(p().fdr, 4)}</span>
              </div>
              <div>
                <span class="k">n_z</span>
                <span class="v">{p().n_z}</span>
              </div>
              <div>
                <span class="k">env score</span>
                <span class="v">{fmt(p().envelope_score, 3)}</span>
              </div>
              <div>
                <span class="k">rel int</span>
                <span class="v">{fmt(p().rel_intensity, 3)}</span>
              </div>
              <div>
                <span class="k">abs int</span>
                <span class="v">{p().intensity.toExponential(2)}</span>
              </div>
            </div>

            <div class="peakdetail__badges">
              <PassBadge label="F1" pass={flt()?.f1_pass} />
              <PassBadge label="F2" pass={flt()?.f2_pass} />
              <PassBadge label="F4a" pass={flt()?.f4a_pass} />
              <PassBadge label="F4b" pass={flt()?.f4b_pass} />
              <Show when={flt()?.cluster_id}>
                {(cid) => <span class="badge badge--cluster">cluster {cid()}</span>}
              </Show>
            </div>

            <div class="peakdetail__chargehead">Charge envelope ({p().n_z} z)</div>
            <div class="peakdetail__charge" ref={chargeEl} />

            <div class="peakdetail__id">
              <div class="k">Suggested identity</div>
              <Show
                when={identity()}
                fallback={
                  <div class="v" style={{ color: "var(--text-2)" }}>
                    no match within ±{ID_TOL_DA} Da
                  </div>
                }
              >
                {(id) => (
                  <div class="v">
                    {id().name}
                    <span class="peakdetail__delta">
                      {" "}@ {id().mass} Da · Δ {id().delta >= 0 ? "+" : ""}
                      {fmt(id().delta, 1)} Da
                    </span>
                  </div>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
