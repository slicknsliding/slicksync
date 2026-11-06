// A small note for the service worker (public/sw.js) saying what kind of
// device this is, so it can re-send a rotated push subscription to the right
// route. IndexedDB because the worker can't read localStorage. Best effort.

export interface PushHint {
  kind: 'admin' | 'person';
  publicKey: string;
  userId?: string;
  authKey?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('slicksync-push', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setPushHint(hint: PushHint | null): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction('kv', 'readwrite');
      if (hint) tx.objectStore('kv').put(hint, 'hint');
      else tx.objectStore('kv').delete('hint');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // no IndexedDB: the worker simply won't re-send
  }
}
