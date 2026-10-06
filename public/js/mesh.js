// MeshNode: WebRTC transport + gossip routing + store-and-forward + link-state topology discovery.
import { encryptFor, decryptFrom, validJwk, fingerprint } from './crypto.js';

export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const DEFAULT_TTL = 8;
const SOS_TTL = 16;
const LSA_EVERY = 3000;
const PING_EVERY = 2000;
const PEER_TIMEOUT = 15000;
const RTC_TIMEOUT = 8000;
const ONLINE_WINDOW = 10000;
const CARRY_MS = 30 * 60 * 1000;
const MAX_WIRE = 64 * 1024;
const MAX_TEXT = 1000;
const TYPES = new Set(['lsa', 'chat', 'dm', 'sos', 'ack']);

const BLE_RETRY_MS = 15000;
const BLE_MAX_PAYLOAD = 30000;
const NODE_ID_RE = /^[a-f0-9]{16}$/;
const TRANSPORTS = new Set(['rtc', 'relay', 'ble']);
const LSA_STAT_KEYS = ['originated', 'delivered', 'relayed', 'duplicates', 'replayed', 'acked', 'peers', 'avgRtt', 'avgHops'];
const cleanStats = s => Object.fromEntries(LSA_STAT_KEYS.map(k => [k, Number.isFinite(s?.[k]) ? s[k] : null]));
const cleanSos = s =>
  s && Number.isFinite(s.lat) && Number.isFinite(s.lng)
    ? { lat: s.lat, lng: s.lng, note: String(s.note ?? '').slice(0, 200), ts: Number.isFinite(s.ts) ? s.ts : null }
    : null;

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const aadFor = ({ id, src, dst }) => `${id}|${src}|${dst}`;

// Nearby endpoint names are advertised as "<nodeId>|<display name>".
function parseEndpointName(n) {
  if (typeof n !== 'string') return null;
  const i = n.indexOf('|');
  const nodeId = n.slice(0, i);
  return i > 0 && NODE_ID_RE.test(nodeId) ? { nodeId, name: n.slice(i + 1, i + 25) || nodeId.slice(0, 6) } : null;
}

function validPacket(p) {
  return !!p && str(p.id, 40) && TYPES.has(p.type) && str(p.src, 32) && str(p.dst, 32) &&
    typeof p.srcName === 'string' && p.srcName.length <= 32 &&
    Number.isInteger(p.ttl) && p.ttl > 0 && p.ttl <= SOS_TTL && Number.isFinite(p.ts) &&
    Array.isArray(p.hops) && p.hops.length <= 32 && p.hops.every(x => str(x, 32)) &&
    typeof p.payload === 'object' && p.payload !== null;
}

