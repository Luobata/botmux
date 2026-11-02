import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, symlinkSync, rmSync, realpathSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const attack = vi.hoisted(() => ({ run: undefined as undefined | ((path: string, flags: number) => void) }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: ((...args: Parameters<typeof fs.openSync>) => {
    const fd = fs.openSync(...args);
    try { attack.run?.(String(args[0]), Number(args[1])); }
    catch (error) { fs.closeSync(fd); throw error; }
    return fd;
  }) as typeof fs.openSync };
});
import { provisionDeployWorkerHome } from '../src/core/deploy-worker-home.js';

const roots: string[] = [];
afterEach(() => { attack.run = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('cannot write through a parent swapped after its directory descriptor is opened', () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-home-race-')); roots.push(root);
  const template = join(root, 'deploy-worker-profile', 'codex'); mkdirSync(template, { recursive: true, mode: 0o700 });
  for (const name of ['config.toml', 'auth.json']) writeFileSync(join(template, name), 'fixed-' + name, { mode: 0o600 });
  const home = provisionDeployWorkerHome(root, 'session');
  const external = join(root, 'other-session'); mkdirSync(external);
  for (const name of ['config.toml', 'auth.json']) writeFileSync(join(external, name), 'untouched-' + name);
  let attacked = false;
  attack.run = (path, flags) => {
    if (attacked || !(flags & constants.O_DIRECTORY) || !path.endsWith('/codex') || realpathSync(path) !== join(home, 'codex')) return;
    attacked = true;
    renameSync(join(home, 'codex'), join(home, 'old-codex'));
    symlinkSync(external, join(home, 'codex'));
  };
  expect(() => provisionDeployWorkerHome(root, 'session')).toThrow('unsafe');
  expect(attacked).toBe(true);
  for (const name of ['config.toml', 'auth.json']) expect(readFileSync(join(external, name), 'utf8')).toBe('untouched-' + name);
});

it('replaces a leaf swapped after validation without overwriting its link target', () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-leaf-race-')); roots.push(root);
  const template = join(root, 'deploy-worker-profile', 'codex'); mkdirSync(template, { recursive: true, mode: 0o700 });
  for (const name of ['config.toml', 'auth.json']) writeFileSync(join(template, name), 'fixed-' + name, { mode: 0o600 });
  const home = provisionDeployWorkerHome(root, 'session');
  const external = join(root, 'external'); writeFileSync(external, 'untouched');
  let attacked = false;
  attack.run = (path, flags) => {
    if (attacked || !(flags & constants.O_EXCL) || !path.includes('.config.toml.')) return;
    attacked = true;
    rmSync(join(home, 'codex', 'config.toml'));
    symlinkSync(external, join(home, 'codex', 'config.toml'));
  };
  provisionDeployWorkerHome(root, 'session');
  expect(attacked).toBe(true);
  expect(readFileSync(external, 'utf8')).toBe('untouched');
  expect(readFileSync(join(home, 'codex', 'config.toml'), 'utf8')).toBe('fixed-config.toml');
});
