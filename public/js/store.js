// Minimal promise wrapper around IndexedDB. One database per node so browser tabs act as independent nodes.
export class Store {
  constructor(name) {
    this.name = name;
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('meta', { keyPath: 'k' });
        db.createObjectStore('packets', { keyPath: 'id' });
        db.createObjectStore('messages', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(this);
      };
      req.onerror = () => reject(req.error);
    });
  }

  run(storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  get(s, key) { return this.run(s, 'readonly', st => st.get(key)); }
  all(s) { return this.run(s, 'readonly', st => st.getAll()); }
  put(s, value) { return this.run(s, 'readwrite', st => st.put(value)); }
  del(s, key) { return this.run(s, 'readwrite', st => st.delete(key)); }
}
