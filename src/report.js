/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */

/**
 * @typedef {object} Group
 * @property {string} bundle       bundle file name
 * @property {'folder' | 'library'} type
 * @property {string} path         folder relpath or library relpath
 * @property {string | null} libraryKind
 * @property {number} files
 * @property {number} images
 * @property {number} raws
 * @property {number} videos
 * @property {number} edited
 * @property {number} bytes
 * @property {number | null} mtimeMin  ms since epoch
 * @property {number | null} mtimeMax
 * @property {string | null} exifMin
 * @property {string | null} exifMax
 * @property {number} withExifDate
 * @property {Record<string, number>} cameras  "Make Model" -> count
 * @property {string | null} firstSnapshot
 */

/**
 * Aggregate the index into folder / library groups.
 *
 * @param {DatabaseSync} db
 * @param {{ bundle?: string }} [opts] restrict to a bundle name
 * @returns {Group[]}
 */
export function buildGroups(db, opts = {}) {
  const where = opts.bundle ? 'WHERE b.name = ?' : '';
  const params = opts.bundle ? [opts.bundle] : [];
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT b.name AS bundle,
                CASE WHEN f.library_id IS NULL THEN 'folder' ELSE 'library' END AS type,
                COALESCE(l.relpath, f.folder) AS group_path,
                l.kind AS libraryKind,
                COUNT(*) AS files,
                SUM(f.kind = 'image') AS images,
                SUM(f.kind = 'raw') AS raws,
                SUM(f.kind = 'video') AS videos,
                SUM(COALESCE(f.role = 'edited', 0)) AS edited,
                SUM(f.size) AS bytes,
                MIN(f.mtime_ms) AS mtimeMin,
                MAX(f.mtime_ms) AS mtimeMax,
                MIN(f.exif_date) AS exifMin,
                MAX(f.exif_date) AS exifMax,
                COUNT(f.exif_date) AS withExifDate,
                MIN(s.name) AS firstSnapshot
         FROM files f
         JOIN bundles b ON b.id = f.bundle_id
         JOIN snapshots s ON s.id = f.first_snapshot_id
         LEFT JOIN libraries l ON l.id = f.library_id
         ${where}
         GROUP BY f.bundle_id, type, group_path
         ORDER BY b.name, group_path`,
      )
      .all(...params)
  );
  const cams = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT b.name AS bundle, COALESCE(l.relpath, f.folder) AS group_path,
                TRIM(COALESCE(f.camera_make, '') || ' ' || COALESCE(f.camera_model, '')) AS camera,
                COUNT(*) AS n
         FROM files f
         JOIN bundles b ON b.id = f.bundle_id
         LEFT JOIN libraries l ON l.id = f.library_id
         ${where ? `${where} AND` : 'WHERE'} (f.camera_make IS NOT NULL OR f.camera_model IS NOT NULL)
         GROUP BY f.bundle_id, group_path, camera`,
      )
      .all(...params)
  );
  /** @type {Map<string, Record<string, number>>} */
  const camMap = new Map();
  for (const c of cams) {
    const key = `${c.bundle}\u0000${c.group_path}`;
    const m = camMap.get(key) ?? {};
    m[normalizeCamera(c.camera)] = (m[normalizeCamera(c.camera)] ?? 0) + c.n;
    camMap.set(key, m);
  }
  return rows.map(({ group_path: groupPath, ...r }) => ({
    ...r,
    path: groupPath,
    files: Number(r.files),
    images: Number(r.images),
    raws: Number(r.raws),
    videos: Number(r.videos),
    edited: Number(r.edited),
    bytes: Number(r.bytes),
    withExifDate: Number(r.withExifDate),
    cameras: camMap.get(`${r.bundle}\u0000${groupPath}`) ?? {},
  }));
}

/**
 * "Canon Canon EOS 5D" -> "Canon EOS 5D"
 *
 * @param {string} s
 */
export function normalizeCamera(s) {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const make = words[0].toLowerCase();
    if (words[1].toLowerCase().startsWith(make)) words.shift();
  }
  return words.join(' ');
}

/**
 * @param {DatabaseSync} db
 */
