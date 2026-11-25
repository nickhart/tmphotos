import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Directory that holds the index database and mount points. */
export function stateDir() {
  const dir = process.env.TMPHOTOS_HOME || path.join(os.homedir(), '.tmphotos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function defaultDbPath() {
  return path.join(stateDir(), 'index.sqlite');
}

/** Root under which bundles and APFS snapshots get mounted. */
export function mountRoot() {
  const dir = path.join(stateDir(), 'mnt');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
