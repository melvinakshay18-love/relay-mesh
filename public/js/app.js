import { MeshNode, uid } from './mesh.js';
import { Store } from './store.js';
import { loadIdentity, fingerprint, cryptoAvailable } from './crypto.js';
import { h, table, fmtTime, fmtMs, colorFor, toast, syncDataSet, flashEdge, FLOW_COLORS, GRAPH_OPTIONS, edgeKey, edgeFor, TRANSPORT_LABEL } from './ui.js';

const $ = sel => document.querySelector(sel);
const native = !!window.Capacitor?.isNativePlatform?.();

if (!cryptoAvailable()) {
  document.body.replaceChildren(
    h('div', { class: 'fatal' },
      h('h2', {}, 'Secure connection required'),
      h('p', {}, 'Encryption and GPS only work over HTTPS. Open the https:// address printed by the server and accept the certificate warning.'),
      h('code', {}, `https://${location.hostname}:3443/app.html`))
  );
  throw new Error('Insecure context');
}

// In the browser sessionStorage is per-tab, so every tab is an independent node; on Android the identity must survive restarts.
const idStore = native ? localStorage : sessionStorage;
const id = idStore.getItem('meshnet.id') ?? uid();
idStore.setItem('meshnet.id', id);
const name = idStore.getItem('meshnet.name') ?? (await askName());
idStore.setItem('meshnet.name', name);

const gatewayUrl = localStorage.getItem('meshnet.gateway') || null;
const store = await new Store(`meshnet-${id}`).open();
const identity = await loadIdentity(store);
const node = new MeshNode({
  id,
  name,
  identity,
  store,
  signalingUrl: native ? gatewayUrl : undefined,
  nearby: native ? window.Capacitor.registerPlugin('Nearby') : null,
});
const fpCache = new Map([[id, await fingerprint(identity.publicJwk)]]);

let channel = '*';
let messages = (await store.all('messages')).sort((a, b) => a.ts - b.ts);
const unread = new Map();
let map, markers, graph;

$('#me-name').textContent = name;
$('#me-fp').textContent = `key ${fpCache.get(id)}`;

function askName() {
  return new Promise(resolve => {
    const input = h('input', { maxlength: 24, required: true, value: `Node-${id.slice(0, 4)}` });
    const modal = h('div', { class: 'modal' },
      h('form', {
        class: 'modal-card',
        onsubmit: e => {
          e.preventDefault();
          const v = input.value.trim();
          if (!v) return;
          modal.remove();
          resolve(v.slice(0, 24));
        },
      },
      h('h2', {}, 'Join the mesh'),
      h('p', {}, 'Choose a name other nodes will see. Each browser tab is its own node.'),
      input,
      h('button', { type: 'submit' }, 'Join')));
    document.body.append(modal);
    input.focus();
    input.select();
  });
}

const nameOf = nid => (nid === id ? name : node.directory.get(nid)?.name ?? nid.slice(0, 6));
const activeTab = () => document.querySelector('.tabs button.active')?.dataset.tab;

// ------------------------------------------------------------------ tabs

document.querySelectorAll('.tabs button').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

function showTab(tab) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
  if (tab === 'chat') renderChat();
  if (tab === 'map') {
    initMap();
    setTimeout(() => map.invalidateSize(), 50);
  }
  if (tab === 'network') {
    initGraph();
    renderNetwork();
    setTimeout(() => graph.net.fit(), 100);
  }
}

// ------------------------------------------------------------------ chat

let channelSig = '';
function renderChannels(force = false) {
  const entries = [...node.directory.values()].sort((a, b) => a.name.localeCompare(b.name));
  const sig = JSON.stringify([channel, [...unread], entries.map(e => [e.id, e.name, node.isOnline(e)])]);
  if (!force && sig === channelSig) return;
  channelSig = sig;

  const chip = (cid, label, online) => {
    const n = unread.get(cid) || 0;
    return h('button', {
      class: `chip ${cid === channel ? 'active' : ''}`,
      onclick: () => {
        channel = cid;
        unread.delete(cid);
        renderChat();
      },
    }, h('span', { class: `dot ${online ? 'on' : ''}` }), label, n ? h('span', { class: 'badge' }, n) : null);
  };
  $('#channels').replaceChildren(chip('*', '# Broadcast', true), ...entries.map(e => chip(e.id, e.name, node.isOnline(e))));
}

