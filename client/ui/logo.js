// The IroWell logo: four woven zigzag lines around a regular octagon (one colour, transparent gaps).
// logoSvg(fill) gives the SVG markup in that colour; the tab icon uses it in the page's accent colour.
export const logoSvg = (fill) => `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="10.392 10.392 43.217 43.217">
  <defs>
  <mask id="m0" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
  <rect width="64" height="64" fill="#fff"/>
  <clipPath id="k0">
  <circle cx="23.798" cy="23.798" r="12"/>
  </clipPath>
  <path clip-path="url(#k0)" d="M52.608 19.138L50.718 22.413L40.202 23.798L32 20.4L23.798 23.798L13.282 22.413L11.392 19.138L14.065 16.465L22.987 17.639L32 13.906L41.013 17.639L49.935 16.465Z" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="miter" stroke-miterlimit="10"/>
  </mask>
  <mask id="m1" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
  <rect width="64" height="64" fill="#fff"/>
  <clipPath id="k1">
  <circle cx="40.202" cy="23.798" r="12"/>
  </clipPath>
  <path clip-path="url(#k1)" d="M44.862 52.608L41.587 50.718L40.202 40.202L43.6 32L40.202 23.798L41.587 13.282L44.862 11.392L47.535 14.065L46.361 22.987L50.094 32L46.361 41.013L47.535 49.935Z" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="miter" stroke-miterlimit="10"/>
  </mask>
  <mask id="m2" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
  <rect width="64" height="64" fill="#fff"/>
  <clipPath id="k2">
  <circle cx="40.202" cy="40.202" r="12"/>
  </clipPath>
  <path clip-path="url(#k2)" d="M11.392 44.862L13.282 41.587L23.798 40.202L32 43.6L40.202 40.202L50.718 41.587L52.608 44.862L49.935 47.535L41.013 46.361L32 50.094L22.987 46.361L14.065 47.535Z" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="miter" stroke-miterlimit="10"/>
  </mask>
  <mask id="m3" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
  <rect width="64" height="64" fill="#fff"/>
  <clipPath id="k3">
  <circle cx="23.798" cy="40.202" r="12"/>
  </clipPath>
  <path clip-path="url(#k3)" d="M19.138 11.392L22.413 13.282L23.798 23.798L20.4 32L23.798 40.202L22.413 50.718L19.138 52.608L16.465 49.935L17.639 41.013L13.906 32L17.639 22.987L16.465 14.065Z" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="miter" stroke-miterlimit="10"/>
  </mask>
  </defs>
  <path d="M19.138 11.392L22.413 13.282L23.798 23.798L20.4 32L23.798 40.202L22.413 50.718L19.138 52.608L16.465 49.935L17.639 41.013L13.906 32L17.639 22.987L16.465 14.065Z" fill="${fill}" mask="url(#m0)"/>
  <path d="M52.608 19.138L50.718 22.413L40.202 23.798L32 20.4L23.798 23.798L13.282 22.413L11.392 19.138L14.065 16.465L22.987 17.639L32 13.906L41.013 17.639L49.935 16.465Z" fill="${fill}" mask="url(#m1)"/>
  <path d="M44.862 52.608L41.587 50.718L40.202 40.202L43.6 32L40.202 23.798L41.587 13.282L44.862 11.392L47.535 14.065L46.361 22.987L50.094 32L46.361 41.013L47.535 49.935Z" fill="${fill}" mask="url(#m2)"/>
  <path d="M11.392 44.862L13.282 41.587L23.798 40.202L32 43.6L40.202 40.202L50.718 41.587L52.608 44.862L49.935 47.535L41.013 46.361L32 50.094L22.987 46.361L14.065 47.535Z" fill="${fill}" mask="url(#m3)"/>
  </svg>`;
