import { spawn } from 'node:child_process';

/**
 * Error thrown when an external command exits non-zero.
 */
export class CommandError extends Error {
  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {number | null} code
   * @param {string} stdout
   * @param {string} stderr
   */
  constructor(cmd, args, code, stdout, stderr) {
    const detail = (stderr || stdout).trim();
    super(`${cmd} ${args.join(' ')} exited with code ${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'CommandError';
    this.cmd = cmd;
    this.args = args;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Run a command and capture its output. Never goes through a shell.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string, inheritStdin?: boolean, inheritStderr?: boolean, allowFailure?: boolean }} [opts]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const stdin = opts.inheritStdin ? 'inherit' : 'pipe';
    const stderr = opts.inheritStderr ? 'inherit' : 'pipe';
    const child = spawn(cmd, args, { stdio: [stdin, 'pipe', stderr] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr?.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !opts.allowFailure) {
        reject(new CommandError(cmd, args, code, out, err));
      } else {
        resolve({ code, stdout: out, stderr: err });
      }
    });
    if (child.stdin) {
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    }
  });
}

/**
 * Convert an XML/binary plist string to a JS value using macOS `plutil`.
 *
 * @param {string} plistText
 * @returns {Promise<any>}
 */
export async function parsePlist(plistText) {
  const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: plistText,
  });
  return JSON.parse(stdout);
}

/**
 * Run a command that prints a plist on stdout and parse it.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {Parameters<typeof run>[2]} [opts]
 */
export async function runPlist(cmd, args, opts) {
  const { stdout } = await run(cmd, args, opts);
  // hdiutil may print non-plist chatter before the XML; trim to the document.
  const start = stdout.indexOf('<?xml');
  return parsePlist(start >= 0 ? stdout.slice(start) : stdout);
}
