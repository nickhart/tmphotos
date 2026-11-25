# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-21

### Added

- `bundles`, `mount`, `scan`, `report`, `extract`, `unmount` and `status` commands.
- Read-only attach of HFS+ `.sparsebundle` and APFS `.backupbundle` Time Machine images.
- Fallback for HFS+ volumes with a dirty journal (interrupted last backup).
- Resumable scan into SQLite (`node:sqlite`) that counts each unique file once across
  snapshots and skips HFS+ directory hard links.
- EXIF capture date and camera via `exifr`; Photos / iPhoto / Aperture library detection.
- Self-contained HTML report with filtering, sorting, depth roll-up and selection export.
- Extract with SHA-256 verification and preserved modification and creation dates.
