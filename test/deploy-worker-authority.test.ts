import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {dashboardSecretPath} from '../src/core/dashboard-secret.js';
import {loadOrCreateDashboardSecret} from '../src/dashboard/auth.js';
import {loadDaemonIpcSecret} from '../src/core/daemon-ipc-auth.js';
it('uses one dedicated authority key for host sender and daemon verifier without changing the fleet default',()=>{
 const root=mkdtempSync(join(tmpdir(),'deploy-authority-'));const before={state:process.env.SESSION_DATA_DIR,preserve:process.env.BOTMUX_PRESERVE_HOST_PATHS};
 try {
  process.env.SESSION_DATA_DIR=root;process.env.BOTMUX_PRESERVE_HOST_PATHS='1';
  const path=dashboardSecretPath();expect(path).toBe(join(root,'.dashboard-secret'));
  const secret=loadOrCreateDashboardSecret(path);expect(loadDaemonIpcSecret()).toBe(secret);
  delete process.env.BOTMUX_PRESERVE_HOST_PATHS;expect(dashboardSecretPath('/provided-home')).toBe('/provided-home/.botmux/.dashboard-secret');
 } finally {
  if(before.state===undefined)delete process.env.SESSION_DATA_DIR;else process.env.SESSION_DATA_DIR=before.state;
  if(before.preserve===undefined)delete process.env.BOTMUX_PRESERVE_HOST_PATHS;else process.env.BOTMUX_PRESERVE_HOST_PATHS=before.preserve;
  rmSync(root,{recursive:true,force:true});
 }
});
