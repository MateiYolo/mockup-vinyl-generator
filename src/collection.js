// Saved vinyl projects: artwork files + vinyl/sleeve settings, kept in IndexedDB (survives reloads, holds large
// images), with a single-file JSON backup so the collection can be moved or restored if the browser is wiped.

const DB = 'vinyl-mockup-studio', STORE = 'projects';
let dbp;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}

// ask the browser not to evict the collection under storage pressure (best effort)
navigator.storage?.persist?.().catch(() => {});

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// project: { id, name, created, updated, thumb (data URL), settings, images: { slotKey: Blob } }
export const listProjects = async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => b.updated - a.updated);
export const getProject = (id) => tx('readonly', (s) => s.get(id));
export const putProject = (p) => tx('readwrite', (s) => s.put(p));
export const deleteProject = (id) => tx('readwrite', (s) => s.delete(id));

// ---------------------------------------------------------------- backup file
const toDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

export async function exportBackup(projects) {
  const out = [];
  for (const p of projects) {
    const images = {};
    for (const [k, b] of Object.entries(p.images)) images[k] = await toDataURL(b);
    out.push({ ...p, images });
  }
  return new Blob([JSON.stringify({ app: 'vinyl-mockup-studio', version: 1, projects: out })], { type: 'application/json' });
}

export async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('This file is not a vinyl collection backup.'); }
  if (data?.app !== 'vinyl-mockup-studio' || !Array.isArray(data.projects)) throw new Error('This file is not a vinyl collection backup.');
  const existing = new Set((await listProjects()).map((p) => p.id));
  let added = 0, updated = 0;
  for (const p of data.projects) {
    const images = {};
    for (const [k, url] of Object.entries(p.images || {})) images[k] = await (await fetch(url)).blob();
    existing.has(p.id) ? updated++ : added++;
    await putProject({ ...p, images });
  }
  return { added, updated };
}
