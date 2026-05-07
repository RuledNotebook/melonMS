import type { JSX } from "solid-js";
import {
  deconvParams,
  resetDeconvParams,
  setDeconvParams,
} from "../state/store";
import type { PeakShape } from "../state/types";

/* Tier-1 UniDec-equivalent parameters, fully scaffolded.

   None of these are wired to compute in v0 — they live in the store so v1
   only has to forward them to the Python sidecar's `deconvolve` command. */

function NumRow(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
  unit?: string;
}): JSX.Element {
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
        onInput={(e) => {
          const v = parseFloat(e.currentTarget.value);
          if (!Number.isNaN(v)) props.onChange(v);
        }}
      />
    </div>
  );
}

function RangeRow(props: {
  label: string;
  low: number;
  high: number;
  onLow: (v: number) => void;
  onHigh: (v: number) => void;
  step?: number;
  unit?: string;
}): JSX.Element {
  return (
    <div class="row range">
      <label>{props.label}{props.unit ? <span style={{ color: "var(--text-2)" }}> ({props.unit})</span> : null}</label>
      <input
        type="number"
        value={props.low}
        step={props.step ?? "any"}
        onInput={(e) => {
          const v = parseFloat(e.currentTarget.value);
          if (!Number.isNaN(v)) props.onLow(v);
        }}
      />
      <input
        type="number"
        value={props.high}
        step={props.step ?? "any"}
        onInput={(e) => {
          const v = parseFloat(e.currentTarget.value);
          if (!Number.isNaN(v)) props.onHigh(v);
        }}
      />
    </div>
  );
}

export function ParameterPane() {
  return (
    <aside class="pane">
      <div class="pane__header">Deconvolution parameters</div>
      <div class="pane__body">
        <div class="section">
          <h4>m/z window</h4>
          <RangeRow
            label="m/z range"
            unit="Th"
            low={deconvParams.mz_min}
            high={deconvParams.mz_max}
            onLow={(v) => setDeconvParams("mz_min", v)}
            onHigh={(v) => setDeconvParams("mz_max", v)}
            step={10}
          />
        </div>

        <div class="section">
          <h4>Charge state</h4>
          <RangeRow
            label="charge range"
            low={deconvParams.charge_low}
            high={deconvParams.charge_high}
            onLow={(v) => setDeconvParams("charge_low", v)}
            onHigh={(v) => setDeconvParams("charge_high", v)}
            step={1}
          />
        </div>

        <div class="section">
          <h4>Mass grid</h4>
          <RangeRow
            label="mass range"
            unit="Da"
            low={deconvParams.mass_low}
            high={deconvParams.mass_high}
            onLow={(v) => setDeconvParams("mass_low", v)}
            onHigh={(v) => setDeconvParams("mass_high", v)}
            step={1000}
          />
          <NumRow
            label="mass bin size"
            unit="Da"
            value={deconvParams.mass_bin}
            step={0.1}
            min={0.05}
            onChange={(v) => setDeconvParams("mass_bin", v)}
          />
        </div>

        <div class="section">
          <h4>Peak model</h4>
          <NumRow
            label="peak FWHM"
            unit="m/z"
            value={deconvParams.peak_fwhm}
            step={0.05}
            min={0.01}
            onChange={(v) => setDeconvParams("peak_fwhm", v)}
          />
          <div class="row">
            <label>peak shape</label>
            <select
              value={deconvParams.peak_shape}
              onChange={(e) => setDeconvParams("peak_shape", e.currentTarget.value as PeakShape)}
            >
              <option value="gaussian">gaussian</option>
              <option value="lorentzian">lorentzian</option>
              <option value="split_gl">split G/L</option>
            </select>
          </div>
        </div>

        <div class="section">
          <h4>Solver (RL EM)</h4>
          <NumRow
            label="iterations"
            value={deconvParams.iterations}
            step={10}
            min={1}
            onChange={(v) => setDeconvParams("iterations", Math.round(v))}
          />
          <NumRow
            label="convergence"
            value={deconvParams.convergence}
            step={1e-5}
            min={0}
            onChange={(v) => setDeconvParams("convergence", v)}
          />
        </div>

        <div class="section">
          <h4>Smoothing priors</h4>
          <NumRow
            label="β charge"
            value={deconvParams.beta_charge}
            step={0.1}
            min={0}
            hint="Charge-axis smoothness prior"
            onChange={(v) => setDeconvParams("beta_charge", v)}
          />
          <NumRow
            label="β mass"
            value={deconvParams.beta_mass}
            step={0.1}
            min={0}
            hint="Mass-axis smoothness prior"
            onChange={(v) => setDeconvParams("beta_mass", v)}
          />
        </div>

        <div class="section">
          <h4>Preprocessing</h4>
          <div class="row">
            <label>background subtraction</label>
            <input
              type="checkbox"
              checked={deconvParams.background_subtraction}
              onChange={(e) => setDeconvParams("background_subtraction", e.currentTarget.checked)}
            />
          </div>
          <NumRow
            label="noise threshold"
            value={deconvParams.noise_threshold}
            step={1}
            min={0}
            onChange={(v) => setDeconvParams("noise_threshold", v)}
          />
        </div>

        <div class="section">
          <button onClick={resetDeconvParams}>Reset to defaults</button>
          <div class="note">
            Compute path is not wired in v0. Parameters are stored and ready
            for the v1 deconvolve command.
          </div>
        </div>
      </div>
    </aside>
  );
}
