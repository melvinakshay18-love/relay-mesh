// Bootstrap / signaling server. It only introduces peers to each other (WebRTC offer/answer/ICE),
// relays traffic when a direct WebRTC link cannot be established, and feeds the command dashboard.
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import selfsigned from 'selfsigned';
import qrcode from 'qrcode-terminal';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTTP_PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self' ws: wss:; " +
      "worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules/leaflet/dist')));
app.use('/vendor/vis-network', express.static(path.join(root, 'node_modules/vis-network/standalone/umd')));
app.use('/vendor/capacitor', express.static(path.join(root, 'node_modules/@capacitor/core/dist')));

// ---- mesh registry shared by the HTTP and HTTPS socket servers ----
const nodes = new Map(); // nodeId -> { socket, name, telemetry, updated }
// Offline nodes reported by an uplink phone: nodeId -> { name, telemetry, updated, via }
const remote = new Map();
const REMOTE_TTL = 20000;
const dashboards = new Set();
const ID_RE = /^[a-f0-9]{16}$/;
const STAT_KEYS = ['originated', 'delivered', 'relayed', 'duplicates', 'ttlExpired', 'replayed', 'acked', 'peers', 'known', 'avgRtt', 'avgHops'];

const clean = (v, max = 32) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const num = v => (Number.isFinite(v) ? v : null);
const toDashboards = (event, payload) => dashboards.forEach(d => d.emit(event, payload));
const view = (id, n) => ({ id, name: n.name, ...(n.telemetry ?? { stats: {}, neighbors: [], sos: null }), updated: n.updated ?? null, via: n.via ?? null });

function sanitizeNode(t) {
  const stats = Object.fromEntries(STAT_KEYS.map(k => [k, num(t?.stats?.[k])]));
  const neighbors = (Array.isArray(t?.neighbors) ? t.neighbors : [])
    .slice(0, 64)
    .filter(n => ID_RE.test(n?.id))
    .map(n => ({ id: n.id, rtt: num(n.rtt), transport: ['relay', 'ble'].includes(n.transport) ? n.transport : 'rtc' }));
  const s = t?.sos;
  const sos = s && Number.isFinite(s.lat) && Number.isFinite(s.lng)
    ? { lat: s.lat, lng: s.lng, note: clean(s.note, 200), ts: num(s.ts) }
    : null;
  return { stats, neighbors, sos };
}

function sanitizeTelemetry(t) {
  const flows = (Array.isArray(t?.flows) ? t.flows : [])
    .slice(0, 200)
    .filter(f => ID_RE.test(f?.from) && ID_RE.test(f?.to))
    .map(f => ({ from: f.from, to: f.to, type: clean(f.type, 8), t: num(f.t) }));
  const mesh = (Array.isArray(t?.mesh) ? t.mesh : [])
    .slice(0, 100)
    .filter(m => ID_RE.test(m?.id))
    .map(m => ({ id: m.id, name: clean(m.name) || m.id.slice(0, 6), age: Math.max(0, num(m.age) ?? 0), ...sanitizeNode(m) }));
  return { ...sanitizeNode(t), flows, mesh };
}

// Nodes with no internet of their own, as last reported through any uplink.
function remoteViews() {
  const now = Date.now();
  const out = [];
  for (const [id, r] of remote) {
    if (nodes.has(id)) continue;
    if (now - r.updated > REMOTE_TTL) remote.delete(id);
    else out.push(view(id, r));
  }
  return out;
}

function setup(io) {
  io.on('connection', socket => {
    socket.on('join', msg => {
      const id = msg?.id;
      if (typeof id !== 'string' || !ID_RE.test(id)) return;
      const existing = nodes.get(id);
      // Newest session wins; the other one (e.g. a duplicated browser tab) is told to pick a new id.
      if (existing && existing.socket !== socket) {
        existing.socket.data.id = null;
        existing.socket.emit('id-conflict');
      }
      socket.data.id = id;
      nodes.set(id, { socket, name: clean(msg.name) || 'node', telemetry: existing?.telemetry ?? null });
      socket.emit('peers', [...nodes].filter(([k]) => k !== id).map(([k, v]) => ({ id: k, name: v.name })));
      toDashboards('telemetry', { ...view(id, nodes.get(id)), flows: [] });
    });

    socket.on('signal', msg => {
      const from = socket.data.id;
      const target = nodes.get(msg?.to);
      if (!from || !target || !msg.data || typeof msg.data !== 'object') return;
      target.socket.emit('signal', { from, fromName: nodes.get(from)?.name, data: msg.data });
    });

    socket.on('telemetry', t => {
      const id = socket.data.id;
      const n = id && nodes.get(id);
      if (!n || n.socket !== socket) return;
      const { flows, mesh, ...rest } = sanitizeTelemetry(t);
      n.telemetry = rest;
      n.updated = Date.now();
      toDashboards('telemetry', { ...view(id, n), flows });
      for (const m of mesh) {
        if (m.id === id || nodes.has(m.id)) continue;
        const updated = Date.now() - m.age;
        const prev = remote.get(m.id);
        // Two uplinks may report the same node; keep the freshest report.
        if (prev && prev.updated > updated) continue;
        const { age, name, ...telemetry } = m;
        remote.set(m.id, { name, telemetry, updated, via: id });
        toDashboards('telemetry', { ...view(m.id, remote.get(m.id)), flows: [] });
      }
    });

    socket.on('dashboard', () => {
      dashboards.add(socket);
      socket.emit('snapshot', [...[...nodes].map(([id, n]) => view(id, n)), ...remoteViews()]);
    });

    socket.on('disconnect', () => {
      dashboards.delete(socket);
      const id = socket.data.id;
      if (id && nodes.get(id)?.socket === socket) {
        nodes.delete(id);
        toDashboards('node-left', id);
      }
    });
  });
}

function lanIPs() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

const ips = lanIPs();
const pems = await selfsigned.generate([{ name: 'commonName', value: 'meshnet.local' }], {
  notAfterDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map(ip => ({ type: 7, ip }))],
    },
  ],
});

const httpServer = http.createServer(app);
const httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, app);
for (const srv of [httpServer, httpsServer]) setup(new Server(srv, { maxHttpBufferSize: 256 * 1024 }));

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('\n  Relay-Mesh bootstrap node is running\n');
    console.log(`  Laptop (this machine):  http://localhost:${HTTP_PORT}`);
    for (const ip of ips) console.log(`  Phone (same Wi-Fi):     https://${ip}:${HTTPS_PORT}   (accept the certificate warning)`);
    console.log(`  Command dashboard:      http://localhost:${HTTP_PORT}/dashboard.html\n`);
    if (ips[0]) {
      console.log('  Scan with your phone:\n');
      qrcode.generate(`https://${ips[0]}:${HTTPS_PORT}/app.html`, { small: true });
    }
  });
});
