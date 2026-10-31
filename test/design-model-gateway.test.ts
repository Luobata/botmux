import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('node:fs', () => ({ readFileSync: mocks.read }));
import { prepareDesignModelLease, maintainDesignModelLease, designModelSessionHome, designModelHostOnlyPaths, hardenDesignModelPolicy } from '../src/core/design-model-gateway.js';
import { buildFsPolicy, accessForPath } from '../src/adapters/cli/fs-policy.js';

const input = { appId: 'cli_design', openId: 'ou_owner', sessionId: 'session', chatId: 'chat', cliId: 'codex', sandbox: true };
const lease = { id: 'i'.repeat(43), key: 'k'.repeat(43), model: 'traex/GPT-6.1-Sol', effort: 'high' as const };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('opt-in model authorization at worker launch', () => {
  it('preserves unrelated bots, CLI families and platforms when not enabled', () => {
    expect(prepareDesignModelLease({ ...input, cliId: 'claude-code' }, {})).toBeUndefined();
    expect(prepareDesignModelLease(input, { DESIGN_MODEL_APP_ID: 'another-app' })).toBeUndefined();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it('rejects missing identity, uncontained execution and adoption before executing a helper', () => {
    for (const patch of [{ openId: undefined }, { sandbox: false }, { adopted: true }, { cliId: 'claude-code' }]) {
      expect(() => prepareDesignModelLease({ ...input, ...patch }, { DESIGN_MODEL_APP_ID: input.appId })).toThrow();
    }
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it('uses the verified owner and propagates a validated lease, with no control credential in argv', () => {
    mocks.exec.mockReturnValue(JSON.stringify({ ok: true, lease }));
    expect(prepareDesignModelLease(input, { DESIGN_MODEL_APP_ID: input.appId })).toEqual(lease);
    const [_bin, args, opts] = mocks.exec.mock.calls[0];
    expect(JSON.parse(opts.input).openId).toBe('ou_owner');
    expect(args).toHaveLength(1);
    expect(opts.timeout).toBeGreaterThan(0);
  });
  it('fails closed on service rejection, malformed result or helper failure', () => {
    for (const result of [{ ok: false, error: 'authorization_revoked' }, { ok: true, lease: { ...lease, model: 'acct_other/model' } }]) {
      mocks.exec.mockReturnValue(JSON.stringify(result));
      expect(() => prepareDesignModelLease(input, { DESIGN_MODEL_APP_ID: input.appId })).toThrow();
    }
    mocks.exec.mockImplementation(() => { throw new Error('secret helper output'); });
    expect(() => prepareDesignModelLease(input, { DESIGN_MODEL_APP_ID: input.appId })).toThrow('design model gateway is unavailable');
  });
  it('renews only while the worker lives and releases its exact lease after exit', async () => {
    vi.useFakeTimers(); mocks.read.mockReturnValue('private-control-key');
    const calls: { path: string; id: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, opts: RequestInit) => { calls.push({ path, id: JSON.parse(String(opts.body)).id }); return new Response('{}'); }));
    const worker = Object.assign(new EventEmitter(), { exitCode: null });
    maintainDesignModelLease(worker as unknown as ChildProcess, lease);
    await vi.advanceTimersByTimeAsync(90000);
    expect(calls.filter(x => x.path.endsWith('/renew')).length).toBeGreaterThan(0);
    worker.emit('exit', 0); const n = calls.length;
    await vi.advanceTimersByTimeAsync(180000);
    expect(calls).toHaveLength(n);
    expect(calls.at(-1)?.path).toMatch(/\/release$/);
    expect(calls.every(x => x.id === lease.id)).toBe(true);
  });
  it('gives each design session its own CLI data and freezes private roots against deeper user grants', () => {
    const env = { DESIGN_MODEL_APP_ID: input.appId };
    const own = designModelSessionHome('/unused', input.appId, 'session_a', env)!;
    const sibling = designModelSessionHome('/unused', input.appId, 'session_b', env)!;
    expect(own).not.toBe(sibling);
    expect(designModelSessionHome('/ordinary', 'another-app', 's', env)).toBe('/ordinary');
    const policy = buildFsPolicy({
      platform: 'linux', homeDir: '/var/lib/design-bot', botmuxHome: '/var/lib/design-bot/.botmux',
      sessionDataDir: '/var/lib/design-bot/.botmux/data', workingDir: '/var/lib/design-bot/workspace',
      currentAppId: input.appId, sessionId: 'session_a', botHome: own, redirectedCliData: true,
      hostOnlyDenyPaths: designModelHostOnlyPaths(input.appId, env),
      userPaths: { readOnly: ['/etc/design-models/bot-control.key', sibling + '/codex/sessions'] },
    });
    const hardened = hardenDesignModelPolicy(policy, input.appId, 'session_a', env);
    expect(accessForPath(hardened.rules, '/etc/design-models/bot-control.key').access).toBe('deny');
    expect(accessForPath(hardened.rules, '/var/lib/design-models/state.sqlite').access).toBe('deny');
    expect(accessForPath(hardened.rules, sibling + '/codex/sessions').access).toBe('deny');
    expect(accessForPath(hardened.rules, '/var/lib/design-bot/session-homes/future/codex').access).toBe('deny');
    expect(accessForPath(hardened.rules, own + '/codex/sessions').access).toBe('readWrite');
    expect(hardenDesignModelPolicy(policy, 'another-app', 's', env)).toBe(policy);
  });
});
