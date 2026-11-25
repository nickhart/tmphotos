# tmphotos

[![CI](https://github.com/nickhart/tmphotos/actions/workflows/ci.yml/badge.svg)](https://github.com/nickhart/tmphotos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](#requirements)
[![Code style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io)

**Find and rescue photos from old Time Machine backups, without changing them.**

`tmphotos` is a macOS command-line tool that opens Time Machine network backups (HFS+
`.sparsebundle` and APFS `.backupbundle`) **read-only**, walks every backup snapshot inside them,
and builds a SQLite index of photos, RAW files, videos and Photos / iPhoto / Aperture libraries.
Each unique file is counted once, no matter how many snapshots contain it. You get an HTML report
grouped by folder (counts, sizes, date ranges, EXIF capture dates and cameras), pick the folders
you want, and `tmphotos` copies them out with their dates kept and every copy checksum-verified.

Example session (illustrative numbers):

```text
$ tmphotos scan "/Volumes/backups/Old MacBook.sparsebundle"
Attached Old MacBook.sparsebundle read-only at ~/.tmphotos/mnt/Old MacBook/Time Machine Backups
212 snapshot(s) in bundle, 212 selected, 0 already scanned, 212 to scan
[1/212] Old-MacBook/2011-03-02-101544: 48,211 dirs, 23,904 files seen, 23,904 new
[2/212] Old-MacBook/2011-03-09-094410: 1,032 dirs, 312 files seen, 41 new, 3,877 unchanged dirs skipped
...
```

## Contents

- [Why](#why)
- [Safety](#safety)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [How it works](#how-it-works)
- [What gets indexed](#what-gets-indexed)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Status and roadmap](#status-and-roadmap)
- [License](#license)

## Why

Old Time Machine disks and NAS shares hold years of hourly, daily and weekly snapshots from Macs
that are long gone. Browsing them in Finder is slow, the Time Machine UI only works for the
current Mac, and the same photo shows up in hundreds of snapshots. `tmphotos` answers "what
photos are in here, and where?" and then gets them out safely.

## Safety

Recovering data must never put the source at risk. `tmphotos`:

- attaches bundles with `hdiutil attach -readonly -nobrowse -noverify -noautofsck -noautoopen`
  (no shadow file, no fsck repairs, no Finder, no Spotlight indexing);
- mounts an HFS+ volume with a dirty journal using `mount_hfs -o rdonly` (ignoring the journal
  rather than replaying it), on a device that is itself read-only;
- mounts APFS snapshots with `mount_apfs -o rdonly,nobrowse`;
- refuses to reuse an image that something else has attached read-write;
- opens source files with read-only flags only;
- refuses an `extract --to` target inside the bundle, its mount point or the tmphotos mount root;
- has an integration test that fingerprints every file in a test bundle (content, size and
  mtime) before and after a full mount → scan → extract → unmount cycle and asserts it is
  byte-for-byte unchanged.

Your index, mount points and nothing else live in `~/.tmphotos/` (override with
`TMPHOTOS_HOME`).

## Requirements

- macOS (uses `hdiutil`, `diskutil`, `mount_apfs`, `plutil`)
- Node.js **22.13 or newer** (uses the built-in `node:sqlite`; no native modules to compile)
- The share holding your backups, mounted in Finder (SMB or AFP), e.g. `/Volumes/backups`
- For encrypted backups: the backup password

## Install

```bash
npm install -g github:nickhart/tmphotos
```

Or from a clone:

```bash
git clone https://github.com/nickhart/tmphotos.git
cd tmphotos
npm install
npm link
```

## Quick start

```bash
# 1. See what is on the share
tmphotos bundles /Volumes/backups

# 2. Attach one read-only and list its snapshots
tmphotos mount "/Volumes/backups/Old MacBook.sparsebundle"

# 3. Index every snapshot (Ctrl-C any time; re-run to resume)
tmphotos scan "/Volumes/backups/Old MacBook.sparsebundle"

# 4. Browse the results, tick folders, click "Download selection"
tmphotos report --open

# 5. Copy the selected folders out, dates preserved, checksums verified
tmphotos extract "/Volumes/backups/Old MacBook.sparsebundle" \
  --select ~/Downloads/selection.txt --to ~/Pictures/Recovered

# 6. Detach
tmphotos unmount --all
```

## Commands

All commands accept `--db <path>` (default `~/.tmphotos/index.sqlite`, or `$TMPHOTOS_DB`).

### `tmphotos bundles <dir>`

Lists the `.sparsebundle` / `.backupbundle` files directly inside a directory.

### `tmphotos mount <bundle>`

Attaches a bundle read-only, records it in the index, and lists its snapshots and their scan
status.

| Option             | Description                             |
| ------------------ | --------------------------------------- |
| `--password-stdin` | Read the encryption password from stdin |
| `--json`           | Machine-readable output                 |

Without `--password-stdin`, `hdiutil` asks for the password of an encrypted bundle itself (or
uses one saved in your keychain).

### `tmphotos scan <bundle>`

Walks every snapshot and indexes media files and photo libraries. Attaches the bundle if needed
and detaches it again afterwards (unless it was already attached or you pass `--keep-mounted`).

| Option                  | Default | Description                                                    |
| ----------------------- | ------- | -------------------------------------------------------------- |
| `--latest`              |         | Only scan the most recent snapshot                             |
| `--snapshot <name>`     |         | Only scan this snapshot, e.g. `2012-03-04-120000` (repeatable) |
| `--rescan`              |         | Re-walk snapshots already marked as scanned                    |
| `-j, --concurrency <n>` | `8`     | Parallel directory listings                                    |
| `--no-exif`             |         | Don't read EXIF capture dates and camera models                |
| `--no-videos`           |         | Ignore video files                                             |
| `--min-size <size>`     | `10k`   | Ignore smaller files (icons, thumbnails)                       |
| `--include-system`      |         | Also walk `/System`, `/Applications`, `/Library`, `~/Library`  |
| `--exclude <glob>`      |         | Skip matching directories, e.g. `'**/node_modules'`            |
| `--fast-apfs`           |         | APFS: skip directories unchanged since an earlier snapshot     |
| `--keep-mounted`        |         | Leave the bundle attached when done                            |
| `--password-stdin`      |         | Read the encryption password from stdin                        |

Scanning is **resumable**. Each snapshot is marked done when finished, and writes are committed
every few seconds. After an interruption (Ctrl-C, sleep, a dropped share) run the same command
again: finished snapshots are skipped and the interrupted one is walked again (inserts are
idempotent, so nothing is counted twice).

### `tmphotos report`

Writes a single self-contained HTML file (no network access needed to view it).

| Option             | Default                | Description                 |
| ------------------ | ---------------------- | --------------------------- |
| `-o, --out <file>` | `tmphotos-report.html` | Output path                 |
| `--bundle <name>`  |                        | Only include this bundle    |
| `--open`           |                        | Open in the default browser |

The report shows totals, each bundle with its snapshot range, every photo library found, and a
table of folders with:

- unique file count (hover for the image / RAW / video / edited breakdown) and total size;
- file modification date range;
- EXIF capture date range (with how many files had one);
- the most common cameras.

You can filter by path or camera, sort any column, **roll folders up to a chosen depth**
(e.g. depth 4 turns `Macintosh HD/Users/me/Pictures/*` into one row), tick rows, and download
the ticked rows as `selection.txt` for `extract`.

### `tmphotos extract <bundle> --to <dir>`

Copies the selected files to `<dir>/<bundle name>/<original path>`.

| Option              | Description                                         |
| ------------------- | --------------------------------------------------- |
| `--to <dir>`        | Target directory (required)                         |
| `--folder <prefix>` | Folder or library path from the report (repeatable) |
| `--select <file>`   | Selection file downloaded from the report           |
| `--originals-only`  | Skip edited versions inside photo libraries         |
| `--no-videos`       | Skip videos                                         |
| `-n, --dry-run`     | List what would be copied                           |
| `--keep-mounted`    | Leave the bundle attached when done                 |

For every file `extract`:

1. checks the source still matches the index (size and mtime);
2. streams it to `<name>.tmphotos-partial` while computing SHA-256, then `fsync`s;
3. re-reads the copy and compares SHA-256, and only then renames it into place;
4. restores the modification time and, on macOS, the creation date;
5. records the destination and hash in the index.

Re-running is safe: files already extracted are skipped. If a different file already has the
same name (e.g. two versions of `IMG_0002.jpg` from different snapshots) the newcomer becomes
`IMG_0002 (1).jpg`. `extract` checks free space on the target before it starts.

### `tmphotos unmount [bundle]` (alias `detach`)

Unmounts any APFS snapshots tmphotos mounted, then detaches the image. `--all` detaches every
bundle tmphotos attached; `-f, --force` forces it if something still has files open.

### `tmphotos status`

Shows the index location, totals, scan progress per bundle and current mounts.

## How it works

**HFS+ `.sparsebundle`** (network backups made before macOS 11): the image holds
`Backups.backupdb/<Mac name>/<YYYY-MM-DD-HHMMSS>/<volume>/…`. Time Machine hard-links unchanged
files, and also unchanged _directories_, from one snapshot to the next. A hard-linked file keeps
its inode, so `tmphotos` identifies a file by `(inode, size, mtime)` within a bundle and counts
it once. A hard-linked directory means the whole subtree is identical, so once a directory's
inode has been walked in a finished snapshot it is skipped in later ones. That makes scanning
hundreds of snapshots close to the cost of scanning one plus the changes.

**APFS `.backupbundle`** (macOS 11 and later): each backup is an APFS snapshot named
`com.apple.TimeMachine.<date>.backup`. `tmphotos` lists them with `diskutil apfs listSnapshots`
and mounts each one read-only in turn with `mount_apfs -s`. Unchanged files are the same object
in every snapshot, so the same `(inode, size, mtime)` identity applies. APFS directories keep
their inode when their contents change, so every snapshot is walked in full by default;
`--fast-apfs` skips directories whose inode and mtime match an earlier snapshot. That is much
faster but can miss a file rewritten in place without its directory changing.

The index is a single SQLite file: `bundles`, `snapshots` (with scan status), `libraries`,
`files` (one row per unique file, with the first snapshot it appeared in, EXIF date and
camera), `walked_dirs` and `extractions`. Open it with any SQLite tool to run your own queries.

## What gets indexed

- **Images**: jpg, jpeg, png, gif, heic, heif, tif, tiff, bmp, webp, psd, jp2
- **RAW**: cr2, cr3, crw, nef, nrw, arw, srf, sr2, dng, orf, rw2, raf, srw, pef, x3f, 3fr, erf,
  kdc, mrw, rwl
- **Video** (unless `--no-videos`): mov, mp4, m4v, avi, 3gp, 3g2, mts, m2ts, mpg, mpeg, wmv, mkv
- **Libraries**: `*.photoslibrary` (Photos), `*.photolibrary`, `iPhoto Library`,
  `*.migratedphotolibrary` (iPhoto), `*.aplibrary` (Aperture). Inside a library, originals
  (`Masters`, `Originals`, `originals`) are indexed, edited versions (`Modified`,
  `resources/renders`) are indexed and marked _edited_, and thumbnails, previews, face crops and
  databases are skipped.

Skipped by default: files under 10 KB, the volume's `/System`, `/Applications`, `/Library`,
`/private` and other system folders, each user's `~/Library` (caches, app data, Mail and
Messages attachments: use `--include-system` to include them), app and framework bundles,
`node_modules`, `.git`, caches, and `._` AppleDouble files.

## Troubleshooting

**"Operation not permitted" / "macOS blocked access to … Backups.backupdb"**: Time Machine
data is protected by macOS privacy controls. Give the app you run `tmphotos` from (Terminal,
iTerm, VS Code, …) Full Disk Access in System Settings → Privacy & Security → Full Disk Access,
then quit and reopen that app. Without it, macOS also refuses to let `mount_hfs` open the
attached disk device. `mount`, `scan` and `extract` check for Full Disk Access up front and stop
with this message before attaching anything. If the check misfires on your system, set
`TMPHOTOS_SKIP_FDA_CHECK=1`.

**"no mountable file systems"**: usually an HFS+ backup whose last backup was interrupted,
which leaves the journal dirty, and a read-only mount can't replay it. `tmphotos` handles this
automatically: it attaches without mounting and mounts the volume read-only with `mount_hfs`,
ignoring the journal if it must. `mount` prints a note when that happened. The newest,
unfinished backup may be incomplete; the finished ones are unaffected.

**"macOS refused to mount APFS snapshot …"**: macOS restricts mounting snapshots. Give your
terminal app Full Disk Access (System Settings → Privacy & Security → Full Disk Access) and try
again. Running with `sudo` also works, but then point `--db` and `TMPHOTOS_HOME` at your own
paths so the index isn't owned by root.

**"… is already attached read-write by something else"**: Finder or Time Machine opened the
bundle. Eject it in Finder (or `hdiutil detach /dev/diskN`) and re-run; tmphotos will attach it
read-only.

**The scan is slow**: network round trips dominate. Use a wired connection, raise
`--concurrency` (try 16 to 32), and scan `--latest` first to get a quick picture. HFS+ bundles
speed up a lot after the first snapshot.

**Permission errors in the scan summary**: some folders in old backups have restrictive ACLs.
They are counted as `errors` per snapshot; the rest of the scan continues.

**A share mounted somewhere else now** (e.g. `/Volumes/backups-1`): bundles are matched by
their filesystem UUID, so the index follows them to the new path.

## Development

```bash
npm install
npm test            # unit tests + an hdiutil integration test (macOS)
npm run lint
npm run format
```

The integration test (`test/integration.test.js`) builds a small HFS+ sparsebundle shaped like
a Time Machine backup, with two snapshots, hard links, an iPhoto library, EXIF-tagged JPEGs and
files that should be skipped. It then runs the whole pipeline against it with real `hdiutil`.
CI runs it on GitHub's macOS runners for Node 22 and 24.

Contributions welcome: please open an issue first for anything large, and keep `npm run check`
green.

## Status and roadmap

See [STATUS.md](STATUS.md) for what has been tested against real backups and what is planned.

## License

[MIT](LICENSE) © 2026 Nick Hart