function statusText(m) {
  if (m.status === 'queued') return 'queued (store & forward)';
  if (m.status === 'delivered') return `delivered in ${m.hopCount} hop${m.hopCount === 1 ? '' : 's'}, ${Math.round(m.rtt)} ms RTT`;
  return m.kind === 'dm' ? 'sent, awaiting ack' : 'sent';
}

function renderMsg(m) {
  const mine = m.dir === 'out';
  const hops = m.hops.length - 1;
  return h('div', { class: `msg ${mine ? 'out' : 'in'} ${m.failed ? 'failed' : ''}` },
    mine ? null : h('div', { class: 'msg-from', style: `color:${colorFor(m.from)}` }, m.fromName),
    h('div', { class: 'msg-text' }, m.text),
    h('div', { class: 'msg-meta' },
      fmtTime(m.ts),
      ' · ',
      mine ? statusText(m) : `${hops} hop${hops === 1 ? '' : 's'}`,
      m.e2e ? h('span', { class: 'tag' }, 'E2E') : null,
      m.keyWarning ? h('span', { class: 'tag warn' }, 'key changed') : null),
    m.hops.length > 1 ? h('div', { class: 'msg-route' }, `route: ${m.hops.map(nameOf).join(' → ')}`) : null);
}

function renderChat() {
  renderChannels(true);
  const info = $('#channel-info');
  if (channel === '*') {
    info.replaceChildren(h('strong', {}, 'Broadcast'), ' · flooded to every reachable node, not encrypted');
  } else {
    const e = node.directory.get(channel);
    info.replaceChildren(
      h('strong', {}, e?.name ?? channel),
      ` · end-to-end encrypted (ECDH P-256 + AES-256-GCM) · their key ${fpCache.get(channel) ?? '...'} · ${e && node.isOnline(e) ? 'online' : 'offline, messages will be carried'}`
    );
  }
  const list = messages.filter(m => (channel === '*' ? m.kind === 'chat' : m.kind === 'dm' && m.peer === channel)).slice(-200);
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.replaceChildren(
    ...(list.length
      ? list.map(renderMsg)
      : [h('p', { class: 'empty' }, channel === '*'
          ? 'No broadcasts yet. Say hi to the mesh.'
          : 'No messages yet. Messages to offline nodes are queued and carried hop-by-hop until they arrive.')])
  );
  if (atBottom) box.scrollTop = box.scrollHeight;
  $('#msg-input').placeholder = channel === '*' ? 'Broadcast to everyone...' : `Encrypted message to ${nameOf(channel)}...`;
}

$('#composer').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    if (channel === '*') await node.sendChat(text);
    else await node.sendDM(channel, text);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ------------------------------------------------------------------ SOS map

function initMap() {
  if (map) return;
  map = L.map('map').setView([20, 0], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  markers = L.layerGroup().addTo(map);
  renderSos(true);
}

function renderSos(fit = false) {
  if (!map) return;
  markers.clearLayers();
  const list = messages.filter(m => m.kind === 'sos');
  for (const m of list) {
    const popup = h('div', {},
      h('strong', {}, `SOS · ${m.fromName}`), h('br'),
      m.text || 'No details given', h('br'),
      h('small', {}, `${fmtTime(m.ts)} · ${m.hops.length - 1} hops${m.approx ? ' · approximate location' : ''}`));
    if (m.acc) L.circle([m.lat, m.lng], { radius: Math.min(m.acc, 5000), color: '#ef4444', weight: 1, fillOpacity: 0.08 }).addTo(markers);
    L.circleMarker([m.lat, m.lng], { radius: 10, color: m.dir === 'out' ? '#f59e0b' : '#ef4444', fillOpacity: 0.75 }).bindPopup(popup).addTo(markers);
  }
  if (fit && list.length) map.fitBounds(L.latLngBounds(list.map(m => [m.lat, m.lng])).pad(0.4), { maxZoom: 15 });
}

function locate() {
  return new Promise(resolve => {
    const fallback = () => {
      const c = map?.getCenter() ?? { lat: 20, lng: 0 };
      resolve({ lat: c.lat + (Math.random() - 0.5) * 0.02, lng: c.lng + (Math.random() - 0.5) * 0.02, acc: null, approx: true });
    };
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), approx: false }),
      fallback,
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  });
}

