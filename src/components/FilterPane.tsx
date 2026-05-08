import { Show } from "solid-js";
import { triggerFilterPipeline } from "../state/analysis";
import {
  filterParams,
  filterResult,
  filterRunning,
  resetFilterParams,
  setFilterParams,
} from "../state/store";
import { PeakDetail } from "./PeakDetail";

/* F1 / F2 / F4 post-hoc filter controls.

   Every change debounces 300ms and re-fires apply_filters via the analysis
   layer; MassView re-renders automatically through signal subscription.

   FilterPane also hosts the inline mass plot summary widgets and the per-peak
   detail panel — keeps the right column self-contained. */

function num(props: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
  unit?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div class="row">
      <label title={props.hint}>
        {props.label}
        {props.unit ? <span style={{ color: "var(--text-2)" }}> ({props.unit})</span> : null}
      </label>
      <input
        type="number"
        value={props.value}
        step={props.step ?? "any"}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        onInput={(e) => {
          const v = parseFloat(e.currentTarget.value);
          if (!Number.isNaN(v)) {
            props.onChange(v);
            triggerFilterPipeline();
          }
        }}
      />
    </div>
  );
}

function check(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div class="row">
      <label title={props.hint}>{props.label}</label>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => {
          props.onChange(e.currentTarget.checked);
          triggerFilterPipeline();
        }}
      />
    </div>
  );
}

export function FilterPane() {
  return (
    <aside class="pane">
      <div class="pane__header">
        Mass output
        <Show when={filterRunning()}>
          <span class="pane__header-spinner" title="Re-applying filters" />
        </Show>
      </div>
      <div class="pane__body">
        <div class="section">
          <h4>Filter summary</h4>
          <Show
            when={filterResult()}
            fallback={<div class="note">Filters update once a deconvolution result is available.</div>}
          >
            {(r) => (
              <div class="filter-summary">
                <div><span class="k">total</span><span class="v">{r().summary.total_input}</span></div>
                <div><span class="k">F1 pass</span><span class="v">{r().summary.f1_passing}</span></div>
                <div><span class="k">F2 pass</span><span class="v">{r().summary.f2_passing}</span></div>
                <div><span class="k">F4 pass</span><span class="v">{r().summary.f4_passing}</span></div>
                <div class="all"><span class="k">all pass</span><span class="v">{r().summary.all_passing}</span></div>
              </div>
            )}
          </Show>
        </div>

        <div class="section">
          <h4>F1 — charge coherence</h4>
          {check({
            label: "Enable F1",
            hint: "Charge-state coherence (clusters of charges agreeing on mass)",
            checked: filterParams.f1_enabled,
            onChange: (v) => setFilterParams("f1_enabled", v),
          })}
          {num({
            label: "min cluster size",
            value: filterParams.f1_min_cluster_size,
            step: 1,
            min: 1,
            disabled: !filterParams.f1_enabled,
            onChange: (v) => setFilterParams("f1_min_cluster_size", Math.round(v)),
          })}
          {num({
            label: "max gap",
            unit: "Da",
            value: filterParams.f1_max_gap_da,
            step: 10,
            min: 0,
            disabled: !filterParams.f1_enabled,
            onChange: (v) => setFilterParams("f1_max_gap_da", v),
          })}
        </div>

        <div class="section">
          <h4>F2 — isotope spacing</h4>
          {check({
            label: "Enable F2",
            hint: "Charge-count thresholds binned by mass",
            checked: filterParams.f2_enabled,
            onChange: (v) => setFilterParams("f2_enabled", v),
          })}
          {num({
            label: "vlight threshold",
            value: filterParams.f2_threshold_vlight,
            step: 1,
            min: 0,
            disabled: !filterParams.f2_enabled,
            onChange: (v) => setFilterParams("f2_threshold_vlight", Math.round(v)),
          })}
          {num({
            label: "light threshold",
            value: filterParams.f2_threshold_light,
            step: 1,
            min: 0,
            disabled: !filterParams.f2_enabled,
            onChange: (v) => setFilterParams("f2_threshold_light", Math.round(v)),
          })}
          {num({
            label: "heavy threshold",
            value: filterParams.f2_threshold_heavy,
            step: 1,
            min: 0,
            disabled: !filterParams.f2_enabled,
            onChange: (v) => setFilterParams("f2_threshold_heavy", Math.round(v)),
          })}
          {num({
            label: "vlight boundary",
            unit: "Da",
            value: filterParams.f2_vlight_boundary_da,
            step: 1000,
            min: 0,
            disabled: !filterParams.f2_enabled,
            onChange: (v) => setFilterParams("f2_vlight_boundary_da", v),
          })}
          {num({
            label: "light/heavy boundary",
            unit: "Da",
            value: filterParams.f2_light_heavy_boundary_da,
            step: 1000,
            min: 0,
            disabled: !filterParams.f2_enabled,
            onChange: (v) => setFilterParams("f2_light_heavy_boundary_da", v),
          })}
        </div>

        <div class="section">
          <h4>F4a / F4b — mobility coherence</h4>
          {check({
            label: "Enable F4a",
            checked: filterParams.f4a_enabled,
            onChange: (v) => setFilterParams("f4a_enabled", v),
          })}
          {check({
            label: "Enable F4b",
            checked: filterParams.f4b_enabled,
            onChange: (v) => setFilterParams("f4b_enabled", v),
          })}
          {num({
            label: "ratio (strict)",
            value: filterParams.f4a_ratio_strict,
            step: 0.5,
            min: 0,
            disabled: !filterParams.f4a_enabled,
            onChange: (v) => setFilterParams("f4a_ratio_strict", v),
          })}
          {num({
            label: "offset low",
            unit: "Da",
            value: filterParams.f4a_offset_low_da,
            step: 100,
            min: 0,
            disabled: !filterParams.f4a_enabled,
            onChange: (v) => setFilterParams("f4a_offset_low_da", v),
          })}
          {num({
            label: "offset high",
            unit: "Da",
            value: filterParams.f4a_offset_high_da,
            step: 100,
            min: 0,
            disabled: !filterParams.f4a_enabled,
            onChange: (v) => setFilterParams("f4a_offset_high_da", v),
          })}
        </div>

        <div class="section">
          <button
            onClick={() => {
              resetFilterParams();
              triggerFilterPipeline();
            }}
          >
            Reset filter defaults
          </button>
        </div>

        <PeakDetail />
      </div>
    </aside>
  );
}
