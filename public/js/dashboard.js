import { h, table, fmtTime, fmtMs, colorFor, syncDataSet, flashEdge, FLOW_COLORS, GRAPH_OPTIONS, edgeKey, edgeFor } from './ui.js';

const $ = sel => document.querySelector(sel);
const nodes = new Map();

const gNodes = new vis.DataSet();
const gEdges = new vis.DataSet();
new vis.Network($('#graph'), { nodes: gNodes, edges: gEdges }, GRAPH_OPTIONS);

const map = L.map('map').setView([20, 0], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
const markers = L.layerGroup().addTo(map);

const socket = io();
socket.on('connect', () => {
  socket.emit('dashboard');
  $('#conn').textContent = 'live';
  $('#conn').className = 'pill on';
});
socket.on('disconnect', () => {
  $('#conn').textContent = 'disconnected';
  $('#conn').className = 'pill off';
});
socket.on('snapshot', list => {
  nodes.clear();
  for (const n of list) nodes.set(n.id, n);
  render();
});
socket.on('telemetry', t => {
  nodes.set(t.id, t);
  render();
  // Replay the batch of packet hops with their original relative timing.
  const base = t.flows[0]?.t ?? 0;
  for (const f of t.flows) setTimeout(() => flashEdge(gEdges, f.from, f.to, FLOW_COLORS[f.type]), Math.min(Math.max(f.t - base, 0), 2000));
});
socket.on('node-left', id => {
  nodes.delete(id);
  render();
});

let sosSig = '';
const REMOTE_TTL = 20000;
function render() {
  for (const [id, n] of nodes) if (n.via && Date.now() - n.updated > REMOTE_TTL) nodes.delete(id);
  const list = [...nodes.values()];
  const ids = new Set(list.map(n => n.id));
  const uplinks = new Set(list.filter(n => n.via).map(n => n.via));

  syncDataSet(gNodes, list.map(n => ({
    id: n.id,
    label: uplinks.has(n.id) ? `${n.name} (uplink)` : n.name,
    color: { background: colorFor(n.id), border: n.via ? '#94a3b8' : uplinks.has(n.id) ? '#22d3ee' : '#1e293b' },
    borderWidth: uplinks.has(n.id) ? 4 : 2,
    shapeProperties: { borderDashes: n.via ? [4, 4] : false },
  })));
  const edges = new Map();
  for (const n of list) {
    for (const nb of n.neighbors ?? []) {
      const key = edgeKey(n.id, nb.id);
      if (!ids.has(nb.id) || edges.has(key)) continue;
      edges.set(key, edgeFor(n.id, nb.id, nb.transport, nb.rtt));
    }
  }
  syncDataSet(gEdges, [...edges.values()]);

  const sum = k => list.reduce((a, n) => a + (n.stats?.[k] ?? 0), 0);
  const mean = k => {
    const v = list.map(n => n.stats?.[k]).filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const byTransport = t => [...edges.values()].filter(e => e.transport === t).length;
  const cards = [
    ['Nodes', list.length],
    ['Offline nodes (via uplink)', list.filter(n => n.via).length],
    ['Internet uplinks', uplinks.size],
    ['Links', edges.size],
    ['Bluetooth links', byTransport('ble')],
    ['WebRTC links', byTransport('rtc') + byTransport('relay')],
    ['Messages originated', sum('originated')],
    ['Deliveries', sum('delivered')],
    ['Relay operations', sum('relayed')],
    ['Duplicates suppressed', sum('duplicates')],
    ['Store & forward replays', sum('replayed')],
    ['Avg delivery RTT', fmtMs(mean('avgRtt'))],
    ['Avg hops', mean('avgHops')?.toFixed(2) ?? '-'],
  ];
  $('#stats').replaceChildren(...cards.map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, v), h('div', { class: 'stat-k' }, k))));

  const rows = list
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(n => h('tr', {},
      h('td', {}, h('span', { class: 'dot on', style: `background:${colorFor(n.id)}` }), ' ', n.name),
      h('td', {}, h('code', {}, n.id.slice(0, 8))),
      h('td', {}, n.via ? `via ${nodes.get(n.via)?.name ?? 'uplink'} (mesh)` : uplinks.has(n.id) ? 'internet (uplink)' : 'direct'),
      h('td', {}, n.neighbors?.length ?? 0),
      h('td', {}, n.stats?.originated ?? 0),
      h('td', {}, n.stats?.delivered ?? 0),
      h('td', {}, n.stats?.relayed ?? 0),
      h('td', {}, n.stats?.duplicates ?? 0),
      h('td', {}, fmtMs(n.stats?.avgRtt)),
      h('td', {}, n.updated ? `${Math.round((Date.now() - n.updated) / 1000)}s ago` : '-')));
  $('#table').replaceChildren(table(['Node', 'Id', 'Connection', 'Links', 'Sent', 'Recv', 'Relayed', 'Dups', 'Avg RTT', 'Last report'], rows, 'No nodes connected. Open /app.html in a few tabs or on your phone.'));

  const sos = list.filter(n => n.sos);
  const sig = JSON.stringify(sos.map(n => [n.id, n.sos.ts]));
  if (sig !== sosSig) {
    sosSig = sig;
    markers.clearLayers();
    for (const n of sos) {
      L.circleMarker([n.sos.lat, n.sos.lng], { radius: 11, color: '#ef4444', fillOpacity: 0.8 })
        .bindPopup(h('div', {}, h('strong', {}, `SOS · ${n.name}`), h('br'), n.sos.note || 'No details', h('br'), h('small', {}, fmtTime(n.sos.ts))))
        .addTo(markers);
    }
    if (sos.length) map.fitBounds(L.latLngBounds(sos.map(n => [n.sos.lat, n.sos.lng])).pad(0.4), { maxZoom: 15 });
    $('#sos-list').replaceChildren(
      ...sos.map(n => h('div', { class: 'sos-item' }, h('strong', {}, n.name), ` · ${fmtTime(n.sos.ts)} · ${n.sos.note || 'needs help'}`))
    );
  }
}

setInterval(render, 2000);
