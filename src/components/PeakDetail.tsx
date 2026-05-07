/* Per-peak detail panel stub. v1 will show:
     - charge-envelope fit overlay
     - F1/F2/F4 scores and decision
     - proposed proteoform candidates from propose_proteoforms.py */
export function PeakDetail() {
  return (
    <div class="section">
      <h4>Peak detail</h4>
      <div class="note">
        Select a deconvolved peak to see the charge envelope and F-score
        breakdown (v1).
      </div>
    </div>
  );
}