export class MeshNode extends EventTarget {
  // signalingUrl: undefined = same origin, null = no base station, string = remote base station (gateway mode).
  // nearby: Capacitor plugin for Bluetooth/Wi-Fi Direct links on Android (null in the browser).
  constructor({ id, name, identity, store, signalingUrl, nearby = null }) {
    super();
    this.id = id;
    this.name = name;
    this.identity = identity;
    this.store = store;
    this.signalingUrl = signalingUrl;
    this.nearby = nearby;
    this.peers = new Map();      // WebRTC / relay neighbours
    this.blePeers = new Map();   // Bluetooth (Nearby) neighbours
    this.endpoints = new Map();  // Nearby endpointId -> { nodeId, name, pendingSince }
    this.radio = { state: nearby ? 'starting' : 'none', error: null };
    this.blocked = new Set();    // links cut manually (demo of multi-hop routing)
    this.blockedBy = new Set();  // links the other side cut
    this.seen = new Map();       // packet id -> first-seen time (duplicate suppression)
    this.directory = new Map();  // every node learned from link-state adverts
    this.flows = [];
    this.offline = false;
    this.signaling = false;
    this.lastSos = null;
    this.stats = { originated: 0, delivered: 0, relayed: 0, duplicates: 0, ttlExpired: 0, replayed: 0, acked: 0, rtts: [], hopCounts: [] };
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async start() {
    const now = Date.now();
    for (const p of await this.store.all('packets')) this.seen.set(p.id, now);
    for (const m of await this.store.all('messages')) this.seen.set(m.id, now);
    const dir = await this.store.get('meta', 'directory');
    for (const e of dir?.entries ?? []) this.directory.set(e.id, { ...e, neighbors: [], lastSeen: 0 });

    if (this.signalingUrl !== null && typeof io === 'function') {
      this.socket = this.signalingUrl ? io(this.signalingUrl, { transports: ['websocket'] }) : io();
      this.socket.on('connect', () => {
        this.setSignaling(true);
        this.socket.emit('join', { id: this.id, name: this.name });
      });
      this.socket.on('disconnect', () => this.setSignaling(false));
      this.socket.on('peers', list => Array.isArray(list) && list.forEach(p => this.connectTo(p.id, p.name)));
      this.socket.on('signal', msg => this.onSignal(msg).catch(err => console.warn('signal error', err)));
      this.socket.on('id-conflict', () => this.emit('id-conflict'));
    }
    if (this.nearby) await this.startNearby();

    setInterval(() => this.announce(), LSA_EVERY);
    setInterval(() => this.heartbeat(), PING_EVERY);
    setInterval(() => this.sendTelemetry(), 2000);
    setInterval(() => this.cleanup().catch(() => {}), 60000);
  }

  setSignaling(on) {
    this.signaling = on;
    this.emit('signaling', on);
  }

  // keepBluetooth: only the internet side (base station + WebRTC) goes down; phone-to-phone Bluetooth stays up.
  setOffline(off, { keepBluetooth = false } = {}) {
    this.offline = off && !keepBluetooth;
    if (off) {
      for (const p of this.openPeers()) {
        if (keepBluetooth && p.transport === 'ble') continue;
        this.sendTo(p, { k: 'bye' });
        this.drop(p);
      }
      for (const p of [...this.peers.values()]) this.dropPeer(p.id, p);
      this.socket?.disconnect();
      if (this.nearby && !keepBluetooth) {
        this.endpoints.clear();
        this.nearby.stop().catch(() => {});
        this.setRadio('off');
      }
    } else {
      this.socket?.connect();
      if (this.nearby && this.radio.state !== 'on') this.startNearby();
    }
    this.emit('peers');
  }

  setRadio(state, error = null) {
    this.radio = { state, error };
    this.emit('radio', this.radio);
  }

  isBlocked(id) {
    return this.blocked.has(id) || this.blockedBy.has(id);
  }

  drop(peer) {
    if (peer.transport === 'ble') this.dropBle(peer);
    else this.dropPeer(peer.id, peer);
  }

  // ---------------------------------------------------------------- transport: Bluetooth / Wi-Fi Direct (Android Nearby Connections)

  async startNearby() {
    const nb = this.nearby;
    if (!this.nearbyListening) {
      this.nearbyListening = true;
      nb.addListener('endpointFound', e => this.onEndpointFound(e));
      nb.addListener('endpointLost', e => {
        this.endpoints.delete(e.endpointId);
        this.emit('radio', this.radio);
      });
      nb.addListener('connected', e => this.onBleConnected(e));
      nb.addListener('disconnected', e => {
        const p = this.bleByEndpoint(e.endpointId);
        if (p) this.dropBle(p, false);
      });
      nb.addListener('message', e => {
        const p = this.bleByEndpoint(e.endpointId);
        if (p) this.onWire(p, e.data);
      });
    }
    this.setRadio('starting');
    try {
      await nb.start({ nodeId: this.id, name: this.name });
      this.setRadio('on');
    } catch (err) {
      this.setRadio('error', err?.message ?? String(err));
    }
  }

  onEndpointFound({ endpointId, endpointName }) {
    const parsed = parseEndpointName(endpointName);
    if (!parsed || parsed.nodeId === this.id) return;
    this.endpoints.set(endpointId, { ...parsed, pendingSince: 0 });
    this.emit('radio', this.radio);
    this.maybeConnectBle(endpointId);
  }

  // Only the lower node id dials, so two phones never request each other simultaneously.
  maybeConnectBle(endpointId, force = false) {
    const ep = this.endpoints.get(endpointId);
    if (!ep || this.offline || this.isBlocked(ep.nodeId) || this.blePeers.has(ep.nodeId)) return;
    if (!force && this.id > ep.nodeId) return;
    if (Date.now() - ep.pendingSince < BLE_RETRY_MS) return;
    ep.pendingSince = Date.now();
    this.nearby.connect({ endpointId }).catch(() => {});
  }

  onBleConnected({ endpointId, endpointName, incoming }) {
    const parsed = parseEndpointName(endpointName);
    if (!parsed) return this.nearby.disconnect({ endpointId }).catch(() => {});
    const { nodeId, name } = parsed;
    this.endpoints.set(endpointId, { nodeId, name, pendingSince: 0 });
    // They dialled us after cutting the link, so they restored it.
    if (incoming) this.blockedBy.delete(nodeId);
    if (this.isBlocked(nodeId) || this.offline) return this.nearby.disconnect({ endpointId }).catch(() => {});
    const old = this.blePeers.get(nodeId);
    if (old && old.endpointId !== endpointId) this.dropBle(old);
    this.markOpen({ id: nodeId, name, endpointId, open: false, transport: 'ble', rtt: null, lastHeard: Date.now() });
  }

  bleByEndpoint(endpointId) {
    for (const p of this.blePeers.values()) if (p.endpointId === endpointId) return p;
    return null;
  }

  dropBle(peer, notifyNative = true) {
    if (this.blePeers.get(peer.id) !== peer) return;
    this.blePeers.delete(peer.id);
    peer.open = false;
    const ep = this.endpoints.get(peer.endpointId);
    if (ep) ep.pendingSince = Date.now();
    if (notifyNative) this.nearby.disconnect({ endpointId: peer.endpointId }).catch(() => {});
    this.emit('peers');
  }

  // ---------------------------------------------------------------- transport (WebRTC + relay fallback)

  signal(to, data) {
    if (this.socket?.connected) this.socket.emit('signal', { to, data });
  }

  connectTo(id, name) {
    if (this.offline || id === this.id || this.isBlocked(id) || this.peers.has(id)) return;
    this.createPeer(id, name, true);
  }

  createPeer(id, name, initiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { id, name, pc, dc: null, open: false, transport: 'rtc', initiator, rtt: null, pendingIce: [], lastHeard: Date.now() };
    this.peers.set(id, peer);

    pc.onicecandidate = e => e.candidate && this.signal(id, { type: 'ice', candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => pc.connectionState === 'failed' && this.fallbackToRelay(peer);

    if (initiator) {
      this.bindChannel(peer, pc.createDataChannel('mesh'));
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => this.signal(id, { type: 'offer', sdp: pc.localDescription.toJSON() }))
        .catch(err => console.warn('offer failed', err));
    } else {
      pc.ondatachannel = e => this.bindChannel(peer, e.channel);
    }
    peer.timer = setTimeout(() => this.fallbackToRelay(peer), RTC_TIMEOUT);
    this.emit('peers');
    return peer;
  }

  bindChannel(peer, dc) {
    peer.dc = dc;
    dc.onopen = () => this.markOpen(peer);
    dc.onclose = () => peer.transport === 'rtc' && this.dropPeer(peer.id, peer);
    dc.onmessage = e => this.onWire(peer, e.data);
  }

  // If a direct link can't be established (strict NAT / Wi-Fi client isolation) tunnel through the bootstrap server.
  fallbackToRelay(peer) {
    if (peer.open || this.peers.get(peer.id) !== peer) return;
    if (!this.socket?.connected) return this.dropPeer(peer.id, peer);
    peer.transport = 'relay';
    try { peer.pc?.close(); } catch {}
    peer.pc = null;
    peer.dc = null;
    this.signal(peer.id, { type: 'relay-open' });
    this.markOpen(peer);
  }

  markOpen(peer) {
    if (peer.open) return;
    clearTimeout(peer.timer);
    peer.open = true;
    peer.lastHeard = Date.now();
    (peer.transport === 'ble' ? this.blePeers : this.peers).set(peer.id, peer);
    this.emit('peers');
    this.announce();
    this.replayTo(peer).catch(err => console.warn('replay failed', err));
  }

  dropPeer(id, only) {
    const p = this.peers.get(id);
    if (!p || (only && p !== only)) return;
    this.peers.delete(id);
    clearTimeout(p.timer);
    p.open = false;
    try { p.dc?.close(); } catch {}
    try { p.pc?.close(); } catch {}
    this.emit('peers');
  }

  block(peerId) {
    this.blocked.add(peerId);
    this.signal(peerId, { type: 'block' });
    this.dropPeer(peerId);
    const ble = this.blePeers.get(peerId);
    if (ble) {
      this.sendTo(ble, { k: 'block' });
      // Give the block notice time to leave the radio before disconnecting.
      setTimeout(() => this.dropBle(ble), 400);
    }
    this.emit('peers');
  }

  unblock(peerId) {
    this.blocked.delete(peerId);
    this.signal(peerId, { type: 'unblock' });
    this.connectTo(peerId, this.directory.get(peerId)?.name);
    for (const [endpointId, ep] of this.endpoints) {
      if (ep.nodeId === peerId) {
        ep.pendingSince = 0;
        this.maybeConnectBle(endpointId, true);
      }
    }
    this.emit('peers');
  }

  async onSignal({ from, fromName, data } = {}) {
    if (!str(from, 32) || !data || typeof data.type !== 'string') return;
    if (data.type === 'block') {
      this.blockedBy.add(from);
      this.dropPeer(from);
      const ble = this.blePeers.get(from);
      if (ble) this.dropBle(ble);
      return;
    }
    if (data.type === 'unblock') {
      this.blockedBy.delete(from);
      this.emit('peers');
      return;
    }
    if (this.isBlocked(from) || this.offline) return;

    let peer = this.peers.get(from);
    switch (data.type) {
      case 'offer': {
        // Glare: both sides offered at once; the lower id keeps its own offer.
        if (peer && peer.initiator && !peer.open && this.id < from) return;
        if (peer) this.dropPeer(from);
        peer = this.createPeer(from, fromName, false);
        await peer.pc.setRemoteDescription(data.sdp);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.signal(from, { type: 'answer', sdp: peer.pc.localDescription.toJSON() });
        await this.flushIce(peer);
        break;
      }
      case 'answer':
        if (peer?.pc?.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription(data.sdp);
          await this.flushIce(peer);
        }
        break;
      case 'ice':
        if (!peer?.pc) return;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pendingIce.push(data.candidate);
        break;
      case 'relay-open':
        if (!peer) {
          peer = { id: from, name: fromName, open: false, initiator: false, pendingIce: [], rtt: null };
          this.peers.set(from, peer);
        }
        clearTimeout(peer.timer);
        peer.transport = 'relay';
        try { peer.pc?.close(); } catch {}
        peer.pc = null;
        peer.dc = null;
        this.markOpen(peer);
        this.emit('peers');
        break;
      case 'relay':
        if (peer?.open && peer.transport === 'relay') this.onWire(peer, data.msg);
        break;
    }
  }

  async flushIce(peer) {
    for (const c of peer.pendingIce.splice(0)) await peer.pc?.addIceCandidate(c).catch(() => {});
  }

  sendTo(peer, msg) {
    if (!peer.open) return false;
    const raw = JSON.stringify(msg);
    try {
      if (peer.transport === 'rtc') {
        if (peer.dc?.readyState !== 'open') return false;
        peer.dc.send(raw);
      } else if (peer.transport === 'ble') {
        if (raw.length > BLE_MAX_PAYLOAD) return false;
        this.nearby.send({ endpointId: peer.endpointId, data: raw }).catch(() => {});
      } else {
        if (!this.socket?.connected) return false;
        this.socket.emit('signal', { to: peer.id, data: { type: 'relay', msg: raw } });
      }
      return true;
    } catch {
      return false;
    }
  }

  onWire(peer, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_WIRE) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    peer.lastHeard = Date.now();
    switch (msg?.k) {
      case 'pkt': this.handlePacket(msg.p, peer.id).catch(err => console.warn('packet error', err)); break;
      case 'ping': this.sendTo(peer, { k: 'pong', t: msg.t }); break;
      case 'pong': if (Number.isFinite(msg.t)) peer.rtt = Date.now() - msg.t; break;
      case 'bye': this.drop(peer); break;
      case 'block':
        this.blockedBy.add(peer.id);
        this.drop(peer);
        break;
    }
  }

  heartbeat() {
    const now = Date.now();
    for (const p of this.openPeers()) {
      if (now - p.lastHeard > PEER_TIMEOUT) this.drop(p);
      else this.sendTo(p, { k: 'ping', t: now });
    }
    for (const endpointId of this.endpoints.keys()) this.maybeConnectBle(endpointId);
  }

  openPeers() {
    return [...this.peers.values(), ...this.blePeers.values()].filter(p => p.open);
  }

  // ---------------------------------------------------------------- routing

  async originate(type, dst, payload, { id = uid(), ttl = DEFAULT_TTL } = {}) {
    const pkt = { id, type, src: this.id, srcName: this.name, dst, ttl, ts: Date.now(), hops: [this.id], payload };
    if (type !== 'lsa') {
      this.seen.set(id, Date.now());
      if (type !== 'ack') this.stats.originated++;
      await this.carry(pkt);
    }
    return { pkt, sentTo: this.flood(pkt, null) };
  }

  // Controlled flooding: never send back to the sender or to anyone already on the route.
  flood(pkt, exceptId) {
    let n = 0;
    for (const p of this.openPeers()) {
      if (p.id === exceptId || pkt.hops.includes(p.id)) continue;
      if (this.sendTo(p, { k: 'pkt', p: pkt })) {
        n++;
        if (pkt.type !== 'lsa') this.recordFlow(this.id, p.id, pkt.type);
      }
    }
    return n;
  }

  async handlePacket(pkt, fromId) {
    if (!validPacket(pkt)) return;
    if (pkt.type === 'lsa') return this.onLsa(pkt, fromId);
    if (this.seen.has(pkt.id)) {
      this.stats.duplicates++;
      return;
    }
    this.seen.set(pkt.id, Date.now());
    if (pkt.src === this.id) return;
    this.emit('flow', { from: fromId, to: this.id, type: pkt.type });

    // An ack "immunises" the network: everyone stops carrying the delivered message.
    if (pkt.type === 'ack' && str(pkt.payload.ackOf, 40)) this.store.del('packets', pkt.payload.ackOf).catch(() => {});

    const forMe = pkt.dst === this.id;
    if (forMe || pkt.dst === '*') {
      try { await this.deliver(pkt); } catch (err) { console.warn('deliver failed', err); }
    }
    if (forMe) return;

    const fwd = { ...pkt, ttl: pkt.ttl - 1, hops: [...pkt.hops, this.id] };
    if (fwd.ttl <= 0) {
      this.stats.ttlExpired++;
      return;
    }
    await this.carry(fwd);
    if (this.flood(fwd, fromId)) this.stats.relayed++;
  }

  carry(pkt) {
    return this.store.put('packets', { ...pkt, carriedAt: Date.now() });
  }

  // Store-and-forward: hand every carried packet to a newly met neighbour (epidemic routing).
  async replayTo(peer) {
    const now = Date.now();
    const list = (await this.store.all('packets'))
      .filter(p => now - p.carriedAt < CARRY_MS)
      .sort((a, b) => a.carriedAt - b.carriedAt)
      .slice(-300);
    for (const { carriedAt, ...pkt } of list) {
      if (pkt.hops.includes(peer.id)) continue;
      if (this.sendTo(peer, { k: 'pkt', p: pkt })) {
        this.stats.replayed++;
        this.recordFlow(this.id, peer.id, pkt.type);
      }
    }
    for (const m of await this.store.all('messages')) {
      if (m.status !== 'queued') continue;
      m.status = 'sent';
      await this.store.put('messages', m);
      this.emit('message', m);
    }
  }

  // ---------------------------------------------------------------- topology discovery (link-state adverts)

  announce() {
    if (this.offline) return;
    const neighbors = this.openPeers().map(p => ({ id: p.id, rtt: p.rtt, transport: p.transport }));
    // Stats and SOS ride along so any node that reaches the internet can report the whole offline mesh.
    this.originate('lsa', '*', {
      name: this.name,
      pub: this.identity.publicJwk,
      neighbors,
      stats: cleanStats(this.summary()),
      sos: this.lastSos,
    });
  }

  onLsa(pkt, fromId) {
    if (pkt.src === this.id) return;
    const prev = this.directory.get(pkt.src);
    if (prev?.lsaTs >= pkt.ts) return;
    const { name, pub, neighbors } = pkt.payload;
    if (!validJwk(pub) || !Array.isArray(neighbors)) return;
    const entry = {
      id: pkt.src,
      name: String(name ?? '').slice(0, 24) || pkt.src.slice(0, 6),
      pub: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y },
      neighbors: neighbors
        .slice(0, 64)
        .filter(n => str(n?.id, 32))
        .map(n => ({ id: n.id, rtt: Number.isFinite(n.rtt) ? n.rtt : null, transport: TRANSPORTS.has(n.transport) ? n.transport : 'rtc' })),
      lastSeen: Date.now(),
      lsaTs: pkt.ts,
      distance: pkt.hops.length,
      stats: cleanStats(pkt.payload.stats),
      sos: cleanSos(pkt.payload.sos),
    };
    this.directory.set(pkt.src, entry);
    if (!prev || prev.pub.x !== entry.pub.x || prev.name !== entry.name) this.persistDirectory();
    this.emit('directory');

    const fwd = { ...pkt, ttl: pkt.ttl - 1, hops: [...pkt.hops, this.id] };
    if (fwd.ttl > 0) this.flood(fwd, fromId);
  }

