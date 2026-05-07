/* Stub for the mass-domain output view. v1 wires the deconvolved mass
   spectrum here, alongside (or replacing) the m/z view. Kept as a separate
   component now so layouts can be swapped without touching SpectrumView. */
export function MassView() {
  return (
    <div class="spectrum">
      <div class="spectrum__header">
        <span class="spectrum__title">mass-domain output (v1)</span>
      </div>
      <div class="spectrum__plot">
        <div class="spectrum__empty">
          Run deconvolution to populate the mass-domain plot.
        </div>
      </div>
    </div>
  );
}
