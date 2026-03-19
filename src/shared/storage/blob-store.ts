const DB_NAME = 'snapclip-assets';
const DB_VERSION = 1;
const CLIP_ASSET_STORE = 'clip-assets';

type ClipAssetRecord = {
  id: string;
  createdAt: string;
  blob: Blob;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CLIP_ASSET_STORE)) {
        database.createObjectStore(CLIP_ASSET_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
  });
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  executor: (store: IDBObjectStore, resolve: (value: T) => void, reject: (error: Error) => void) => void,
): Promise<T> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CLIP_ASSET_STORE, mode);
    const store = transaction.objectStore(CLIP_ASSET_STORE);

    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));

    executor(store, resolve, reject);
  });
}

export async function putClipAsset(id: string, blob: Blob): Promise<void> {
  await runTransaction<void>('readwrite', (store, resolve, reject) => {
    const request = store.put({
      id,
      createdAt: new Date().toISOString(),
      blob,
    } satisfies ClipAssetRecord);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to store clip asset.'));
  });
}

export async function getClipAssetBlob(id: string): Promise<Blob | null> {
  return runTransaction<Blob | null>('readonly', (store, resolve, reject) => {
    const request = store.get(id);

    request.onsuccess = () => {
      const record = request.result as ClipAssetRecord | undefined;
      resolve(record?.blob ?? null);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to load clip asset.'));
  });
}
