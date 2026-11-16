// The brand marks. Each is the inner markup of a 64×64 SVG drawn with
// `currentColor`, so one definition serves the toolbar (inheriting the text color),
// the settings picker, and the window icon (rasterized with fixed colors).
//
// This file is plain data with no imports on purpose: `docs/logos/` is exported
// from it by a script that loads it directly.

export interface LogoDef {
  id: string;
  name: string;
  /** One line on the idea behind the mark, shown in the picker. */
  note: string;
  body: string;
}

const STROKE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

/// Mirrors left-side paths across the vertical axis so each spider is symmetric by
/// construction.
function mirrored(paths: string): string {
  return `${paths}<g transform="matrix(-1 0 0 1 64 0)">${paths}</g>`;
}

export const LOGOS: LogoDef[] = [
  {
    id: "weaver",
    name: "Weaver",
    note: "A spider seen from above — the plain, confident mark.",
    body:
      `<ellipse cx="32" cy="39" rx="8.5" ry="10.5" fill="currentColor"/>` +
      `<circle cx="32" cy="24.5" r="5.5" fill="currentColor"/>` +
      `<g ${STROKE} stroke-width="3">` +
      mirrored(
        `<path d="M28 22 20 15 17 5"/><path d="M27 26 14 22 7 13"/>` +
          `<path d="M27 30 13 33 6 43"/><path d="M28 34 19 44 16 57"/>`,
      ) +
      `</g>`,
  },
  {
    id: "thread",
    name: "Thread",
    note: "Hanging from a single thread — Ariadne's way out of the labyrinth.",
    body:
      `<path d="M32 3V25" ${STROKE} stroke-width="2.5"/>` +
      `<ellipse cx="32" cy="41" rx="8" ry="9.5" fill="currentColor"/>` +
      `<circle cx="32" cy="29" r="5" fill="currentColor"/>` +
      `<g ${STROKE} stroke-width="2.8">` +
      mirrored(
        `<path d="M28 27 21 21 20 13"/><path d="M27 31 17 29 12 22"/>` +
          `<path d="M26 37 15 39 10 47"/><path d="M27 43 19 50 18 59"/>`,
      ) +
      `</g>`,
  },
  {
    id: "orb",
    name: "Orb web",
    note: "The web itself: spokes and rings around a still center.",
    body:
      `<g ${STROKE} stroke-width="2.2">` +
      `<path d="M32 4V60M4 32H60M12.2 12.2 51.8 51.8M51.8 12.2 12.2 51.8"/>` +
      `<path d="M32 20 40.5 23.5 44 32 40.5 40.5 32 44 23.5 40.5 20 32 23.5 23.5Z"/>` +
      `<path d="M32 9 48.3 15.7 55 32 48.3 48.3 32 55 15.7 48.3 9 32 15.7 15.7Z"/>` +
      `</g>` +
      `<circle cx="32" cy="32" r="5" fill="currentColor"/>`,
  },
  {
    id: "monogram",
    name: "Monogram",
    note: "The letter A, with a spider on its thread where the crossbar was.",
    body:
      `<g ${STROKE}>` +
      `<path d="M11 57 32 7 53 57" stroke-width="5"/>` +
      `<path d="M32 9V32" stroke-width="2.2"/>` +
      `<g stroke-width="2.6">` +
      mirrored(`<path d="M28 37 21.5 33"/><path d="M27.5 42 19 44"/>`) +
      `</g></g>` +
      `<circle cx="32" cy="39" r="6.5" fill="currentColor"/>`,
  },
  {
    id: "facet",
    name: "Facet",
    note: "Hard angles and a diamond body — the geometric take.",
    body:
      `<path d="M32 19 41 33 32 49 23 33Z" fill="currentColor"/>` +
      `<g ${STROKE} stroke-width="3" stroke-linejoin="miter" stroke-linecap="square">` +
      mirrored(
        `<path d="M27 27 18 21V8"/><path d="M24 32H11L6 22"/>` +
          `<path d="M25 36 12 40 7 51"/><path d="M28 42 20 49V59"/>`,
      ) +
      `</g>`,
  },
  {
    id: "datum",
    name: "Datum",
    note: "A spider whose abdomen is a database cylinder.",
    body:
      `<g ${STROKE} stroke-width="2.8">` +
      `<ellipse cx="32" cy="31" rx="10" ry="4"/>` +
      `<path d="M22 31V46C22 48.2 26.5 50 32 50S42 48.2 42 46V31"/>` +
      `<path d="M22 38.5C22 40.7 26.5 42.5 32 42.5S42 40.7 42 38.5"/>` +
      mirrored(
        `<path d="M28.500 19 22 13 20 4"/><path d="M22 33 12 28 6 18"/>` +
          `<path d="M22 39 11 40 5 49"/><path d="M23 46 15 52 13 60"/>`,
      ) +
      `</g>` +
      `<circle cx="32" cy="21" r="5" fill="currentColor"/>`,
  },
  {
    id: "corner",
    name: "Corner web",
    note: "A web spun into a corner, the spider waiting at its edge.",
    body:
      `<g ${STROKE} stroke-width="2.2">` +
      `<path d="M6 6H58M6 6V58M6 6 54 26M6 6 26 54M6 6 44 44"/>` +
      `<path d="M26 6 24.500 13.700 20 20 13.700 24.500 6 26"/>` +
      `<path d="M44 6 40.500 20.400 31.500 31.500 20.400 40.500 6 44"/>` +
      `<path d="M44 44 49 49" stroke-width="2"/>` +
      `<g stroke-width="2">` +
      `<path d="M47.500 50.500 43 53"/><path d="M50.500 47.500 53 43"/>` +
      `<path d="M50 54 49 59"/><path d="M54 50 59 49"/>` +
      `</g></g>` +
      `<circle cx="51.500" cy="51.500" r="4.500" fill="currentColor"/>`,
  },
  {
    id: "labyrinth",
    name: "Labyrinth",
    note: "Rings of a maze with the thread leading to its center.",
    body:
      `<g ${STROKE} stroke-width="3">` +
      `<path d="M37 5.500A27 27 0 1 1 27 5.500"/>` +
      `<path d="M50.500 28A19 19 0 1 1 46 19"/>` +
      `<path d="M27 42A11 11 0 1 1 37 42"/>` +
      `<path d="M32 4V21" stroke-width="2.2"/>` +
      `</g>` +
      `<circle cx="32" cy="32" r="4.500" fill="currentColor"/>`,
  },
  {
    id: "graph",
    name: "Graph",
    note: "Eight legs ending in nodes — a schema drawn as a spider.",
    body:
      `<g ${STROKE} stroke-width="2.4">` +
      mirrored(
        `<path d="M32 32 15 12"/><path d="M32 32 8 26"/>` +
          `<path d="M32 32 9 43"/><path d="M32 32 19 55"/>`,
      ) +
      `</g>` +
      `<g fill="currentColor">` +
      mirrored(
        `<circle cx="15" cy="12" r="3.600"/><circle cx="8" cy="26" r="3.600"/>` +
          `<circle cx="9" cy="43" r="3.600"/><circle cx="19" cy="55" r="3.600"/>`,
      ) +
      `<circle cx="32" cy="32" r="8"/>` +
      `</g>`,
  },
  {
    id: "widow",
    name: "Widow",
    note: "Heavy, curved legs and an hourglass cut into the abdomen.",
    body:
      `<path fill="currentColor" fill-rule="evenodd" d="M32 28C39 28 43 34 43 41S39 54 32 54 21 48 21 41 25 28 32 28ZM28 35H36L33.500 41 36 47H28L30.500 41Z"/>` +
      `<circle cx="32" cy="22.500" r="5.500" fill="currentColor"/>` +
      `<g ${STROKE} stroke-width="3.400">` +
      mirrored(
        `<path d="M28 21Q20 17 19 6"/><path d="M27 25Q14 23 8 13"/>` +
          `<path d="M24 33Q11 32 6 43"/><path d="M23 41Q13 44 13 57"/>`,
      ) +
      `</g>`,
  },
  {
    id: "hex",
    name: "Hex",
    note: "A web reduced to a hexagon — closest to a classic app icon.",
    body:
      `<g ${STROKE} stroke-width="2.6">` +
      `<path d="M32 4 56.200 18V46L32 60 7.800 46V18Z"/>` +
      `<path d="M32 4V60M7.800 18 56.200 46M56.200 18 7.800 46"/>` +
      `<path d="M32 17 45 24.500V39.500L32 47 19 39.500V24.500Z"/>` +
      `</g>` +
      `<circle cx="32" cy="32" r="5" fill="currentColor"/>`,
  },
  {
    id: "minimal",
    name: "Minimal",
    note: "A dot and eight arcs — the quietest version.",
    body:
      `<circle cx="32" cy="32" r="7.500" fill="currentColor"/>` +
      `<g ${STROKE} stroke-width="3">` +
      mirrored(
        `<path d="M25 27Q15 24 14 10"/><path d="M24 31Q11 30 5 20"/>` +
          `<path d="M24 34Q11 35 5 45"/><path d="M25 38Q15 41 14 55"/>`,
      ) +
      `</g>`,
  },
];

export const DEFAULT_LOGO_ID = "weaver";

export function findLogo(id: string): LogoDef {
  return LOGOS.find((l) => l.id === id) ?? LOGOS[0];
}

/// A standalone SVG document of a mark. With `tile`, it is drawn on a rounded dark
/// square — the app-icon form; without, it is the bare glyph in `color`.
export function logoSvg(logo: LogoDef, opts: { color: string; tile?: string }): string {
  const tile = opts.tile
    ? `<rect width="64" height="64" rx="14" fill="${opts.tile}"/>`
    : "";
  // On a tile the glyph is inset so it doesn't touch the rounded corners.
  const glyph = opts.tile
    ? `<g transform="translate(9.600 9.600) scale(0.700)" color="${opts.color}">${logo.body}</g>`
    : `<g color="${opts.color}">${logo.body}</g>`;
  // Explicit width/height: without an intrinsic size a browser rasterizes an SVG
  // image at 300×150 and stretches it.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${tile}${glyph}</svg>`;
}
