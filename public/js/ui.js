// Small DOM helpers. All dynamic text goes through textContent (never innerHTML) to avoid XSS from mesh data.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function table(headers, rows, emptyText) {
  if (!rows.length) return h('p', { class: 'hint' }, emptyText);
  return h('table', {}, h('thead', {}, h('tr', {}, headers.map(x => h('th', {}, x)))), h('tbody', {}, rows));
}

export const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtMs = v => (v == null ? '-' : `${Math.round(v)} ms`);

const PALETTE = ['#f472b6', '#facc15', '#4ade80', '#60a5fa', '#c084fc', '#fb923c', '#2dd4bf', '#f87171', '#a3e635', '#818cf8'];
export function colorFor(id) {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export const FLOW_COLORS = { chat: '#22d3ee', dm: '#a78bfa', sos: '#ef4444', ack: '#4ade80' };
const EDGE_COLOR = '#475569';
export const edgeKey = (a, b) => [a, b].sort().join('|');

export const TRANSPORT_LABEL = { rtc: 'WebRTC (direct)', relay: 'Server relay', ble: 'Bluetooth (Nearby)' };

export function edgeFor(a, b, transport, rtt) {
  const prefix = transport === 'ble' ? 'BT ' : '';
  return { id: edgeKey(a, b), from: a, to: b, transport, dashes: transport === 'relay', label: rtt != null ? `${prefix}${rtt} ms` : prefix.trim() };
}

export function syncDataSet(ds, items) {
  const keep = new Set(items.map(i => i.id));
  ds.remove(ds.getIds().filter(x => !keep.has(x)));
  ds.update(items);
}

const flashTimers = new Map();
export function flashEdge(ds, a, b, color = FLOW_COLORS.chat) {
  const key = edgeKey(a, b);
  if (!ds.get(key)) return;
  ds.update({ id: key, color: { color }, width: 6 });
  clearTimeout(flashTimers.get(key));
  flashTimers.set(key, setTimeout(() => ds.get(key) && ds.update({ id: key, color: { color: EDGE_COLOR }, width: 2 }), 600));
}

export const GRAPH_OPTIONS = {
  physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { springLength: 120 }, stabilization: false },
  nodes: { shape: 'dot', size: 18, borderWidth: 2, font: { color: '#e2e8f0', size: 14, strokeWidth: 3, strokeColor: '#0b1020' } },
  edges: { color: { color: EDGE_COLOR }, width: 2, smooth: false, font: { color: '#94a3b8', size: 11, strokeWidth: 0, align: 'top' } },
  interaction: { hover: true },
};

export function toast(text, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) document.body.append((box = h('div', { id: 'toasts', class: 'toasts' })));
  const t = h('div', { class: `toast ${kind}` }, text);
  box.append(t);
  setTimeout(() => t.remove(), 4500);
}