$('#sos-btn').addEventListener('click', async () => {
  const btn = $('#sos-btn');
  btn.disabled = true;
  btn.textContent = 'Locating...';
  try {
    const pos = await locate();
    await node.sendSOS({ ...pos, note: $('#sos-note').value.trim() });
    $('#sos-note').value = '';
    renderSos(true);
    toast(pos.approx ? 'SOS sent with approximate location (GPS unavailable)' : 'SOS broadcast to the mesh', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send SOS';
  }
});

// ------------------------------------------------------------------ network view

function initGraph() {
  if (graph) return;
  const nodes = new vis.DataSet();
  const edges = new vis.DataSet();
  graph = { nodes, edges, net: new vis.Network($('#graph'), { nodes, edges }, GRAPH_OPTIONS) };
}

function renderGraph() {
  const online = node.onlineNodes();
  const ids = new Set([id, ...online.map(e => e.id)]);
  syncDataSet(graph.nodes, [
    { id, label: `${name} (you)`, color: { background: '#22d3ee', border: '#0e7490' }, size: 22 },
    ...online.map(e => ({ id: e.id, label: e.name, color: { background: colorFor(e.id), border: '#1e293b' } })),
  ]);
  const edges = new Map();
  const add = (a, b, transport, rtt) => {
    const key = edgeKey(a, b);
    if (!ids.has(a) || !ids.has(b) || edges.has(key)) return;
    edges.set(key, edgeFor(a, b, transport, rtt));
  };
  for (const p of node.openPeers()) add(id, p.id, p.transport, p.rtt);
  for (const e of online) for (const n of e.neighbors) add(e.id, n.id, n.transport, n.rtt);
  syncDataSet(graph.edges, [...edges.values()]);
}

function renderNetwork() {
  const s = node.summary();
  const cards = [
    ['Direct links', s.peers],
    ['Nodes online', s.known + 1],
    ['Originated', s.originated],
    ['Delivered to me', s.delivered],
    ['Relayed for others', s.relayed],
    ['Duplicates dropped', s.duplicates],
    ['TTL expired', s.ttlExpired],
    ['Store & forward replays', s.replayed],
    ['Avg delivery RTT', fmtMs(s.avgRtt)],
    ['Avg hops', s.avgHops == null ? '-' : s.avgHops.toFixed(2)],
  ];
  $('#stats').replaceChildren(...cards.map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, v), h('div', { class: 'stat-k' }, k))));

  const peerRows = node.openPeers().map(p =>
    h('tr', {},
      h('td', {}, nameOf(p.id)),
      h('td', {}, TRANSPORT_LABEL[p.transport]),
      h('td', {}, fmtMs(p.rtt)),
      h('td', {}, h('button', { class: 'small danger', onclick: () => node.block(p.id) }, 'Cut link'))));
  const blockedRows = [...node.blocked].map(b =>
    h('tr', { class: 'muted' },
      h('td', {}, nameOf(b)), h('td', {}, 'cut'), h('td', {}, '-'),
      h('td', {}, h('button', { class: 'small', onclick: () => node.unblock(b) }, 'Restore'))));
  $('#peer-table').replaceChildren(table(['Node', 'Transport', 'RTT', ''], [...peerRows, ...blockedRows], 'No direct links yet. Open the app in another tab or on your phone.'));

  const nodeRows = [...node.directory.values()].map(e => {
    const online = node.isOnline(e);
    return h('tr', { class: online ? '' : 'muted' },
      h('td', {}, e.name),
      h('td', {}, online ? `${e.distance} hop${e.distance === 1 ? '' : 's'} away` : 'offline'),
      h('td', {}, h('code', {}, fpCache.get(e.id) ?? '...')));
  });
  $('#node-table').replaceChildren(table(['Node', 'Distance', 'Key fingerprint'], nodeRows, 'No other nodes discovered yet.'));

  if (graph) renderGraph();
}

