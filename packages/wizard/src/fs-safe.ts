import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/** A path the wizard refuses to read or write; `path` is the one refused, relative to the root it was given with. */
export class PathError extends Error { constructor(message: string, readonly path?: string) { super(message); } }

/**
 * Every path the wizard touches must resolve to a place inside the app folder without ever following a
 * symlink: the wizard never needs to write through one, so any symlink anywhere along the path — the
 * leaf, a parent directory, dangling or pointing at a real file outside the project — is refused.
 *
 * This walks the path component by component from the real root using lstatSync, which reports a
 * symlink as a symlink without following it. That matters specifically for a *dangling* symlink leaf
 * (pointing at a target that does not exist yet): existsSync and realpathSync both report "not found"
 * for it, which is indistinguishable from the leaf itself not existing. A probe that climbs to the
 * nearest existing ancestor and compares realpaths — the earlier approach here — climbs straight past
 * such a link to the project root and never inspects the link itself, so it never refuses it. Checking
 * each component with lstatSync first closes that gap: the dangling link is seen and refused before its
 * target is ever considered.
 */
export function resolveInside(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new PathError(`Refusing path ${rel}`, rel);
  const realRoot = realpathSync(root);
  let dir = realRoot;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    const p = join(dir, part);
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      dir = p; // does not exist yet (nor does anything under it) — nothing left to check
      continue;
    }
    if (st.isSymbolicLink()) throw new PathError(`Refusing ${rel}: it points outside the project folder`, rel);
    dir = p;
  }
  return dir;
}

export function readInside(root: string, rel: string, maxBytes = 1_000_000): string | null {
  const p = resolveInside(root, rel);
  if (!existsSync(p)) return null;
  if (statSync(p).size > maxBytes) throw new PathError(`${rel} is larger than ${maxBytes} bytes; edit it by hand`, rel);
  return readFileSync(p, "utf8");
}

/**
 * Opened with O_NOFOLLOW so a symlink swapped in for the leaf after resolveInside's lstat check (a
 * TOCTOU race) is refused at write time too, rather than followed. O_NOFOLLOW is POSIX; Node on Windows
 * rejects it (ENOTSUP), so Windows instead gets an lstat check immediately before the write — same
 * intent, best available primitive for that platform.
 * `mode` applies only when the file is created (as with open(2)'s O_CREAT, and further limited by the umask); an
 * existing file keeps its own mode. Windows has no such permission bits, so it is ignored there. A file about to hold
 * a secret is written with writeSecretInside() instead.
 */
export function writeInside(root: string, rel: string, content: string, mode = 0o644): void {
  const p = resolveInside(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  if (process.platform === "win32") {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new PathError(`Refusing to write ${rel}: it is a symlink`, rel);
    writeFileSync(p, content);
    return;
  }
  const fd = openSync(p, fsConstants.O_NOFOLLOW | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC, mode);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a file that is about to hold a secret (.env.local under --local-key) by replacing it whole, never by changing
 * it in place: the content goes to a new file in the same folder, created for this write only (a random name, O_EXCL
 * and O_NOFOLLOW, so nothing already there is opened or followed), readable only by its owner; it is flushed to disk,
 * then renamed over the target. If anything fails (the folder takes no new file, the disk is full, the rename is
 * refused), the new file is removed and the target is exactly as it was, every variable in it kept. The result
 * belongs to the person running the wizard, whoever owned the old file. The rename replaces a symlink swapped in
 * after the check instead of writing through it. Windows: the same, without the mode (it has no such bits).
 */
export function writeSecretInside(root: string, rel: string, content: string): void {
  const p = resolveInside(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = resolveInside(root, join(dirname(rel), `.${basename(rel)}.${randomBytes(8).toString("hex")}.tmp`));
  const win = process.platform === "win32";
  // Outside the cleanup below: if the name somehow exists, it is not this write's file to remove.
  const fd = openSync(tmp, win ? "wx" : fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try {
    try {
      // Exactly owner-only, whatever the umask; on this write's own file, so it cannot be refused.
      if (!win) fchmodSync(fd, 0o600);
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
export function deleteInside(root: string, rel: string): void {
  rmSync(resolveInside(root, rel), { force: true });
}

/** Removes the folder `rel` inside `root` when nothing is in it (never through a symlink, never the root itself).
 * Best effort: a folder that is not empty, is gone, or cannot be removed is left as it is. */
export function removeEmptyDirInside(root: string, rel: string): void {
  if (!rel.split(/[\\/]/).some((part) => part && part !== ".")) return;
  try {
    const p = resolveInside(root, rel);
    if (lstatSync(p).isDirectory() && readdirSync(p).length === 0) rmdirSync(p);
  } catch { /* left as it is */ }
}
