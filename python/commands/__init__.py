"""Command modules for the troponin-tdms-app sidecar.

Registered modules (sidecar.py imports each one after wiring sys.path):
  - load_spectrum    Profile-mode m/z spectrum from a single .d folder
  - deconvolve       Tier-1 charge deconvolution -> mass list
  - apply_filters    F1/F2/F4 post-hoc filters over a mass list
  - list_d_folders   Scan a parent dir for .d acquisitions (multi-sample picker)

Imports stay lazy here on purpose: load_spectrum/deconvolve depend on
`bruker_reader` from the troponin-experiments folder, which sidecar.py adds
to sys.path before importing commands. Eager imports here would break the
package for any caller that hasn't done that path setup.
"""
