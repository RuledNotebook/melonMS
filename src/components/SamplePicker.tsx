import { For, Show } from "solid-js";
import type { Sample } from "../state/types";

/* Inline picker shown when the user drops/picks a parent folder containing
   multiple Bruker `.d` acquisitions. Rows are clickable for valid samples
   (those with both analysis.tdf and analysis.tdf_bin). Invalid rows are
   greyed out so the operator can see they exist but are not loadable as
   timsTOF (typically older .baf-only acquisitions in the same folder). */

export interface SamplePickerProps {
  parent: string;
  samples: Sample[];
  onSelect: (sample: Sample) => void;
  onCancel: () => void;
}

/* Truncate long sample names from the middle so the start (sample id) and
   end (the .d suffix) remain visible. Keeps the row aligned. */
function truncateMiddle(text: string, head: number = 28, tail: number = 16): string {
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 10) return `${mb.toFixed(0)} MB`;
  return `${mb.toFixed(1)} MB`;
}

export function SamplePicker(props: SamplePickerProps) {
  const validCount = () => props.samples.filter((s) => s.valid).length;
  const totalCount = () => props.samples.length;

  return (
    <div class="sample-picker">
      <div class="sample-picker__header">
        <div class="sample-picker__parent" title={props.parent}>
          {props.parent}
        </div>
        <div class="sample-picker__count">
          {validCount()} loadable / {totalCount()} `.d`
        </div>
        <button onClick={props.onCancel} class="sample-picker__cancel">
          Cancel
        </button>
      </div>

      <Show
        when={totalCount() > 0}
        fallback={
          <div class="sample-picker__empty">
            No `.d` folders found in this directory.
          </div>
        }
      >
        <div class="sample-picker__list">
          <For each={props.samples}>
            {(sample) => (
              <div
                class="sample-picker__row"
                classList={{ "is-invalid": !sample.valid }}
                title={sample.path}
              >
                <div class="sample-picker__name">
                  {truncateMiddle(sample.name)}
                </div>
                <div class="sample-picker__size">
                  {formatSize(sample.size_mb)}
                </div>
                <div class="sample-picker__action">
                  <Show
                    when={sample.valid}
                    fallback={<span class="sample-picker__badge">no .tdf_bin</span>}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSelect(sample);
                      }}
                    >
                      Load
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
