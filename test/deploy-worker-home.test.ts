import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,linkSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionDeployWorkerHome,restrictDeployWorkerFsPolicy,validateDeployWorkerDirectory} from '../src/core/deploy-worker-home.js';
const roots:string[]=[];
const setup=()=>{const root=mkdtempSync(join(tmpdir(),'deploy-homes-'));roots.push(root);const template=join(root,'deploy-worker-profile','codex');mkdirSync(template,{recursive:true,mode:0o700});for(const name of ['config.toml','auth.json'])writeFileSync(join(template,name),name,{mode:0o600});return {root,template};};
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
describe('Deploy Worker home isolation',()=>{
 it('separates session state and restores fixed launch files on restart',()=>{
  const {root}=setup();const one=provisionDeployWorkerHome(root,'one'),two=provisionDeployWorkerHome(root,'two');
  writeFileSync(join(one,'codex','state'),'one');writeFileSync(join(two,'codex','state'),'two');
  writeFileSync(join(one,'codex','config.toml'),'worker-controlled');
  expect(provisionDeployWorkerHome(root,'one')).toBe(one);
  expect(readFileSync(join(one,'codex','config.toml'),'utf8')).toBe('config.toml');
  expect(readFileSync(join(two,'codex','state'),'utf8')).toBe('two');
 });
 it('replaces worker-planted links without following them',()=>{
  const {root}=setup();const one=provisionDeployWorkerHome(root,'one'),two=provisionDeployWorkerHome(root,'two');
  rmSync(join(one,'codex','auth.json'));symlinkSync(join(two,'codex','auth.json'),join(one,'codex','auth.json'));
  expect(provisionDeployWorkerHome(root,'one')).toBe(one);
  expect(lstatSync(join(one,'codex','auth.json')).isFile()).toBe(true);
  expect(readFileSync(join(one,'codex','auth.json'),'utf8')).toBe('auth.json');
  expect(readFileSync(join(two,'codex','auth.json'),'utf8')).toBe('auth.json');
 });
 it('refuses unsafe template permissions, hardlinks and path traversal',()=>{
  const {root,template}=setup();expect(()=>provisionDeployWorkerHome(root,'../two')).toThrow('invalid');
  linkSync(join(template,'auth.json'),join(root,'linked-key'));expect(()=>provisionDeployWorkerHome(root,'one')).toThrow('unsafe');
 });
});

it('drops broad aliases and makes fixed launch files read-only',()=>{
 const policy=restrictDeployWorkerFsPolicy({rules:[
  {path:'/opt',access:'readOnly',source:'baseline'},
  {path:'/home/operator/.cache',access:'readWrite',source:'baseline'},
  {path:'/usr',access:'readOnly',source:'baseline'},
  {path:'/work/one',access:'readWrite',source:'internal'},
  {path:'/home/operator/.ssh',access:'deny',source:'baseline'},
  {path:'/session-stores/bot/sessions.db',access:'readOnly',source:'mandatory'},
 ],net:true,writeRegexes:[]},'/homes/session');
 expect(policy.rules).toEqual([
  {path:'/usr',access:'readOnly',source:'baseline'},
  {path:'/work/one',access:'readWrite',source:'internal'},
  {path:'/home/operator/.ssh',access:'deny',source:'baseline'},
  {path:'/homes/session/codex/config.toml',access:'readOnly',source:'mandatory'},
  {path:'/homes/session/codex/auth.json',access:'readOnly',source:'mandatory'},
 ]);
});

it('refuses ordinary bot chats and workspace roots as writable worker sessions',()=>{
 const root='/workers',wd=root+'/11111111-1111-4111-8111-111111111111/workspace';
 expect(()=>validateDeployWorkerDirectory(root,wd,'headless_hl_123')).not.toThrow();
 for(const [path,chat] of [[root,'headless_hl_123'],[wd,'oc_human_chat'],['/other/run/workspace','headless_hl_123']])expect(()=>validateDeployWorkerDirectory(root,path!,chat!)).toThrow();
});
