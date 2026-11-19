// PDF viewer page, opened by Files in a frame: EmbedPDF (PDFium compiled to WebAssembly, MIT), served from this
// server only (no CDN, no web fonts). People with Edit can highlight, comment, draw, stamp, sign, fill forms and
// redact; Save sends the finished PDF back to Files as a new version. This page has its own looser CSP (WebAssembly,
// a blob worker and the viewer's own styles) so the rest of Files keeps its strict one.
import EmbedPDF from '/vendor/embedpdf-2.15.1/embedpdf.js';

const q = new URLSearchParams(location.hash.slice(1));
const id = Number(q.get('id'));
let version = Number(q.get('v'));
const edit = q.get('edit') === '1';
const send = m => parent.postMessage(m, location.origin);

// Everything that changes the file, off for people with Read access.
const EDITING = ['annotation', 'redaction', 'form', 'insert', 'signature', 'stamp', 'mode-annotate', 'mode-redact', 'mode-insert', 'mode-shapes', 'mode-form', 'history'];
const colors = {
  light: { background: { app: '#e8ecea', surface: '#ffffff', surfaceAlt: '#f2f4f3' }, foreground: { primary: '#18201d', secondary: '#56625c' }, border: { default: '#cdd5d1', subtle: '#e3e8e5' }, accent: { primary: '#18201d', primaryHover: '#2c3632', primaryActive: '#0d1210', primaryLight: '#f4e8c8', primaryForeground: '#ffffff' } },
  dark: { background: { app: '#121715', surface: '#1b211f', surfaceAlt: '#232a27' }, foreground: { primary: '#e2e8e4', secondary: '#9aa7a0' }, border: { default: '#2e3733', subtle: '#232a27' }, accent: { primary: '#c9a55d', primaryHover: '#dcbc78', primaryActive: '#b08f4c', primaryLight: '#3a3121', primaryForeground: '#121715' } },
};
const theme = ['light', 'dark'].includes(q.get('theme')) ? q.get('theme') : 'system';

const done = task => (task.toPromise ? task.toPromise() : new Promise((ok, no) => task.wait(ok, e => no(new Error(e?.reason?.message || 'The PDF could not be processed.')))));
if (theme !== 'system') document.documentElement.dataset.theme = theme;

const mb = n => `${(n / 1048576).toFixed(1)} MB`;
// The file is fetched here (not by the viewer) so a large PDF shows how far along it is, and the server's own
// explanations (no access, hourly download limit) reach the person.
async function fetchPdf() {
  const res = await fetch(`/api/nodes/${id}/content?inline=1`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The PDF could not be loaded (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    chunks.push(value);
    got += value.length;
    if (total) {
      document.getElementById('bar').style.width = `${Math.min(100, (got / total) * 100)}%`;
      document.getElementById('progress').textContent = `Loading the PDF… ${Math.floor((got / total) * 100)}% of ${mb(total)}`;
    }
  }
  const buf = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  return buf.buffer;
}

try {
  if (!id) throw new Error('No file.');
  const pdf = fetchPdf(); // starts downloading while the engine starts
  const viewer = EmbedPDF.init({
    type: 'container',
    target: document.getElementById('pdf'),
    // Absolute: the engine runs in a blob: worker, where a path like /vendor/… would not resolve.
    wasmUrl: new URL('/vendor/embedpdf-2.15.1/pdfium.wasm', location.href).href,
    worker: true,
    fontFallback: null, // no font downloads from a CDN
    fonts: { ui: null, signature: null }, // no Google Fonts
    stamp: { manifests: [] }, // no stamp catalogue from a CDN; people's own stamps still work
    tabBar: 'never',
    theme: { preference: theme, ...colors },
    disabledCategories: ['document-open', 'document-close', 'document-protect', ...(edit ? [] : EDITING)],
    export: { defaultFileName: q.get('name') || 'document.pdf' },
    annotations: { author: q.get('user') || 'Company Files' },
  });
  const registry = await viewer.registry;
  // Pages are drawn one by one as they come into view, so even long documents open at once after the download.
  const opened = registry.getPlugin('document-manager').provides().openDocumentBuffer({ buffer: await pdf, name: q.get('name') || 'document.pdf' });
  await done((await done(opened)).task);
  document.getElementById('loading').hidden = true;
  const exporter = registry.getPlugin('export')?.provides();
  registry.getPlugin('history')?.provides()?.onHistoryChange?.(() => send({ type: 'dirty' }));
  send({ type: 'ready', edit: edit && !!exporter });

  addEventListener('message', async e => {
    if (e.origin !== location.origin || e.source !== parent || e.data?.type !== 'save') return;
    try {
      const pdf = await done(exporter.saveAsCopy());
      const res = await fetch(`/api/nodes/${id}/content`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'fetch', 'content-type': 'application/pdf', 'x-base-version': String(version) },
        body: pdf,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Saving failed (${res.status}).`);
      version = data.version;
      send({ type: 'saved', version });
    } catch (err) {
      send({ type: 'error', message: err.message || String(err) });
    }
  });
} catch (err) {
  document.getElementById('loading').hidden = true;
  const p = document.getElementById('fail');
  p.textContent = `This PDF could not be shown: ${err.message || err}`;
  p.hidden = false;
  send({ type: 'error', message: p.textContent });
}
