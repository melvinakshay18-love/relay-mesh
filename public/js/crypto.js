// End-to-end encryption: ECDH (P-256) key agreement -> AES-256-GCM, via the browser's Web Crypto API.
const subtle = globalThis.crypto?.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const te = new TextEncoder();
const td = new TextDecoder();

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export const cryptoAvailable = () => !!subtle && typeof crypto.randomUUID === 'function';

export const validJwk = k =>
  !!k && k.kty === 'EC' && k.crv === 'P-256' &&
  typeof k.x === 'string' && typeof k.y === 'string' && k.x.length < 64 && k.y.length < 64;

// The private key is generated non-extractable and kept as a CryptoKey in IndexedDB, so page JS can never read its bytes.
export async function loadIdentity(store) {
  const saved = await store.get('meta', 'identity');
  if (saved) return saved;
  const kp = await subtle.generateKey(ECDH, false, ['deriveKey']);
  const identity = { k: 'identity', privateKey: kp.privateKey, publicJwk: await subtle.exportKey('jwk', kp.publicKey) };
  await store.put('meta', identity);
  return identity;
}

const keyCache = new Map();
function sharedKey(privateKey, jwk) {
  const cacheKey = `${jwk.x}.${jwk.y}`;
  if (!keyCache.has(cacheKey)) {
    const p = subtle
      .importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ECDH, false, [])
      .then(pub => subtle.deriveKey({ name: 'ECDH', public: pub }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    p.catch(() => keyCache.delete(cacheKey));
    keyCache.set(cacheKey, p);
  }
  return keyCache.get(cacheKey);
}

// `aad` binds the ciphertext to the packet header so relays cannot re-address or replay it under another id.
export async function encryptFor(privateKey, peerJwk, text, aad) {
  const key = await sharedKey(privateKey, peerJwk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, te.encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function decryptFrom(privateKey, peerJwk, { iv, ct }, aad) {
  if (!validJwk(peerJwk)) throw new Error('bad key');
  const key = await sharedKey(privateKey, peerJwk);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: te.encode(aad) }, key, unb64(ct));
  return td.decode(pt);
}

// Short human-comparable key fingerprint (like Signal safety numbers).
export async function fingerprint(jwk) {
  const digest = await subtle.digest('SHA-256', te.encode(`${jwk.x}.${jwk.y}`));
  const hex = [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{4}/g).join(' ');
}
