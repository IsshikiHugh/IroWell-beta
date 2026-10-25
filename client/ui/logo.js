// The IroWell logo: four woven zigzag lines around a regular octagon (one colour, transparent gaps).
// logoSvg(fill, id) gives the SVG markup in that colour; id prefixes its mask ids (unique per copy on a page).
export const logoSvg = (fill, id = "logo") => `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="10.392 10.392 43.217 43.217">
  <defs>
  <mask id="${id}-0" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
  <rect width="64" height="64" fill="#fff"/>
  <clipPath id="${id}-k0">
  <circle cx="23.798" cy="23.798" r="12"/>
  </clipPath>
  <path clip-path="url(#${id}-k0)" d="M52.608 19.138L50.718 22.413L40.202 23.798L32 20.4L23.798 23.798L13.282 22.413L11.392 19.138L14.065 16.465L22.987 17.639L32 13.906L41.013 17.639L49.935 16.465Z" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="miter" stroke-miterlimit="10"/>
  </mask>
  <mask id="${id}-1" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
  <rect width="64" height="64" fill="#fff"/>
  <clipPath id="${id}-k1">
  <circle cx="40.202" cy="23.798" r="12"/>
  </clipPath>
  <path clip-path="url(#${id}-k1)" d="M44.862 52.608L41.587 50.718L40.202 40.202L43.6 32L40.202 23.798L41.587 13.282L44.862 11.392L47.535 14.065L46.361 22.987L50.094 32L46.361 41.013L47.535 49.935Z" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="miter" stroke-miterlimit="10"/>
  </mask>
  <mask id="${id}-2" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
  <rect width="64" height="64" fill="#fff"/>
  <clipPath id="${id}-k2">
  <circle cx="40.202" cy="40.202" r="12"/>
  </clipPath>
  <path clip-path="url(#${id}-k2)" d="M11.392 44.862L13.282 41.587L23.798 40.202L32 43.6L40.202 40.202L50.718 41.587L52.608 44.862L49.935 47.535L41.013 46.361L32 50.094L22.987 46.361L14.065 47.535Z" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="miter" stroke-miterlimit="10"/>
  </mask>
  <mask id="${id}-3" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
  <rect width="64" height="64" fill="#fff"/>
  <clipPath id="${id}-k3">
  <circle cx="23.798" cy="40.202" r="12"/>
  </clipPath>
  <path clip-path="url(#${id}-k3)" d="M19.138 11.392L22.413 13.282L23.798 23.798L20.4 32L23.798 40.202L22.413 50.718L19.138 52.608L16.465 49.935L17.639 41.013L13.906 32L17.639 22.987L16.465 14.065Z" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="miter" stroke-miterlimit="10"/>
  </mask>
  </defs>
  <path d="M19.138 11.392L22.413 13.282L23.798 23.798L20.4 32L23.798 40.202L22.413 50.718L19.138 52.608L16.465 49.935L17.639 41.013L13.906 32L17.639 22.987L16.465 14.065Z" fill="${fill}" mask="url(#${id}-0)"/>
  <path d="M52.608 19.138L50.718 22.413L40.202 23.798L32 20.4L23.798 23.798L13.282 22.413L11.392 19.138L14.065 16.465L22.987 17.639L32 13.906L41.013 17.639L49.935 16.465Z" fill="${fill}" mask="url(#${id}-1)"/>
  <path d="M44.862 52.608L41.587 50.718L40.202 40.202L43.6 32L40.202 23.798L41.587 13.282L44.862 11.392L47.535 14.065L46.361 22.987L50.094 32L46.361 41.013L47.535 49.935Z" fill="${fill}" mask="url(#${id}-2)"/>
  <path d="M11.392 44.862L13.282 41.587L23.798 40.202L32 43.6L40.202 40.202L50.718 41.587L52.608 44.862L49.935 47.535L41.013 46.361L32 50.094L22.987 46.361L14.065 47.535Z" fill="${fill}" mask="url(#${id}-3)"/>
  </svg>`;
// The same logo as numbers (ui/logo-motion.js animates it): LOGO_BARS, the four lines as polygons (left, top, right,
// bottom: each a quarter turn on from the one before) in a 64 x 64 box centred on (32, 32); the line lying over
// line i where they cross is line (i + 1) % 4, and it cuts LOGO_GAP clear round itself. LOGO_VIEWBOX: logoSvg's crop.
export const LOGO_BARS = [
  [[19.138, 11.392], [22.413, 13.282], [23.798, 23.798], [20.4, 32], [23.798, 40.202], [22.413, 50.718], [19.138, 52.608], [16.465, 49.935], [17.639, 41.013], [13.906, 32], [17.639, 22.987], [16.465, 14.065]],
  [[52.608, 19.138], [50.718, 22.413], [40.202, 23.798], [32, 20.4], [23.798, 23.798], [13.282, 22.413], [11.392, 19.138], [14.065, 16.465], [22.987, 17.639], [32, 13.906], [41.013, 17.639], [49.935, 16.465]],
  [[44.862, 52.608], [41.587, 50.718], [40.202, 40.202], [43.6, 32], [40.202, 23.798], [41.587, 13.282], [44.862, 11.392], [47.535, 14.065], [46.361, 22.987], [50.094, 32], [46.361, 41.013], [47.535, 49.935]],
  [[11.392, 44.862], [13.282, 41.587], [23.798, 40.202], [32, 43.6], [40.202, 40.202], [50.718, 41.587], [52.608, 44.862], [49.935, 47.535], [41.013, 46.361], [32, 50.094], [22.987, 46.361], [14.065, 47.535]],
];
export const LOGO_GAP = 1.6;
export const LOGO_VIEWBOX = '10.392 10.392 43.217 43.217';
