import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {loadBotConfigs} from '../src/bot-registry.js';
import {findOnlineDaemon} from '../src/utils/daemon-discovery.js';
import {fetchDaemonIpc} from '../src/core/daemon-ipc-auth.js';
import {DeployWorkerBridge,DeployWorkerFault} from '../src/cli/deploy-worker.js';
import {logger} from '../src/utils/logger.js';
logger.setSilent(true);
try {
  if(process.argv.slice(2).join(' ')!=='--protocol deploy-worker-v1' || !process.env.BOTS_CONFIG || !process.env.SESSION_DATA_DIR || process.env.BOTMUX_CORE_ONLY==='1')throw new DeployWorkerFault('conflict','rejected');
  const request=JSON.parse(readFileSync(0,'utf8'));
  const configs=loadBotConfigs();
  if(configs.length!==1 || configs[0].larkAppId!==request.botId || configs[0].name!=='deploy-feedback')throw new DeployWorkerFault('conflict','rejected');
  const daemon=findOnlineDaemon(request.botId);
  if(!daemon)throw new DeployWorkerFault('unavailable','rejected');
  const bridge=new DeployWorkerBridge(join(process.env.SESSION_DATA_DIR,'deploy-worker-requests'),configs[0],async(path,method='GET',body)=>{
    const response=await fetchDaemonIpc(daemon.ipcPort,path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new DeployWorkerFault(response.status===401?'auth_failed':response.status===409?'not_ready':'unknown_result');
    return response.json();
  });
  console.log(JSON.stringify({ok:true,result:await bridge.execute(request)}));
} catch(e) {console.log(JSON.stringify({ok:false,code:e instanceof DeployWorkerFault?e.code:'unknown_result',outcome:e instanceof DeployWorkerFault?e.outcome:'unknown'}));}