  persistDirectory() {
    const entries = [...this.directory.values()].map(({ id, name, pub }) => ({ id, name, pub }));
    this.store.put('meta', { k: 'directory', entries }).catch(() => {});
  }

  isOnline(entry) {
    return Date.now() - entry.lastSeen < ONLINE_WINDOW;
  }

  onlineNodes() {
    return [...this.directory.values()].filter(e => this.isOnline(e));
  }

  // ---------------------------------------------------------------- application layer

  async deliver(pkt) {
    const p = pkt.payload;
    if (pkt.type === 'ack') return this.onAck(pkt);
    const base = { id: pkt.id, from: pkt.src, fromName: pkt.srcName, ts: pkt.ts, hops: [...pkt.hops, this.id], dir: 'in' };
    let rec;
    if (pkt.type === 'chat') {
      rec = { ...base, kind: 'chat', peer: '*', text: String(p.text ?? '').slice(0, MAX_TEXT) };
    } else if (pkt.type === 'sos') {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
      rec = { ...base, kind: 'sos', peer: '*', lat: p.lat, lng: p.lng, acc: Number.isFinite(p.acc) ? p.acc : null, approx: !!p.approx, text: String(p.note ?? '').slice(0, 200) };
    } else if (pkt.type === 'dm') {
      rec = { ...base, kind: 'dm', peer: pkt.src };
      try {
        rec.text = (await decryptFrom(this.identity.privateKey, p.pub, p, aadFor(pkt))).slice(0, MAX_TEXT);
        rec.e2e = true;
        rec.senderFp = await fingerprint(p.pub);
        const known = this.directory.get(pkt.src);
        if (known && known.pub.x !== p.pub.x) rec.keyWarning = true;
      } catch {
        rec.text = 'Unable to decrypt message';
        rec.failed = true;
      }
      this.originate('ack', pkt.src, { ackOf: pkt.id, route: rec.hops });
    } else {
      return;
    }
    this.stats.delivered++;
    await this.store.put('messages', rec);
    this.emit('message', rec);
  }