export function summary(db) {
  const totals = /** @type {any} */ (
    db
      .prepare(
        `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
                SUM(kind = 'image') AS images, SUM(kind = 'raw') AS raws,
                SUM(kind = 'video') AS videos FROM files`,
      )
      .get()
  );
  const bundles = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT b.name, b.format,
                (SELECT COUNT(*) FROM snapshots s WHERE s.bundle_id = b.id) AS snapshots,
                (SELECT COUNT(*) FROM snapshots s WHERE s.bundle_id = b.id AND s.status = 'done') AS scanned,
                (SELECT MIN(name) FROM snapshots s WHERE s.bundle_id = b.id) AS oldest,
                (SELECT MAX(name) FROM snapshots s WHERE s.bundle_id = b.id) AS newest,
                (SELECT COUNT(*) FROM files f WHERE f.bundle_id = b.id) AS files
         FROM bundles b ORDER BY b.name`,
      )
      .all()
  );
  const libraries = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT b.name AS bundle, l.relpath, l.kind,
                (SELECT COUNT(*) FROM files f WHERE f.library_id = l.id) AS files
         FROM libraries l JOIN bundles b ON b.id = l.bundle_id ORDER BY b.name, l.relpath`,
      )
      .all()
  );
  return {
    files: Number(totals.files),
    bytes: Number(totals.bytes),
    images: Number(totals.images ?? 0),
    raws: Number(totals.raws ?? 0),
    videos: Number(totals.videos ?? 0),
    bundles,
    libraries,
  };
}

/** @param {string} s */
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/** @param {number} n */
export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)} ${units[i]}`;
}

/**
 * Render a self-contained HTML report.
 *
 * @param {DatabaseSync} db
 * @param {{ bundle?: string, generatedAt?: Date }} [opts]
 */
export function renderReport(db, opts = {}) {
  const groups = buildGroups(db, opts);
  const sum = summary(db);
  const generated = (opts.generatedAt ?? new Date()).toISOString().replace('T', ' ').slice(0, 19);
  // JSON inside <script>: escape "<" so a path containing "</script>" is inert.
  const data = JSON.stringify(groups).replace(/</g, '\\u003c');
  const bundleRows = sum.bundles
    .map(
      (b) =>
        `<tr><td>${esc(b.name)}</td><td>${esc(b.format ?? '?')}</td><td class="n">${b.scanned} / ${b.snapshots}</td>` +
        `<td>${esc(b.oldest ?? '')}</td><td>${esc(b.newest ?? '')}</td><td class="n">${Number(b.files).toLocaleString('en-US')}</td></tr>`,
    )
    .join('');
  const libRows = sum.libraries
    .map(
      (l) =>
        `<tr><td>${esc(l.bundle)}</td><td>${esc(l.relpath)}</td><td>${esc(l.kind)}</td><td class="n">${Number(l.files).toLocaleString('en-US')}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tmphotos report</title>