// ------------------------------------------------------------------ header

function renderPills() {
  const sig = $('#pill-signal');
  const hasStation = !native || gatewayUrl;
  const label = native ? 'uplink' : 'base station';
  sig.textContent = `${label} ${node.signaling ? 'online' : 'offline'}`;
  sig.className = `pill ${node.signaling ? 'on' : 'off'} ${hasStation ? '' : 'hidden'}`;
  if (native) {
    const { state, error } = node.radio;
    const radio = $('#pill-radio');
    const nearby = node.endpoints.size;
    const label = { on: 'BT on', starting: 'BT starting', off: 'BT off', error: 'BT error' }[state] ?? state;
    radio.textContent = state === 'on' ? `${label} · ${node.blePeers.size} linked / ${nearby} nearby` : label;
    radio.className = `pill ${state === 'on' ? 'on' : 'off'}`;
    radio.title = error ?? '';
  }
  const n = node.openPeers().length;
  const peers = $('#pill-peers');
  peers.textContent = `${n} link${n === 1 ? '' : 's'}`;
  peers.className = `pill ${n ? 'on' : 'off'}`;
}

if (native) $('#airplane-label').textContent = 'No internet';
$('#airplane').addEventListener('change', e => {
  const off = e.target.checked;
  node.setOffline(off, { keepBluetooth: native });
  const msg = native
    ? off ? 'Internet links cut. Bluetooth mesh keeps running.' : 'Internet links restored'
    : off ? 'Offline: new messages will be queued and carried later' : 'Back online, syncing carried messages...';
  toast(msg, off ? 'error' : 'ok');
});

// ------------------------------------------------------------------ mesh events

node.addEventListener('message', ({ detail: m }) => {
  const i = messages.findIndex(x => x.id === m.id);
  if (i >= 0) messages[i] = m;
  else {
    messages.push(m);
    if (m.dir === 'in') {
      if (m.kind === 'sos') {
        toast(`SOS from ${m.fromName}: ${m.text || 'needs help'}`, 'error');
        navigator.vibrate?.([300, 100, 300]);
      } else {
        const cid = m.kind === 'dm' ? m.peer : '*';
        if (cid !== channel || activeTab() !== 'chat') {
          unread.set(cid, (unread.get(cid) || 0) + 1);
          toast(`${m.fromName}: ${m.text.slice(0, 80)}`);
        }
      }
    }
  }
  if (m.kind === 'sos') renderSos(m.dir === 'in');
  else if (activeTab() === 'chat') renderChat();
  else renderChannels();
});

node.addEventListener('directory', () => {
  for (const e of node.directory.values()) {
    if (!fpCache.has(e.id)) fingerprint(e.pub).then(fp => fpCache.set(e.id, fp));
  }
  renderChannels();
});

node.addEventListener('flow', ({ detail: f }) => {
  if (graph && activeTab() === 'network') flashEdge(graph.edges, f.from, f.to, FLOW_COLORS[f.type]);
});

node.addEventListener('peers', () => {
  renderPills();
  if (activeTab() === 'network') renderNetwork();
});
node.addEventListener('signaling', renderPills);
node.addEventListener('radio', ({ detail }) => {
  renderPills();
  if (detail.state === 'error') toast(`Bluetooth mesh failed: ${detail.error}`, 'error');
});
node.addEventListener('id-conflict', () => {
  idStore.removeItem('meshnet.id');
  location.reload();
});

if (native) {
  $('#gateway').classList.remove('hidden');
  $('#gateway-url').value = gatewayUrl ?? '';
  $('#gateway-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#gateway-url').value.trim();
    if (v && !/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(v)) return toast('Use a URL like http://192.168.1.20:3000', 'error');
    if (v) localStorage.setItem('meshnet.gateway', v.replace(/\/$/, ''));
    else localStorage.removeItem('meshnet.gateway');
    location.reload();
  });
}

for (const e of node.directory.values()) fingerprint(e.pub).then(fp => fpCache.set(e.id, fp));
await node.start();
renderPills();
renderChat();

setInterval(() => {
  renderPills();
  renderChannels();
  if (activeTab() === 'network') renderNetwork();
}, 2000);

if (!native && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