  async onAck(pkt) {
    if (pkt.dst !== this.id) return;
    const { ackOf, route } = pkt.payload;
    const m = str(ackOf, 40) && (await this.store.get('messages', ackOf));
    if (!m || m.dir !== 'out' || m.status === 'delivered') return;
    m.status = 'delivered';
    m.rtt = Date.now() - m.ts;
    if (Array.isArray(route)) m.hops = route.filter(x => str(x, 32)).slice(0, 32);
    m.hopCount = m.hops.length - 1;
    this.stats.acked++;
    this.stats.rtts.push(m.rtt);
    this.stats.hopCounts.push(m.hopCount);
    await this.store.put('messages', m);
    this.emit('message', m);
  }

  async sendChat(text) {
    text = text.trim().slice(0, MAX_TEXT);
    if (!text) return;
    const { pkt, sentTo } = await this.originate('chat', '*', { text });
    return this.saveOutgoing(pkt, sentTo, { kind: 'chat', peer: '*', text });
  }

  async sendDM(dst, text) {
    text = text.trim().slice(0, MAX_TEXT);
    const entry = this.directory.get(dst);
    if (!text) return;
    if (!entry) throw new Error('Unknown node: no public key yet');
    const id = uid();
    const enc = await encryptFor(this.identity.privateKey, entry.pub, text, aadFor({ id, src: this.id, dst }));
    const { pkt, sentTo } = await this.originate('dm', dst, { ...enc, pub: this.identity.publicJwk }, { id });
    return this.saveOutgoing(pkt, sentTo, { kind: 'dm', peer: dst, text, e2e: true });
  }