<style>
:root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --accent:#0a66d8; --row:#f5f5f7; --lib:#fff6e0; }
@media (prefers-color-scheme: dark) { :root { --bg:#111214; --fg:#f2f2f5; --muted:#9a9aa1; --line:#2c2c30; --accent:#5aa2ff; --row:#1a1b1e; --lib:#2a2414; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 64px; font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
main { max-width:1400px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:28px 0 8px; }
.muted { color:var(--muted); }
.cards { display:flex; flex-wrap:wrap; gap:12px; margin:16px 0; }
.card { border:1px solid var(--line); border-radius:10px; padding:10px 14px; min-width:140px; }
.card b { display:block; font-size:20px; font-variant-numeric:tabular-nums; }
table { border-collapse:collapse; width:100%; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { position:sticky; top:0; background:var(--bg); cursor:pointer; user-select:none; white-space:nowrap; font-weight:600; }
td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
tr.lib td { background:var(--lib); }
td.path { word-break:break-all; min-width:280px; }
.wrap { overflow-x:auto; }
.controls { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin:12px 0; position:sticky; top:0; background:var(--bg); padding:8px 0; z-index:2; }
input[type=search] { flex:1 1 260px; padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
select, button, input[type=number] { font:inherit; padding:6px 10px; border:1px solid var(--line); border-radius:8px; background:var(--row); color:var(--fg); }
button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
.tag { font-size:11px; padding:1px 6px; border-radius:6px; border:1px solid var(--line); color:var(--muted); margin-left:6px; }
.cams { color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<main>
<h1>Time Machine photo report</h1>
<div class="muted">Generated ${esc(generated)} by tmphotos. Each unique file is counted once, however many snapshots contain it.</div>
<div class="cards">
  <div class="card"><b>${sum.files.toLocaleString('en-US')}</b>unique files</div>
  <div class="card"><b>${formatBytes(sum.bytes)}</b>total size</div>
  <div class="card"><b>${sum.images.toLocaleString('en-US')}</b>images</div>
  <div class="card"><b>${sum.raws.toLocaleString('en-US')}</b>RAW</div>
  <div class="card"><b>${sum.videos.toLocaleString('en-US')}</b>videos</div>
  <div class="card"><b>${sum.libraries.length}</b>photo libraries</div>
</div>

<h2>Bundles</h2>
<div class="wrap"><table><thead><tr><th>Bundle</th><th>Format</th><th class="n">Scanned</th><th>Oldest</th><th>Newest</th><th class="n">Unique files</th></tr></thead><tbody>${bundleRows}</tbody></table></div>

${
  sum.libraries.length
    ? `<h2>Photo libraries</h2><div class="wrap"><table><thead><tr><th>Bundle</th><th>Library</th><th>Kind</th><th class="n">Files</th></tr></thead><tbody>${libRows}</tbody></table></div>`
    : ''
}

<h2>Folders</h2>
<div class="controls">
  <input type="search" id="q" placeholder="Filter by path or camera…" aria-label="Filter">
  <label>Roll up to depth <select id="depth"><option value="0">none</option>${[2, 3, 4, 5, 6, 7, 8]
    .map((d) => `<option value="${d}">${d}</option>`)
    .join('')}</select></label>
  <label>Min files <input type="number" id="min" value="1" min="1" style="width:80px"></label>
  <span id="selinfo" class="muted"></span>
  <button id="dl" class="primary" disabled>Download selection</button>
</div>
<div class="wrap"><table id="t">
<thead><tr>
<th><input type="checkbox" id="all" aria-label="Select all visible"></th>
<th data-k="bundle">Bundle</th><th data-k="path">Folder</th>
<th data-k="files" class="n">Files</th><th data-k="bytes" class="n">Size</th>
<th data-k="mtimeMin">File dates</th><th data-k="exifMin">EXIF dates</th><th>Cameras</th>
</tr></thead>
<tbody></tbody>
</table></div>
<p class="muted">Selected folders download as <code>selection.txt</code>; extract them with
<code>tmphotos extract --select selection.txt --to /path/to/target</code>.</p>
</main>
<script>
const GROUPS = ${data};
const fmtBytes = ${formatBytes.toString()};
const $ = (s) => document.querySelector(s);
const tbody = $('#t tbody');
const selected = new Set();
let sortKey = 'path', sortDir = 1, view = [];
const day = (ms) => ms == null ? '' : new Date(ms).toISOString().slice(0, 10);
const range = (a, b) => !a ? '' : (a === b ? a : a + ' – ' + b);
const escH = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
function rollup(depth) {
  if (!depth) return GROUPS;
  const m = new Map();
  for (const g of GROUPS) {
    const parts = g.path.split('/');
    const p = g.type === 'library' && parts.length <= depth ? g.path : parts.slice(0, depth).join('/');
    const key = g.bundle + '\\u0000' + p;
    let r = m.get(key);
    if (!r) { r = { ...g, path: p, cameras: {}, type: p === g.path ? g.type : 'folder' }; for (const k of ['files','images','raws','videos','edited','bytes','withExifDate']) r[k] = 0; r.mtimeMin = r.mtimeMax = r.exifMin = r.exifMax = null; m.set(key, r); }
    for (const k of ['files','images','raws','videos','edited','bytes','withExifDate']) r[k] += g[k];
    if (g.mtimeMin != null && (r.mtimeMin == null || g.mtimeMin < r.mtimeMin)) r.mtimeMin = g.mtimeMin;
    if (g.mtimeMax != null && (r.mtimeMax == null || g.mtimeMax > r.mtimeMax)) r.mtimeMax = g.mtimeMax;
    if (g.exifMin && (!r.exifMin || g.exifMin < r.exifMin)) r.exifMin = g.exifMin;
    if (g.exifMax && (!r.exifMax || g.exifMax > r.exifMax)) r.exifMax = g.exifMax;
    for (const [c, n] of Object.entries(g.cameras)) r.cameras[c] = (r.cameras[c] || 0) + n;
  }
  return [...m.values()];
}
function render() {
  const q = $('#q').value.trim().toLowerCase();
  const min = Number($('#min').value) || 1;
  view = rollup(Number($('#depth').value)).filter((g) => g.files >= min &&
    (!q || (g.bundle + ' ' + g.path + ' ' + Object.keys(g.cameras).join(' ')).toLowerCase().includes(q)));
  view.sort((a, b) => { const x = a[sortKey], y = b[sortKey]; return (x < y ? -1 : x > y ? 1 : 0) * sortDir; });
  tbody.innerHTML = view.map((g, i) => {
    const key = g.bundle + '\\t' + g.path;
    const cams = Object.entries(g.cameras).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => escH(c) + ' (' + n + ')').join(', ');
    const kinds = [g.images && g.images + ' img', g.raws && g.raws + ' raw', g.videos && g.videos + ' vid', g.edited && g.edited + ' edited'].filter(Boolean).join(' · ');
    return '<tr class="' + (g.type === 'library' ? 'lib' : '') + '"><td><input type="checkbox" data-i="' + i + '"' + (selected.has(key) ? ' checked' : '') + '></td>' +
      '<td>' + escH(g.bundle) + '</td><td class="path">' + escH(g.path) + (g.type === 'library' ? '<span class="tag">' + escH(g.libraryKind || 'library') + ' library</span>' : '') + '</td>' +
      '<td class="n" title="' + kinds + '">' + g.files.toLocaleString('en-US') + '</td><td class="n">' + fmtBytes(g.bytes) + '</td>' +
      '<td>' + range(day(g.mtimeMin), day(g.mtimeMax)) + '</td><td>' + range(g.exifMin && g.exifMin.slice(0, 10), g.exifMax && g.exifMax.slice(0, 10)) +
      (g.withExifDate && g.withExifDate < g.files ? ' <span class="muted">(' + g.withExifDate + ')</span>' : '') + '</td><td class="cams">' + cams + '</td></tr>';
  }).join('');
  updateSel();
}
function updateSel() {
  let n = 0, b = 0;
  for (const g of rollup(Number($('#depth').value))) if (selected.has(g.bundle + '\\t' + g.path)) { n += g.files; b += g.bytes; }
  $('#selinfo').textContent = selected.size ? selected.size + ' selected · ' + n.toLocaleString('en-US') + ' files · ' + fmtBytes(b) : '';
  $('#dl').disabled = !selected.size;
}
tbody.addEventListener('change', (e) => {
  const i = e.target.dataset.i; if (i == null) return;
  const key = view[i].bundle + '\\t' + view[i].path;
  e.target.checked ? selected.add(key) : selected.delete(key); updateSel();
});
$('#all').addEventListener('change', (e) => { for (const g of view) { const k = g.bundle + '\\t' + g.path; e.target.checked ? selected.add(k) : selected.delete(k); } render(); });
document.querySelectorAll('th[data-k]').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.k; sortDir = sortKey === k ? -sortDir : (['files','bytes'].includes(k) ? -1 : 1); sortKey = k; render();
}));
for (const id of ['#q', '#min', '#depth']) $(id).addEventListener('input', render);
$('#dl').addEventListener('click', () => {
  const text = '# tmphotos selection: <bundle>\\t<folder prefix>\\n' + [...selected].sort().join('\\n') + '\\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = 'selection.txt'; a.click(); URL.revokeObjectURL(a.href);
});
render();
</script>
</body>
</html>
`;
}
