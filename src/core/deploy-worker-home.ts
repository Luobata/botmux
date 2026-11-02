import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, statSync, writeFileSync, fchmodSync, fsyncSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname, extname } from 'node:path';
import type { FsPolicy } from '../adapters/cli/fs-policy.js';

interface PinnedDirectory {
  readonly fd: number;
  readonly lexicalPath: string;
}

function sameInode(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function anchor(directory: PinnedDirectory): string {
  return `/proc/self/fd/${directory.fd}`;
}

function assertSecureDirectory(fd: number, label: string, privateDirectory: boolean): void {
  const stats = fstatSync(fd);
  if (!stats.isDirectory()) throw new Error(`unsafe Deploy Worker ${label}`);
  if (process.getuid && stats.uid !== process.getuid()) throw new Error(`unsafe Deploy Worker ${label}`);
  if ((stats.mode & 0o022) !== 0 || (privateDirectory && (stats.mode & 0o077) !== 0)) {
    throw new Error(`unsafe Deploy Worker ${label}`);
  }
}

function openPinnedRoot(path: string, label: string, privateDirectory: boolean): PinnedDirectory {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    assertSecureDirectory(fd, label, privateDirectory);
    if (!sameInode(fstatSync(fd), statSync(anchor({ fd, lexicalPath: path })))) {
      throw new Error(`unsafe Deploy Worker ${label}`);
    }
    return { fd, lexicalPath: path };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openPinnedChild(
  parent: PinnedDirectory,
  name: string,
  label: string,
  privateDirectory = true,
): PinnedDirectory {
  const childPath = join(parent.lexicalPath, name);
  const childAnchor = join(anchor(parent), name);
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let fd: number | undefined;
  try {
    try {
      fd = openSync(childAnchor, flags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(childAnchor, { mode: 0o700 });
      fd = openSync(childAnchor, flags);
    }
    assertSecureDirectory(fd, label, privateDirectory);
    const pathStats = lstatSync(childPath);
    if (pathStats.isSymbolicLink() || !sameInode(fstatSync(fd), pathStats)) {
      throw new Error(`unsafe Deploy Worker ${label}`);
    }
    if (!sameInode(fstatSync(fd), statSync(anchor({ fd, lexicalPath: childPath })))) {
      throw new Error(`unsafe Deploy Worker ${label}`);
    }
    return { fd, lexicalPath: childPath };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
}

function secureRead(directory: PinnedDirectory, name: string): string | null {
  const path = join(anchor(directory), name);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (name === 'auth.json' && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile() || stats.nlink !== 1 || stats.size > 1048576
      || (process.getuid && stats.uid !== process.getuid())
      || (stats.mode & 0o077) !== 0
    ) throw new Error('unsafe Deploy Worker profile');
    const body = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (!sameInode(stats, after) || stats.size !== after.size || stats.mtimeMs !== after.mtimeMs) {
      throw new Error('unsafe Deploy Worker profile');
    }
    return body;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    closeSync(fd);
  }
}

function secureReplace(directory: PinnedDirectory, name: string, body: string): void {
  const target = join(anchor(directory), name);
  const temporary = join(anchor(directory), `.${name}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, body, 'utf8');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    fsyncSync(directory.fd);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function secureUnlink(directory: PinnedDirectory, name: string): void {
  try {
    unlinkSync(join(anchor(directory), name));
    fsyncSync(directory.fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertStillBound(directory: PinnedDirectory): void {
  const stats = fstatSync(directory.fd);
  const pathStats = lstatSync(directory.lexicalPath);
  if (pathStats.isSymbolicLink() || !sameInode(stats, pathStats)) {
    throw new Error('unsafe Deploy Worker directory');
  }
}

function closeDirectory(directory: PinnedDirectory | undefined): void {
  if (directory !== undefined) closeSync(directory.fd);
}

/** Host-owned template is never mounted. Only the current session home is writable. */
export function provisionDeployWorkerHome(dataDir: string, sessionId: string): string {
  if (process.platform !== 'linux') throw new Error('Deploy Workers require Linux file isolation');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(sessionId)) throw new Error('invalid Deploy Worker session');
  if (realpathSync(resolve(dataDir)) !== resolve(dataDir)) throw new Error('unsafe Deploy Worker state root');
  const root = openPinnedRoot(resolve(dataDir), 'state root', false);
  let profile: PinnedDirectory | undefined;
  let template: PinnedDirectory | undefined;
  let parent: PinnedDirectory | undefined;
  let home: PinnedDirectory | undefined;
  let codex: PinnedDirectory | undefined;
  try {
    profile = openPinnedChild(root, 'deploy-worker-profile', 'profile root');
    template = openPinnedChild(profile, 'codex', 'template');
    parent = openPinnedChild(root, 'deploy-worker-homes', 'home parent');
    home = openPinnedChild(parent, sessionId, 'session home');
    codex = openPinnedChild(home, 'codex', 'session Codex home');

    // Always replace fixed launch files in one pinned directory. Never resolve
    // the worker-writable home/codex names again between the two writes.
    for (const name of ['config.toml', 'auth.json']) {
      const body = secureRead(template, name);
      if (body === null) secureUnlink(codex, name);
      else secureReplace(codex, name, body);
    }
    for (const leaf of ['cache', 'state', 'config', 'data', 'npm-cache']) closeDirectory(openPinnedChild(home, leaf, 'session cache'));
    assertStillBound(home);
    assertStillBound(codex);
    return home.lexicalPath;
  } finally {
    closeDirectory(codex);
    closeDirectory(home);
    closeDirectory(parent);
    closeDirectory(template);
    closeDirectory(profile);
    closeDirectory(root);
  }
}

/**
 * Dedicated workers use explicit runtime grants, not host convenience caches/tool trees.
 * In particular /opt may resolve to a broad shared drive on devboxes.
 */
export function restrictDeployWorkerFsPolicy(policy: FsPolicy, botHome: string): FsPolicy {
  const home = resolve(botHome);
  const sharedStore = join(dirname(dirname(home)), 'session-stores');
  const fixedLaunchFiles = [
    join(home, 'codex', 'config.toml'),
    join(home, 'codex', 'auth.json'),
  ].map(path => ({ path, access: 'readOnly' as const, source: 'mandatory' as const }));
  return {
    ...policy,
    rules: [
      ...policy.rules.filter(rule =>
        (rule.access === 'deny' || (rule.path !== sharedStore && !rule.path.startsWith(sharedStore + '/')))
        && (rule.source !== 'baseline' || rule.access === 'deny' || rule.path === '/usr' || rule.path === '/etc')),
      ...fixedLaunchFiles,
    ],
  };
}

/** npm's Codex launcher loads a sibling platform package; grant that package only. */
export function deployWorkerRuntimeRoots(resolvedBin: string): string[] {
  const executable = realpathSync(resolvedBin);
  if (!['.js', '.mjs', '.cjs'].includes(extname(executable))) return [];
  const packageRoot = dirname(dirname(executable));
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@openai/codex') throw new Error('unsupported dedicated Codex launcher');
  return [packageRoot];
}

export function validateDeployWorkerDirectory(root: string, workingDir: string, chatId: string): void {
  const base = resolve(root);
  const wd = resolve(workingDir);
  const run = dirname(wd);
  if (
    !chatId.startsWith('headless_hl_') || dirname(run) !== base
    || wd !== join(run, 'workspace') || !/^[a-f0-9-]{36}$/.test(run.slice(base.length + 1))
  ) throw new Error('Deploy Workers require a controller-owned headless task workspace');
}