  async sendSOS({ lat, lng, acc, approx, note }) {
    const payload = { lat, lng, acc, approx, note: note.slice(0, 200) };
    const { pkt, sentTo } = await this.originate('sos', '*', payload, { ttl: SOS_TTL });
    this.lastSos = { lat, lng, note: payload.note, ts: pkt.ts };
    return this.saveOutgoing(pkt, sentTo, { kind: 'sos', peer: '*', lat, lng, acc, approx, text: payload.note });
  }

  async saveOutgoing(pkt, sentTo, fields) {
    const rec = { id: pkt.id, from: this.id, fromName: this.name, ts: pkt.ts, hops: [this.id], dir: 'out', status: sentTo ? 'sent' : 'queued', ...fields };
    await this.store.put('messages', rec);
    this.emit('message', rec);
    return rec;
  }

  // ---------------------------------------------------------------- metrics

  recordFlow(from, to, type) {
    this.flows.push({ from, to, type, t: Date.now() });
    if (this.flows.length > 500) this.flows.shift();
    this.emit('flow', { from, to, type });
  }

  summary() {
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const { rtts, hopCounts, ...rest } = this.stats;
    return { ...rest, peers: this.openPeers().length, known: this.onlineNodes().length, avgRtt: avg(rtts), avgHops: avg(hopCounts) };
  }

  sendTelemetry() {
    if (!this.socket?.connected) return;
    this.socket.emit('telemetry', {
      neighbors: this.openPeers().map(p => ({ id: p.id, rtt: p.rtt, transport: p.transport })),
      stats: this.summary(),
      flows: this.flows.splice(0, 200),
      sos: this.lastSos,
      mesh: this.onlineNodes()
        .slice(0, 100)
        .map(e => ({ id: e.id, name: e.name, neighbors: e.neighbors, stats: e.stats, sos: e.sos, age: Date.now() - e.lastSeen })),
    });
  }

  async cleanup() {
    const now = Date.now();
    for (const p of await this.store.all('packets')) if (now - p.carriedAt > CARRY_MS) await this.store.del('packets', p.id);
    for (const [id, t] of this.seen) if (now - t > CARRY_MS * 2) this.seen.delete(id);
  }
}
