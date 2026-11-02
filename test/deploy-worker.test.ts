import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DeployWorkerBridge,deployWorkerPolicy} from '../src/cli/deploy-worker.js';
import type {BotConfig} from '../src/bot-registry.js';
const roots:string[]=[];
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'deploy-bridge-')); roots.push(root);
 const cfg={larkAppId:'dedicated',workingDir:join(root,'workspaces'),sandbox:'oncall',cliId:'codex',backendType:'pty',codexAuthSync:'isolated',disableCliBypass:true,larkToolBinding:false,sandboxNetwork:false,envPolicy:{mode:'strict'},plugins:[]} as unknown as BotConfig;
 const state={creates:0,sends:0,stops:[] as string[],loseCreate:false,loseSend:false,loseStop:false,rejectSend:false,phase:'running',payload:undefined as any};
 const sessions:any[]=[]; const registrations=new Map<string,string>();
 const api=async(path:string,method='GET',body?:any):Promise<any>=>{
  if(path==='/api/deploy-worker-policy')return {...deployWorkerPolicy(cfg),instanceId:'instance-1'};
  if(path==='/api/headless/sessions'){
   if(method==='GET')return {ok:true,sessions};
   state.creates++;const sessionId='session-'+state.creates;sessions.push({...body,larkAppId:cfg.larkAppId,sessionId});
   if(state.loseCreate){state.loseCreate=false;throw new Error('lost create response');}return {ok:true,sessionId};
  }
  if(path==='/api/trigger'){
   state.sends++;state.payload=body;if(state.rejectSend)throw new Error('failed before registration');
   const triggerId='turn-'+state.sends;registrations.set(body.options.turnIdempotencyKey,triggerId);
   if(state.loseSend){state.loseSend=false;throw new Error('lost send response');}
   return {ok:true,triggerId,target:{sessionId:body.target.sessionId}};
  }
  if(path.includes('trigger-registration?')){const k=decodeURIComponent(path.split('=')[1]!); const t=registrations.get(k);return t?{state:'registered',registration:{triggerId:t}}:{state:'unknown'};}
  if(path.includes('trigger-result?'))return {ok:true,state:state.phase,triggerId:decodeURIComponent(path.split('=')[1]!),target:{sessionId:path.split('/')[3]},...(state.phase==='completed'?{output:{content:'{"type":"needs_input","summary":"next","artifactRefs":[]}'}}:{})};
  if(path.endsWith('/interrupt')){state.stops.push(path);state.phase='interrupted';if(state.loseStop){state.loseStop=false;throw new Error('lost stop response');}return {ok:true,sessionId:path.split('/')[3],triggerId:path.split('/')[5]};}
  if(path.startsWith('/api/headless/sessions/'))return {ok:true,session:sessions.find(s=>s.sessionId===path.split('/').at(-1))};
  if(path.startsWith('/api/sessions/'))return {session:{status:'idle'}};
  throw new Error('unexpected API '+path);
 };
 const request=(operation:string,input:any,instanceId='instance-1')=>({protocol:1,version:'deploy-worker-v1',instanceId,botId:'dedicated',workspaceRoot:cfg.workingDir,operation,input});
 const runId='6f97b53e-83ba-4d26-91af-5379028b43f7';
 const start={requestId:'dispatch-1',runId,generation:1,profileKey:'dashboard',profile:{model:'fixed',reasoningEffort:'high'},workingDir:join(cfg.workingDir,runId,'workspace'),instruction:'untrusted task'};
 const bridge=()=>new DeployWorkerBridge(join(root,'journal'),cfg,api);
 return {root,cfg,state,request,start,bridge};
}
describe('Deploy host bridge durable protocol',()=>{
 it('serializes concurrent dispatch replays into one physical session and turn',async()=>{
  const f=fixture();
  const bindings=await Promise.all(Array.from({length:3},()=>f.bridge().execute(f.request('dispatch',f.start))));
  expect(bindings.every(binding=>JSON.stringify(binding)===JSON.stringify(bindings[0]))).toBe(true);
  expect(f.state.creates).toBe(1);expect(f.state.sends).toBe(1);
 });
 it('rejects a run id that escapes the controller workspace before creating a session',async()=>{
  const f=fixture();
  for(const runId of ['..','.','../other'])await expect(f.bridge().execute(f.request('dispatch',{...f.start,runId,workingDir:join(f.cfg.workingDir,runId,'workspace')}))).rejects.toThrow('conflict');
  expect(f.state.creates).toBe(0);
 });
 it('recovers a lost exact-stop response across restart without stopping a second turn',async()=>{
  const f=fixture();const binding=await f.bridge().execute(f.request('dispatch',f.start));
  f.state.loseStop=true;
  await expect(f.bridge().execute(f.request('stop',{requestId:'stop-lost',binding}))).rejects.toThrow('lost stop response');
  expect(await f.bridge().execute(f.request('reconcile',{requestId:'stop-lost'}))).toEqual(binding);
  expect((await f.bridge().execute(f.request('observe',binding))).state).toBe('interrupted');
  expect(await f.bridge().execute(f.request('stop',{requestId:'stop-lost',binding}))).toEqual(binding);
  expect(f.state.stops).toEqual(['/api/sessions/session-1/turns/turn-1/interrupt']);
 });
 it('recovers a lost create response across restart without creating another session',async()=>{
  const f=fixture();f.state.loseCreate=true;
  await expect(f.bridge().execute(f.request('dispatch',f.start))).rejects.toThrow('lost create');
  const binding=await f.bridge().execute(f.request('reconcile',{requestId:f.start.requestId}));
  expect(binding).toMatchObject({instanceId:'instance-1',sessionId:'session-1',requestId:'dispatch-1'});
  expect(f.state.creates).toBe(1);expect(f.state.sends).toBe(1);
  expect(await f.bridge().execute(f.request('dispatch',f.start))).toEqual(binding);
  expect(f.state.payload.envelope.trusted).toBe(false);
  expect(f.state.payload.options.turnIdempotencyKey).toBe('dispatch-1');
 });
 it('fails closed when a durable partial record is replayed after restart',async()=>{
  const f=fixture();await f.bridge().execute(f.request('dispatch',f.start));
  const journal=join(f.root,'journal');const record=join(journal,readdirSync(journal).find(name=>name.endsWith('.json'))!);
  writeFileSync(record,'{"fingerprint":"partial');
  await expect(f.bridge().execute(f.request('reconcile',{requestId:f.start.requestId}))).rejects.toThrow('unknown_result');
  await expect(f.bridge().execute(f.request('dispatch',f.start))).rejects.toThrow('unknown_result');
  expect(f.state.creates).toBe(1);expect(f.state.sends).toBe(1);
 });
 it('recovers a registered turn after losing the send response and never resends unknown outcomes',async()=>{
  const f=fixture();f.state.loseSend=true;
  await expect(f.bridge().execute(f.request('dispatch',f.start))).rejects.toThrow('lost send');
  const binding=await f.bridge().execute(f.request('reconcile',{requestId:f.start.requestId}));expect(binding.triggerId).toBe('turn-1');expect(f.state.sends).toBe(1);
  const g=fixture();g.state.rejectSend=true;
  await expect(g.bridge().execute(g.request('dispatch',g.start))).rejects.toThrow();
  await expect(g.bridge().execute(g.request('reconcile',{requestId:g.start.requestId}))).rejects.toThrow('unknown_result');
  await expect(g.bridge().execute(g.request('dispatch',g.start))).rejects.toThrow('unknown_result');
  expect(g.state.creates).toBe(1);expect(g.state.sends).toBe(1);
 });
 it('binds observation, session reads, new inputs and exact stop to durable owned turns',async()=>{
  const f=fixture();const b=await f.bridge().execute(f.request('dispatch',f.start));
  expect(await f.bridge().execute(f.request('session',{sessionId:b.sessionId}))).toEqual({sessionId:b.sessionId,ready:true});
  await expect(f.bridge().execute(f.request('input',{requestId:'input-early',binding:b,text:'next'}))).rejects.toThrow('not_ready');
  await expect(f.bridge().execute(f.request('stop',{requestId:'forged-stop',binding:{...b,triggerId:'other-turn'}}))).rejects.toThrow('conflict');
  f.state.phase='completed';const next=await f.bridge().execute(f.request('input',{requestId:'input-1',binding:b,text:'next'}));
  f.state.phase='running';await f.bridge().execute(f.request('stop',{requestId:'stop-1',binding:next}));
  expect(f.state.stops).toEqual(['/api/sessions/session-1/turns/turn-2/interrupt']);
  expect((await f.bridge().execute(f.request('observe',next))).state).toBe('interrupted');
  expect(await f.bridge().execute(f.request('reconcile',{requestId:'stop-1'}))).toEqual(next);
 });
 it('rejects conflicting request data, different instances and policy drift before replay',async()=>{
  const f=fixture();await f.bridge().execute(f.request('dispatch',f.start));
  await expect(f.bridge().execute(f.request('dispatch',{...f.start,instruction:'changed'}))).rejects.toThrow('conflict');
  await expect(f.bridge().execute(f.request('reconcile',{requestId:'dispatch-1'},'instance-2'))).rejects.toThrow('conflict');
  f.cfg.model='changed';await expect(f.bridge().execute(f.request('reconcile',{requestId:'dispatch-1'}))).rejects.toThrow('conflict');
  expect(f.state.creates).toBe(1);expect(f.state.sends).toBe(1);
 });
 it('refuses unsafe sandbox, credential inheritance, extra mounts and missing private launch policy',()=>{
  const f=fixture();expect(deployWorkerPolicy(f.cfg).allowed).toBe(true);
  for(const change of [{sandbox:'scratch'},{sandbox:false},{env:{LARK_APP_SECRET:'secret'}},{sandboxPaths:{readOnly:['/']}},{envPolicy:{mode:'inherit'}},{plugins:['extra']},{codexAuthSync:'shared'}]){
   expect(deployWorkerPolicy({...f.cfg,...change} as BotConfig).allowed).toBe(false);
  }
 });
});
