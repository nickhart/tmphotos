# Status

_Last updated: 2026-11-21_

## Summary

`tmphotos` 0.1.0 has every planned subcommand (`bundles`, `mount`, `scan`, `report`,
`extract`, `unmount`, `status`). It passes its full test suite on macOS, including an
integration test that drives real `hdiutil`. It has completed a full scan of a real 52-snapshot HFS+
Time Machine bundle on a NAS share (results below). APFS `.backupbundle` support is still
untested against real data.

## What is verified

| Area                                                                     | How                                   | Result     |
| ------------------------------------------------------------------------ | ------------------------------------- | ---------- |
| Read-only attach, `EROFS` on write                                       | integration test (real `hdiutil`)     | ✅         |
| Bundle byte-for-byte unchanged                                           | fingerprint before/after full cycle   | ✅         |
| HFS+ snapshot discovery (multi-machine)                                  | unit + integration                    | ✅         |
| Unique-file dedup via hard links                                         | integration (2 snapshots, hard links) | ✅         |
| Resume after interrupted snapshot                                        | integration (aborted scan → rescan)   | ✅         |
| EXIF date/camera (JPEG)                                                  | unit + integration                    | ✅         |
| iPhoto library detection, roles                                          | integration                           | ✅         |
| Skip rules (system, ~/Library, .app, thumbnails, min size, `._`)         | unit + integration                    | ✅         |
| Report grouping, roll-up, selection                                      | unit + manual check in a browser      | ✅         |
| Extract: SHA-256 verify, mtime, birthtime, collisions, idempotent re-run | unit + integration                    | ✅         |
| Refuse extract target inside source                                      | unit + integration                    | ✅         |
| CLI end to end on a fixture bundle                                       | manual run                            | ✅         |
| APFS snapshot list / mount-output parsing                                | unit (parsers only)                   | ✅         |
| APFS `.backupbundle` against real data                                   | —                                     | ⏳ not yet |
| Real HFS+ bundle on a network share                                      | full scan, report (see below)         | ✅         |

## First real-bundle attempt (2026-11-21)

Share: AFP share from a NAS (mounted at `/Volumes/backups`), with three HFS+-style `.sparsebundle`
and two `.backupbundle` images. Test target: the smallest by history, an HFS+ bundle with 52
snapshots (Nov 2015 – Jan 2016).

Findings:

1. **Dirty journal.** The volume is case-sensitive journaled HFS+, and its last backup never
   finished (`Results.plist` still says `Running`). `hdiutil attach -readonly` fails with
   "no mountable file systems" because a read-only mount can't replay the journal.
   _Fixed:_ `attach` now falls back to `hdiutil attach -nomount` and mounts the volume itself
   with `mount_hfs -o rdonly,nobrowse`, then `mount_hfs -j` (ignore journal) if needed. The
   device is still read-only. Verified by hand: the volume mounted and showed `Backups.backupdb`.
2. **macOS privacy protection (TCC).** Listing `Backups.backupdb` returned `EPERM` ("Operation
   not permitted"). Time Machine data needs Full Disk Access for the app running the tool. On a
   later attempt even opening the raw device (`/dev/rdiskNs2`) for `mount_hfs` returned `EPERM`.
   Running from iTerm gave the same result. The unified log shows why: `tccd` checked
   `kTCCServiceSystemPolicyAllFiles` (Full Disk Access) for iTerm2 as the responsible app of
   `mount_hfs` and denied it (`authValue=0`). It is unclear why the very first manual
   `mount_hfs -j` succeeded; every later attempt was denied.
   _Mitigated:_ `tmphotos` now checks for Full Disk Access before attaching anything, by trying
   to open the system TCC database, which only Full Disk Access apps can read. It maps
   `EPERM` from `mount_hfs` or the snapshot root to the same explanation, and detaches an image
   it attached if mounting fails. Set `TMPHOTOS_SKIP_FDA_CHECK=1` to bypass the preflight.
3. Listing a bundle's `bands/` directory over AFP is very slow (minutes). `tmphotos` never does
   this; snapshot counts come from the mounted filesystem.

### Result after granting Full Disk Access

With Full Disk Access granted to the terminal, `tmphotos scan` attached the bundle read-only
(through the dirty-journal fallback), scanned all 52 snapshots, and detached it:

| Measure                | Value                                                             |
| ---------------------- | ----------------------------------------------------------------- |
| Total time             | 658 s over AFP                                                    |
| First (full) snapshot  | 648 s; 16,412 unique files                                        |
| Remaining 51 snapshots | ~10 s together; 16 new files; unchanged dirs skipped by inode     |
| Index                  | 16,428 unique files, 66.1 GB (15,670 images, 408 RAW, 350 videos) |
| Photo libraries found  | 5 (3 iPhoto, 2 Aperture)                                          |
| EXIF                   | 7,545 dated/camera read, 10 parse errors, 0 walk errors           |
| Report                 | 7,888 folders; roll-up to depth 5 gives ~20 rows                  |

Observations from the real data:

- Directory hard links are what make HFS+ incremental scans fast: most later snapshots walked
  only 2 directories.
- The home folder contained nested copies of an older home (`Users/<u>/<u>/…` and
  `Users/<u>/Documents/<u>/…`). These are real copies, not hard links, so they are counted
  twice. Content hashing (roadmap) would catch this.
- The `~/Library` skip applies only at the real home's depth, so a nested old home's
  `Library` (Mail attachments, app media caches) is indexed. It shows up as separate folders in
  the report and can simply be left unselected.
- `.dropbox.cache` was indexed; it is now skipped.

## Known limitations

- **APFS snapshots** are mounted with `mount_apfs -s`, which macOS may refuse without Full Disk
  Access or root. This is untested against a real `.backupbundle`.
- **Some `.sparsebundle` files contain APFS.** Newer macOS versions write APFS inside a
  `.sparsebundle` (backing-store v2 with a `mapped` directory). The format is detected from
  the volume, not the file extension, so this should work, but it is untested.
- Without `--fast-apfs`, every APFS snapshot is walked in full. Over a slow network that
  is O(snapshots × files).
- Dedup is per bundle. The same photo in two different bundles (an old Mac and its successor)
  is counted in each.
- Files inside a Photos library (`originals/…/UUID.heic`) are extracted with their on-disk
  names; the original file names and album structure live in the library's database.
- The report does not show a "last seen" snapshot (when a photo disappeared): HFS+ directory
  skipping makes that expensive to track precisely.
- The creation date of extracted files is restored by setting the mtime twice (a macOS
  behavior); other metadata (Finder tags, extended attributes) is not copied.

## Roadmap

- [x] Complete the real HFS+ test on the NAS bundle.
- [ ] Real APFS `.backupbundle` test; document whether `mount_apfs -s` needs root.
- [ ] Optional content hashing in `scan` (`--hash`) for cross-bundle and copied-folder dedup.
- [ ] Detect nested copies of old home folders and apply the `~/Library` skip to them.
- [ ] Read `Photos.sqlite` / `AlbumData.xml` to restore original names and albums on extract.
- [ ] `extract --flatten-by-date` (YYYY/MM folders from the EXIF date).
- [ ] Copy extended attributes and Finder tags.
- [ ] Publish to npm.
