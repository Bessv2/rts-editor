// Small IndexedDB wrapper shared by the editor and the preview page.
// Holds the working draft and saved versions (much more room than localStorage).
const DB_NAME = 'rts-editor';
let dbPromise;

function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('versions', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const store = async (name, mode = 'readonly') => (await db()).transaction(name, mode).objectStore(name);

export const kv = {
  get: async (key) => done((await store('kv')).get(key)),
  set: async (key, value) => done((await store('kv', 'readwrite')).put(value, key)),
  del: async (key) => done((await store('kv', 'readwrite')).delete(key)),
};

export const versions = {
  list: async () => (await done((await store('versions')).getAll())).sort((a, b) => b.savedAt - a.savedAt),
  add: async (v) => done((await store('versions', 'readwrite')).put(v)),
  del: async (id) => done((await store('versions', 'readwrite')).delete(id)),
};
