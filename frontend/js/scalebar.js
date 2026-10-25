// Scale-bar lengths, shared by the 3D view (viewers/volume.html) and the slice panes
// (slice/slice-views.js). Pure: no DOM. The voxel spacing in volume.json is taken to be
// micrometres, so every length here is in micrometres.

const UNITS = [["nm", 1e-3], ["\u00b5m", 1], ["mm", 1e3], ["cm", 1e4], ["m", 1e6]]; // [label, micrometres]

/** The longest "nice" length (1, 2 or 5 x 10^n) that is at most `maxUm`, as { um, text }; null for a bad input. */
export function niceScaleLength(maxUm) {
  if (!(maxUm > 0) || !Number.isFinite(maxUm)) return null;
  const pow = Math.pow(10, Math.floor(Math.log10(maxUm)));
  const um = [5, 2, 1].map((m) => m * pow).find((v) => v <= maxUm) ?? pow;
  let unit = UNITS[0];
  for (const u of UNITS) if (um >= u[1] * 0.999) unit = u;
  return { um, text: `${Number((um / unit[1]).toPrecision(3))} ${unit[0]}` };
}
