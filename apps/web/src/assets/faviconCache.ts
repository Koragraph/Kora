import {
  type ProjectFaviconEntry,
  PROJECT_FAVICON_THUMBNAIL_SIZE,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  createProjectFaviconImageLoader,
  createProjectFaviconCache,
} from "@kora/client-runtime/favicons";

const DB_NAME = "kora:project-icons";
const DB_VERSION = 2;
const STORE = "images";
const RETIRED_DB = "kora:project-favicons";

let opening: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, fail) => {
    // The old database only held re-fetchable thumbnails; drop it rather than migrate.
    try {
      indexedDB.deleteDatabase(RETIRED_DB);
    } catch {
      /* best effort */
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const label of Array.from(db.objectStoreNames)) {
        if (label !== STORE) db.deleteObjectStore(label);
      }
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => fail(req.error);
    req.onblocked = () => fail(new Error("Project icon cache is blocked."));
  });
  return opening;
}

/** Runs one operation in its own transaction and settles when the transaction completes. */
async function inStore<Item>(
  flavor: IDBTransactionMode,
  exec: (objectStore: IDBObjectStore) => IDBRequest<Item> | void,
): Promise<Item | undefined> {
  const db = await openDatabase();
  return new Promise<Item | undefined>((resolve, fail) => {
    const tx = db.transaction(STORE, flavor);
    const req = exec(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });
}

async function downscale(
  img: { url: string; mimeType: string; bytes: Uint8Array },
  abortSig: AbortSignal,
): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([img.bytes as BlobPart], { type: img.mimeType }));
  try {
    if (abortSig.aborted) throw abortSig.reason ?? new Error("Aborted");
    for (const extent of [PROJECT_FAVICON_THUMBNAIL_SIZE, PROJECT_FAVICON_THUMBNAIL_SIZE / 2]) {
      const scale = Math.min(1, extent / bitmap.width, extent / bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const cx = canvas.getContext("2d");
      if (!cx) throw new Error("Canvas is unavailable.");
      cx.clearRect(0, 0, canvas.width, canvas.height);
      cx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const address = canvas.toDataURL("image/webp", 0.85);
      if (address.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH) return address;
    }
    throw new Error("Project icon thumbnail exceeds the cache limit.");
  } finally {
    bitmap.close?.();
  }
}

export const projectFaviconCache = createProjectFaviconCache({
  storage: {
    list: async () =>
      (await inStore<ProjectFaviconEntry[]>("readonly", (objectStore) => objectStore.getAll())) ??
      [],
    put: async (keyName, rec) => {
      await inStore("readwrite", (objectStore) => objectStore.put(rec, keyName));
    },
    remove: async (keyName) => {
      await inStore("readwrite", (objectStore) => objectStore.delete(keyName));
    },
  },
  load: createProjectFaviconImageLoader({ downscale }),
});
