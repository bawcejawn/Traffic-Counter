// Tiny SVG "visit counter" badges, in the style of shields.io.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Rough Verdana 11px advance widths – good enough for badge layout.
function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    if ('il.,:;|!\'`'.includes(ch)) w += 3.2;
    else if ('ftjrI() []'.includes(ch)) w += 4.3;
    else if ('mwMW'.includes(ch)) w += 9.6;
    else if (/[A-Z0-9]/.test(ch)) w += 7.4;
    else w += 6.4;
  }
  return Math.ceil(w);
}

export function formatCount(n, compact) {
  n = Number(n) || 0;
  if (!compact || n < 10000) return n.toLocaleString('en-US');
  const units = [['B', 1e9], ['M', 1e6], ['k', 1e3]];
  for (const [u, v] of units) if (n >= v) return (n / v).toFixed(n / v < 100 ? 1 : 0).replace(/\.0$/, '') + u;
  return String(n);
}

const COLORS = {
  green: '#2ea44f', blue: '#0969da', orange: '#d97706', red: '#cf222e',
  purple: '#8250df', gray: '#57606a', black: '#24292f', teal: '#0f766e',
};

export function badgeSvg({ label = 'visits', value = '0', color = 'teal', labelColor = '#555', style = 'flat' } = {}) {
  label = String(label).slice(0, 40);
  value = String(value).slice(0, 20);
  const c = COLORS[color] || (/^#?[0-9a-f]{3,8}$/i.test(color) ? (color.startsWith('#') ? color : '#' + color) : COLORS.teal);
  const lc = /^#?[0-9a-f]{3,8}$/i.test(labelColor) ? (labelColor.startsWith('#') ? labelColor : '#' + labelColor) : '#555';
  const pad = 6;
  const lw = label ? textWidth(label) + pad * 2 : 0;
  const vw = textWidth(value) + pad * 2;
  const w = lw + vw;
  const r = style === 'square' ? 0 : 3;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="${r}" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="${esc(lc)}"/><rect x="${lw}" width="${vw}" height="20" fill="${esc(c)}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
${label ? `<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text><text x="${lw / 2}" y="14">${esc(label)}</text>` : ''}
<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(value)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text>
</g></svg>`;
}
