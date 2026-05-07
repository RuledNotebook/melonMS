import { filterParams, setFilterParams } from "../state/store";

/* F1 / F2 / F4 post-hoc filters (stub).

   F1: charge-state coherence
   F2: isotope spacing
   F4: mobility (ghost) coherence
   See posthoc_filter.py in the validated pipeline for the canonical math. */

export function FilterPane() {
  return (
    <aside class="pane">
      <div class="pane__header">Mass output</div>
      <div class="pane__body">
        <div class="section">
          <h4>Mass-domain spectrum</h4>
          <div
            style={{
              border: "1px dashed var(--line)",
              padding: "20px",
              "border-radius": "4px",
              color: "var(--text-2)",
              "text-align": "center",
              "font-family": "var(--mono)",
              "font-size": "11px",
            }}
          >
            mass plot — wired in v1
          </div>
        </div>

        <div class="section">
          <h4>Post-hoc filters</h4>

          <div class="row">
            <label title="Charge-state coherence">F1 — charge coherence</label>
            <input
              type="checkbox"
              checked={filterParams.f1_enabled}
              onChange={(e) => setFilterParams("f1_enabled", e.currentTarget.checked)}
            />
          </div>
          <div class="row">
            <label>F1 threshold</label>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={filterParams.f1_threshold}
              disabled={!filterParams.f1_enabled}
              onInput={(e) => {
                const v = parseFloat(e.currentTarget.value);
                if (!Number.isNaN(v)) setFilterParams("f1_threshold", v);
              }}
            />
          </div>

          <div class="row">
            <label title="Isotope spacing coherence">F2 — isotope spacing</label>
            <input
              type="checkbox"
              checked={filterParams.f2_enabled}
              onChange={(e) => setFilterParams("f2_enabled", e.currentTarget.checked)}
            />
          </div>
          <div class="row">
            <label>F2 threshold</label>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={filterParams.f2_threshold}
              disabled={!filterParams.f2_enabled}
              onInput={(e) => {
                const v = parseFloat(e.currentTarget.value);
                if (!Number.isNaN(v)) setFilterParams("f2_threshold", v);
              }}
            />
          </div>

          <div class="row">
            <label title="Mobility (ghost) coherence">F4 — mobility coherence</label>
            <input
              type="checkbox"
              checked={filterParams.f4_enabled}
              onChange={(e) => setFilterParams("f4_enabled", e.currentTarget.checked)}
            />
          </div>
          <div class="row">
            <label>F4 threshold</label>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={filterParams.f4_threshold}
              disabled={!filterParams.f4_enabled}
              onInput={(e) => {
                const v = parseFloat(e.currentTarget.value);
                if (!Number.isNaN(v)) setFilterParams("f4_threshold", v);
              }}
            />
          </div>

          <div class="note">
            Filters reference the validated posthoc_filter.py F1/F2/F4 routines.
            Wired in v1 once the deconv pipeline produces candidate masses.
          </div>
        </div>

        <div class="section">
          <h4>Selected peak</h4>
          <div
            style={{
              border: "1px dashed var(--line)",
              padding: "20px",
              "border-radius": "4px",
              color: "var(--text-2)",
              "text-align": "center",
              "font-family": "var(--mono)",
              "font-size": "11px",
            }}
          >
            click a mass-domain peak to see detail (v1)
          </div>
        </div>
      </div>
    </aside>
  );
}
