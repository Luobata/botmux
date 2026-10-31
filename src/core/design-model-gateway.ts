import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mergeFsRules, type FsPolicy } from '../adapters/cli/fs-policy.js';

const SESSION_HOMES = '/var/lib/design-bot/session-homes';
export function designModelEnabled(appId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.DESIGN_MODEL_APP_ID && appId === env.DESIGN_MODEL_APP_ID;
}
export function designModelSessionHome(fallback: string | undefined, appId: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!designModelEnabled(appId, env)) return fallback;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('invalid design session id');
  return join(SESSION_HOMES, sessionId);
}
export function designModelHostOnlyPaths(appId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return designModelEnabled(appId, env)
    ? ['/etc/design-models', '/var/lib/design-models', '/home/yaochenghao', '/data00/home/yaochenghao'] : [];
}
/** A future session must be hidden too; enumerating today's siblings is insufficient. */
export function hardenDesignModelPolicy(policy: FsPolicy, appId: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): FsPolicy {
  if (!designModelEnabled(appId, env)) return policy;
  const own = designModelSessionHome(undefined, appId, sessionId, env)!;
  const inside = (path: string, root: string) => path === root || path.startsWith(root + '/');
  const privateRoots = designModelHostOnlyPaths(appId, env);
  const allowed = (path: string) => !privateRoots.some(root => inside(path, root))
    && (!inside(path, SESSION_HOMES) || inside(path, own));
  return { ...policy,
    rules: mergeFsRules([
      ...policy.rules.filter(rule => rule.access === 'deny' || allowed(rule.path)),
      ...[...privateRoots, SESSION_HOMES].map(path => ({ path, access: 'deny' as const, source: 'mandatory' as const })),
      { path: own, access: 'readWrite', source: 'mandatory' },
    ]),
    finalReadOnlyPaths: policy.finalReadOnlyPaths?.filter(allowed),
  };
}

type Lease = { id: string; key: string; model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' };
type Input = { appId: string; openId?: string; sessionId: string; chatId: string; cliId: string; sandbox: unknown; adopted?: boolean; requestedModel?: string; parentSessionId?: string };
/** Deployment-local, opt-in seam. Non-design bots keep their existing launch path. */
export function prepareDesignModelLease(input: Input, env: NodeJS.ProcessEnv = process.env): Lease | undefined {
  if (!designModelEnabled(input.appId, env)) return undefined;
  if (process.platform !== 'linux' || input.cliId !== 'codex' || input.sandbox !== true || input.adopted || !input.openId) {
    throw new Error('design-test requires a verified session owner and a local sandboxed Codex session');
  }
  let result: { ok?: boolean; error?: string; lease?: Lease };
  try {
    // The helper gets the private control key itself. No control credential is
    // placed in the CLI env, arguments, BotMux session store or request logs.
    result = JSON.parse(execFileSync('/opt/design-model-stack/bin/node', ['/opt/design-model-stack/bin/model-control.mjs'], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 5000, maxBuffer: 16384, stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch { throw new Error('design model gateway is unavailable'); }
  if (!result.ok || !result.lease) throw new Error(result.error ?? 'design model authorization is unavailable');
  const lease = result.lease;
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(lease.key) || !/^[A-Za-z0-9_-]{40,60}$/.test(lease.id)
    || !/^traex\/[A-Za-z0-9_.\[\]()-]+$/.test(lease.model)
    || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(lease.effort)) throw new Error('invalid design model lease');
  return lease;
}

export function maintainDesignModelLease(worker: ChildProcess, lease: Lease | undefined): void {
  if (!lease) return;
  const key = readFileSync('/etc/design-models/bot-control.key', 'utf8').trim();
  let ended = false;
  const post = async (path: string) => {
    try {
      const r = await fetch(`http://127.0.0.1:18316/control/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: lease.id }), signal: AbortSignal.timeout(4000) });
      await r.body?.cancel();
    } catch { /* The lease expires closed if the control service stays down. */ }
  };
  const timer = setInterval(() => { if (!ended && worker.exitCode === null) void post('renew'); }, 45000);
  timer.unref();
  const stop = () => { if (ended) return; ended = true; clearInterval(timer); void post('release'); };
  worker.once('exit', stop); worker.once('error', stop);
}
