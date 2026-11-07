import { node } from './client.js';

const paths = {
  grid: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  calendar: ['M8 2v4m8-4v4M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M7 14h2m6 0h2m-10 4h2'],
  check: ['m8 12 3 3 5-6', 'M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4M14 3h7v7'],
  cap: ['m2 9 10-6 10 6-10 6L2 9z', 'M6 12v6c4 3 8 3 12 0v-6m4-3v8'],
  sparkles: ['m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z', 'M21 2v4m-2-2h4'],
  arrow: ['M5 12h14m-6-6 6 6-6 6'],
  chevron: ['m9 5 7 7-7 7'],
  refresh: ['M20 7v5h-5M4 17v-5h5', 'M6 6a8 8 0 0 1 13 2l1 4M4 12l1 4a8 8 0 0 0 13 2'],
  plus: ['M12 5v14M5 12h14'],
  search: ['M21 21l-5-5', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0z'],
  sun: ['M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5', 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z'],
  moon: ['M21 13A9 9 0 0 1 11 3 9 9 0 1 0 21 13z'],
  clock: ['M12 8v5l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'],
  pin: ['M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z', 'M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
  alert: ['m12 3 10 18H2L12 3z', 'M12 9v5m0 3v1'],
  leaf: ['M20 3c-1 5 3 11-3 15-5 4-12 0-12-5C5 7 13 5 20 3z', 'M4 21 15 10'],
  terminal: ['m5 7 5 5-5 5m8 0h6', 'M3 3h18v18H3z'],
  arrowUp: ['M7 17 17 7M7 7h10v10'],
  filter: ['M4 6h16M7 12h10m-7 6h4'],
  book: ['M12 5v16M12 5C8 2 4 3 2 4v15c4-2 7-1 10 2 3-3 6-4 10-2V4c-2-1-6-2-10 1z'],
  lock: ['M7 10V7a5 5 0 0 1 10 0v3', 'M5 10h14v11H5z', 'M12 14v3'],
  close: ['m6 6 12 12M6 18 18 6'],
  copy: ['M9 9h12v12H9z', 'M15 5V3H3v12h2'],
};
export function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `icon ${className}` })) svg.setAttribute(key, value);
  for (const d of paths[name] ?? paths.book) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
export function badge(text, tone = 'neutral') { return node('span', text, `badge badge-${tone}`); }
export function emptyState(title, description = '', name = 'leaf') {
  const empty = node('div', '', 'empty-state');
  const mark = node('span', '', 'empty-mark');
  mark.append(icon(name));
  empty.append(mark, node('strong', title));
  if (description) empty.append(node('p', description));
  return empty;
}
export function minutesLabel(value) {
  if (!value) return '0m';
  const hours = Math.floor(value / 60), minutes = value % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : ''].filter(Boolean).join(' ');
}
export function colorFor(value = '') {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ['iris', 'mint', 'peach', 'blue'][hash % 4];
}
export function notify(message) {
  const area = document.getElementById('toast');
  area.textContent = message;
  area.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { area.hidden = true; }, 4500);
}
export function decorateIcons(root = document) {
  for (const slot of root.querySelectorAll('[data-icon]')) slot.replaceChildren(icon(slot.dataset.icon));
}
