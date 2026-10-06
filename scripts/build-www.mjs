// Bundles public/ plus vendor files into www/ for the Capacitor Android app (no server needed on the phone).
import { cp, rm, mkdir, copyFile } from 'node:fs/promises';

const out = 'www';
await rm(out, { recursive: true, force: true });
await cp('public', out, { recursive: true });
await rm(`${out}/sw.js`);
await copyFile(`${out}/index.html`, `${out}/landing.html`);
// The phone app opens straight into the node UI.
await copyFile('public/app.html', `${out}/index.html`);

await cp('node_modules/leaflet/dist', `${out}/vendor/leaflet`, { recursive: true });
await mkdir(`${out}/vendor/vis-network`, { recursive: true });
await copyFile('node_modules/vis-network/standalone/umd/vis-network.min.js', `${out}/vendor/vis-network/vis-network.min.js`);
await mkdir(`${out}/vendor/capacitor`, { recursive: true });
await copyFile('node_modules/@capacitor/core/dist/capacitor.js', `${out}/vendor/capacitor/capacitor.js`);
await mkdir(`${out}/socket.io`, { recursive: true });
await copyFile('node_modules/socket.io/client-dist/socket.io.min.js', `${out}/socket.io/socket.io.js`);

console.log('www/ built');
