const paths = {
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  sync: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  bell: '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zm5 4h4M12 2v2"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-1-10 6 6 0 0 1 11-1 5.5 5.5 0 0 1 0 11Z"/>',
  device:
    '<rect x="4" y="4" width="16" height="13" rx="1"/><path d="M1 20h22l-3-3H4Z"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 10c0 4 16 4 16 0M4 15c0 4 16 4 16 0"/>',
  file: '<path d="M6 2h8l5 5v15H6zm8 0v6h5M9 12h7m-7 4h7m-7 3h4"/>',
  network:
    '<circle cx="5" cy="5" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="12" cy="19" r="3"/><path d="m7 7 4 9m6-9-4 9M8 5h8"/>',
  connect:
    '<circle cx="5" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8 10 7-4M8 14l7 4"/>',
  shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Zm-5 9 3 3 7-7"/>',
  github:
    '<path d="M9 21c-5 1-5-3-7-3m14 6v-4a4 4 0 0 0-1-3c4 0 7-2 7-6a6 6 0 0 0-2-4 6 6 0 0 0 0-4s-2-1-5 2a16 16 0 0 0-6 0C6 2 4 3 4 3a6 6 0 0 0 0 4 6 6 0 0 0-2 4c0 4 3 6 7 6a4 4 0 0 0-1 3v4" transform="translate(0 -2) scale(.95)"/>',
  google: '<path d="M20 7a9 9 0 1 0 1 9v-5h-9v4h5a5 5 0 1 1-1-8"/>',
  menu: '<path d="M3 5h18M3 12h18M3 19h18"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>',
  play: '<circle cx="12" cy="12" r="10"/><path d="m10 7 7 5-7 5Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/>',
};
export const icon = (name, small = false) =>
  '<svg class="icon' +
  (small ? " small" : "") +
  '" viewBox="0 0 24 24" aria-hidden="true">' +
  (paths[name] || paths.file) +
  "</svg>";
export const wave = (count = 45) =>
  '<div class="wave" aria-hidden="true">' + "<i></i>".repeat(count) + "</div>";
