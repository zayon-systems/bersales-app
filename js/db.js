// Bersales — db.js
//
// Thin IndexedDB wrapper across multiple object stores. Every record stored
// here is already AES-GCM ciphertext produced by crypto.js — this module
// never sees plaintext. Nothing in this file makes a network call;
// IndexedDB is on-device only.
//
// Stores:
//   documents — document metadata (fields, category, docType) WITHOUT the
//               scanned image, so listing/rendering the vault never has to
//               decrypt photo bytes.
//   images    — scanned document images, keyed by the same id as their
//               document record, decrypted only when actually displayed.
//   debts     — the debt ledger (money I owe / owed to me).
//   bills     — the bills tracker.
//   creditCards — credit card statement cutoff / payment due reminders.
//   healthReminders — medical/dental/vaccination/medication due reminders.
//   todos     — to-do list items, each with its own checklist.

const DB = (() => {
  const DB_NAME = 'bersales_db';
  const DB_VERSION = 4;
  const STORES = ['documents', 'images', 'debts', 'bills', 'creditCards', 'healthReminders', 'todos'];

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach((store) => {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store, { keyPath: 'id' });
          }
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function putRaw(store, id, payload) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put({ id, payload, updatedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getRaw(store, id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllRaw(store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteRaw(store, id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  return { STORES, putRaw, getRaw, getAllRaw, deleteRaw };
})();
