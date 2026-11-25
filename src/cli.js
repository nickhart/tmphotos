import fs from 'node:fs';
import path from 'node:path';
import { Command, Option, InvalidArgumentError } from 'commander';
import { openDb, findBundle } from './db.js';
import { defaultDbPath } from './config.js';
import {
  assertFullDiskAccess,
  attach,
  detach,
  findAttached,
  findBundles,
  listSnapshots,
  resolveBundlePath,
} from './mount.js';
import { scanBundle, registerSnapshots } from './scan.js';
import { renderReport, formatBytes, summary } from './report.js';
import { extractFiles, parseSelection, selectFiles } from './extract.js';
import { globToRegExp } from './classify.js';

const pkg = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), { encoding: 'utf8' }),
);

/** @param {string} v */
export function parseSize(v) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)i?b?$/i.exec(v.trim());
  if (!m) throw new InvalidArgumentError(`not a size: ${v}`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

/** @param {string} v */
function parsePositiveInt(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

/**
 * @param {string} v
 * @param {string[]} prev
 */
function collect(v, prev = []) {
  return [...prev, v];
}

const err = (/** @type {string} */ s) => process.stderr.write(`${s}\n`);
const out = (/** @type {string} */ s) => process.stdout.write(`${s}\n`);

/** A one-line, self-overwriting status display on TTYs; periodic lines otherwise. */
function statusLine() {
  const tty = process.stderr.isTTY;
  let last = 0;
  return {
    /** @param {string} s */
    update(s) {
      if (tty) {
        const width = process.stderr.columns || 100;
        process.stderr.write(`\r\x1b[K${s.length > width - 1 ? `${s.slice(0, width - 2)}…` : s}`);
      } else if (Date.now() - last > 10_000) {
        last = Date.now();
        err(s);
      }
    },
    /** @param {string} [s] */
    end(s) {
      if (tty) process.stderr.write('\r\x1b[K');
      if (s) err(s);
    },
  };
}

/** Abort on the first Ctrl-C, exit hard on the second. */
function interruptible() {
  const ac = new AbortController();
  const onSig = () => {
    if (ac.signal.aborted) process.exit(130);
    err('\nInterrupted — finishing current work and saving progress (Ctrl-C again to quit now)…');
    ac.abort();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  return {
    signal: ac.signal,
    dispose: () => {
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
    },
  };
}

/** @param {Command} cmd */
function dbFrom(cmd) {
  const opts = cmd.optsWithGlobals();
  return openDb(opts.db ?? defaultDbPath());
}

/**
 * Attach if needed. Returns a function that detaches only if we attached.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} bundle
 * @param {{ keepMounted?: boolean, passwordStdin?: boolean }} opts
 */
async function ensureAttached(db, bundle, opts) {
  const bundlePath = resolveBundlePath(bundle);
  assertFullDiskAccess();
  const already = Boolean(await findAttached(bundlePath));
  const password = opts.passwordStdin ? await readStdin() : undefined;
  const att = await attach(db, bundlePath, { password });
  if (!already) err(`Attached ${att.bundle.name} read-only at ${att.mountPoint ?? att.volumeDev}`);
  return {
    att,
    release: async () => {
      if (!already && !opts.keepMounted) {
        await detach(db, bundlePath);
        err(`Detached ${att.bundle.name}`);
      }
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

export function buildProgram() {
  const program = new Command();
  program
    .name('tmphotos')
    .description(
      'Find and extract photos from old Time Machine backups (.sparsebundle / .backupbundle). ' +
        'Source bundles are only ever attached read-only.',
    )
    .version(pkg.version)
    .option('--db <path>', 'index database', process.env.TMPHOTOS_DB)
    .showHelpAfterError();

  program
    .command('bundles')
    .description('list Time Machine bundles in a directory (e.g. the root of an SMB share)')
    .argument('<dir>', 'directory to look in')
    .action((dir) => {
      const found = findBundles(dir);
      if (!found.length) err(`No .sparsebundle or .backupbundle found in ${dir}`);
      for (const b of found) out(b);
    });

  program
    .command('mount')
    .description('attach a bundle read-only and list its snapshots')
    .argument('<bundle>', 'path to a .sparsebundle or .backupbundle')
    .option('--password-stdin', 'read the encryption password from stdin')
    .option('--json', 'print JSON')
    .action(async (bundle, opts, cmd) => {
      const db = dbFrom(cmd);
      assertFullDiskAccess();
      const password = opts.passwordStdin ? await readStdin() : undefined;
      const att = await attach(db, bundle, { password });
      let snaps;
      try {
        snaps = registerSnapshots(db, att.bundle.id, await listSnapshots(att));
      } catch (e) {
        if (!att.reused) await detach(db, att.bundle.path).catch(() => {});
        throw e;
      }
      if (opts.json) {
        out(JSON.stringify({ ...att, snapshots: snaps }, null, 2));
        return;
      }
      out(`${att.reused ? 'Already attached' : 'Attached'} ${att.bundle.path}`);
      out(`  format:      ${att.format === 'hfs' ? 'HFS+ (Backups.backupdb)' : 'APFS snapshots'}`);
      out(`  device:      ${att.volumeDev}`);
      out(`  mount point: ${att.mountPoint ?? '(not mounted)'}`);
      if (att.journalIgnored) {
        out('  note:        journal was dirty (interrupted backup); mounted read-only ignoring it');
      }
      out(`  snapshots:   ${snaps.length}`);
      for (const s of snaps) {
        out(
          `    ${s.machine ? `${s.machine}/` : ''}${s.name}  ${s.status === 'done' ? 'scanned' : s.status}`,
        );
      }
    });

  program
    .command('scan')
    .description('walk every snapshot and index photos, videos and photo libraries (resumable)')
    .argument('<bundle>', 'path to a .sparsebundle or .backupbundle')
    .option('--latest', 'only scan the most recent snapshot')
    .option('--snapshot <name>', 'only scan this snapshot (repeatable)', collect)
    .option('--rescan', 're-walk snapshots that were already scanned')
    .addOption(
      new Option('-j, --concurrency <n>', 'parallel directory listings')
        .default(8)
        .argParser(parsePositiveInt),
    )
    .option('--no-exif', 'skip reading EXIF dates and camera models')
    .option('--no-videos', 'ignore video files')
    .addOption(
      new Option('--min-size <size>', 'ignore files smaller than this (e.g. 10k, 1M)')
        .default(10 * 1024, '10k')
        .argParser(parseSize),
    )
    .option('--include-system', 'also walk /System, /Applications, /Library and ~/Library')
    .option('--exclude <glob>', 'skip directories matching this relpath glob (repeatable)', collect)
    .option('--fast-apfs', 'APFS: skip directories unchanged since an earlier snapshot (heuristic)')
    .option('--keep-mounted', 'leave the bundle attached when done')
    .option('--password-stdin', 'read the encryption password from stdin')
    .action(async (bundle, opts, cmd) => {
      const db = dbFrom(cmd);
      const { att, release } = await ensureAttached(db, bundle, opts);
      const intr = interruptible();
      const line = statusLine();
      const started = Date.now();
      try {
        const res = await scanBundle(db, att, {
          only: opts.snapshot,
          latest: opts.latest,
          rescan: opts.rescan,
          concurrency: opts.concurrency,
          exif: opts.exif,
          videos: opts.videos,
          minSize: opts.minSize,
          includeSystem: opts.includeSystem,
          excludes: (opts.exclude ?? []).map(globToRegExp),
          fastApfs: opts.fastApfs,
          signal: intr.signal,
          log: err,
          onProgress: (p) => {
            const msg =
              `[${p.index}/${p.total}] ${p.snapshot}: ${p.dirs.toLocaleString('en-US')} dirs, ` +
              `${p.filesSeen.toLocaleString('en-US')} files seen, ${p.filesNew.toLocaleString('en-US')} new` +
              (p.dirsSkipped
                ? `, ${p.dirsSkipped.toLocaleString('en-US')} unchanged dirs skipped`
                : '') +
              (p.errors ? `, ${p.errors} errors` : '');
            if (p.done) line.end(msg);
            else line.update(msg);
          },
        });
        const s = summary(db);
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        err(
          `${res.aborted ? 'Stopped' : 'Done'} in ${secs}s. Index now holds ` +
            `${s.files.toLocaleString('en-US')} unique files (${formatBytes(s.bytes)}).` +
            (res.aborted ? ' Run the same command again to resume.' : ''),
        );
        if (res.aborted) process.exitCode = 130;
      } finally {
        intr.dispose();
        await release();
      }
    });

  program
    .command('report')
    .description('write an HTML report of indexed photos grouped by folder')
    .option('-o, --out <file>', 'output file', 'tmphotos-report.html')
    .option('--bundle <name>', 'only include this bundle (file name)')
    .option('--open', 'open the report in the default browser')
    .action(async (opts, cmd) => {
      const db = dbFrom(cmd);
      const html = renderReport(db, { bundle: opts.bundle });
      fs.writeFileSync(opts.out, html);
      const s = summary(db);
      out(
        `Wrote ${path.resolve(opts.out)} (${s.files.toLocaleString('en-US')} files, ${formatBytes(s.bytes)})`,
      );
      if (opts.open) {
        const { run } = await import('./exec.js');
        await run('open', [opts.out]);
      }
    });

  program
    .command('extract')
    .description('copy selected folders out of a bundle, preserving dates and verifying checksums')
    .argument('<bundle>', 'path to a .sparsebundle or .backupbundle')
    .requiredOption('--to <dir>', 'target directory')
    .option('--folder <prefix>', 'folder or library relpath to extract (repeatable)', collect)
    .option('--select <file>', 'selection file downloaded from the report')
    .option('--originals-only', 'skip edited versions inside photo libraries')
    .option('--no-videos', 'skip video files')
    .option('-n, --dry-run', 'show what would be copied')
    .option('--keep-mounted', 'leave the bundle attached when done')
    .option('--password-stdin', 'read the encryption password from stdin')
    .action(async (bundle, opts, cmd) => {
      const db = dbFrom(cmd);
      const bundlePath = resolveBundlePath(bundle);
      const row = findBundle(db, bundlePath);
      if (!row) throw new Error(`${bundle} has not been scanned yet; run "tmphotos scan" first`);
      /** @type {{ bundle: string | null, prefix: string }[]} */
      const selection = [];
      if (opts.select) selection.push(...parseSelection(fs.readFileSync(opts.select, 'utf8')));
      for (const f of opts.folder ?? [])
        selection.push({ bundle: null, prefix: f.replace(/^\/+|\/+$/g, '') });
      if (!selection.length) throw new Error('Nothing selected: pass --folder or --select');
      const files = selectFiles(db, row.id, row.name, selection, opts);
      const total = files.reduce((a, f) => a + f.size, 0);
      err(`${files.length.toLocaleString('en-US')} files selected (${formatBytes(total)})`);
      if (opts.dryRun) {
        for (const f of files) out(f.relpath);
        return;
      }
      if (!files.length) return;
      const { att, release } = await ensureAttached(db, bundlePath, opts);
      const intr = interruptible();
      const line = statusLine();
      try {
        const res = await extractFiles(db, att, files, {
          target: opts.to,
          signal: intr.signal,
          log: (m) => {
            line.end();
            err(m);
          },
          onProgress: (p) =>
            line.update(
              `${p.done}/${p.total} files, ${formatBytes(p.bytes)} — ${p.copied} copied, ` +
                `${p.skipped} already present, ${p.failed} failed`,
            ),
        });
        line.end(
          `${res.copied} copied, ${res.skipped} already present, ${res.failed} failed → ` +
            `${path.join(res.targetRoot, att.bundle.name.replace(/\.(sparsebundle|backupbundle)$/i, ''))}`,
        );
        if (res.failed) process.exitCode = 1;
        if (intr.signal.aborted) process.exitCode = 130;
      } finally {
        intr.dispose();
        await release();
      }
    });

  program
    .command('unmount')
    .alias('detach')
    .description('unmount snapshots and detach a bundle')
    .argument('[bundle]', 'path to a .sparsebundle or .backupbundle')
    .option('--all', 'detach every bundle tmphotos attached')
    .option('-f, --force', 'force detach even if files are open')
    .action(async (bundle, opts, cmd) => {
      const db = dbFrom(cmd);
      /** @type {string[]} */
      let targets;
      if (opts.all) {
        targets = /** @type {any[]} */ (
          db.prepare('SELECT b.path FROM mounts m JOIN bundles b ON b.id = m.bundle_id').all()
        ).map((r) => r.path);
      } else if (bundle) {
        targets = [bundle];
      } else {
        throw new Error('Pass a bundle path or --all');
      }
      for (const t of targets) {
        const r = await detach(db, t, { force: opts.force });
        out(`${r.detached ? 'Detached' : 'Not attached:'} ${t}`);
      }
    });

  program
    .command('status')
    .description('show indexed bundles, scan progress and current mounts')
    .action(async (opts, cmd) => {
      const db = dbFrom(cmd);
      const s = summary(db);
      out(`Index: ${cmd.optsWithGlobals().db ?? defaultDbPath()}`);
      out(`${s.files.toLocaleString('en-US')} unique files, ${formatBytes(s.bytes)}`);
      const mounts = /** @type {any[]} */ (
        db.prepare('SELECT b.path, m.* FROM mounts m JOIN bundles b ON b.id = m.bundle_id').all()
      );
      for (const b of s.bundles) {
        const m = mounts.find((x) => x.path.endsWith(`/${b.name}`));
        out(
          `  ${b.name} [${b.format ?? '?'}] ${b.scanned}/${b.snapshots} snapshots scanned, ` +
            `${Number(b.files).toLocaleString('en-US')} files${m ? ` — mounted at ${m.mount_point}` : ''}`,
        );
      }
    });

  return program;
}

/** @param {string[]} argv */
export async function main(argv) {
  if (process.platform !== 'darwin') {
    err('tmphotos needs macOS (it uses hdiutil, diskutil and mount_apfs).');
    process.exitCode = 1;
    return;
  }
  try {
    await buildProgram().parseAsync(argv);
  } catch (e) {
    err(`tmphotos: ${/** @type {Error} */ (e).message}`);
    process.exitCode = process.exitCode || 1;
  }
}
