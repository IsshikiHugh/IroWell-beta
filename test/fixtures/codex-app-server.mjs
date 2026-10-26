// Small 0.164.0 JSONL peer: no accounts, network or model calls.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
if (process.argv.includes('--version')) { console.log('codex-cli 0.164.0'); process.exit(); }
const dir = process.env.IRO_TEST_CODEX_STATE;
fs.mkdirSync(dir, {recursive:true});
const log = row => fs.appendFileSync(path.join(dir,'wire.jsonl'),JSON.stringify({pid:process.pid,...row})+'\n');
const file = id => path.join(dir,id+'.json');
const read = id => JSON.parse(fs.readFileSync(file(id),'utf8'));
const save = t => fs.writeFileSync(file(t.id),JSON.stringify(t));
const write = obj => process.stdout.write(JSON.stringify(obj)+'\n');
const notify = (method,params) => write({method,params});
const loaded = new Set(), requests = new Map(), timers = new Map();
let requestId = 100;
const response = t => ({thread:t,model:'fixture-model',cwd:t.cwd,reasoningEffort:'medium',sandbox:{type:'readOnly'},approvalPolicy:'on-request',activePermissionProfile:{id:':read-only'}});
function finish(threadId,status='completed') {
 const t=read(threadId), turn=t.turns.at(-1); if (!turn || turn.status!=='inProgress') return;
 clearTimeout(timers.get(threadId));
 const item={id:turn.id+'-answer',type:'agentMessage',phase:'final_answer',text:'Answer: '+turn.items[0].content.find(x=>x.type==='text').text};
 notify('item/started',{threadId,turnId:turn.id,item:{...item,text:''}});
 notify('item/agentMessage/delta',{threadId,turnId:turn.id,itemId:item.id,delta:'Answer: '});
 notify('item/agentMessage/delta',{threadId,turnId:turn.id,itemId:item.id,delta:item.text.slice(8)});
 turn.items.push(item);turn.status=status;t.status={type:'idle'};save(t);
 notify('item/completed',{threadId,turnId:turn.id,item});
 notify('turn/completed',{threadId,turn});
}
async function handle(method,p) {
 const providerMode=fs.existsSync(path.join(dir,'provider-mode'))?fs.readFileSync(path.join(dir,'provider-mode'),'utf8'):'';
 if (method==='initialize') return {userAgent:'fixture/0.164.0'};
 if (method==='initialized') return;
 if (method==='config/read') return {config:{model:'fixture-model',model_reasoning_effort:'medium',sandbox_mode:'read-only',developer_instructions:'Keep native instructions.',...(providerMode?{model_provider:'custom',model_providers:{custom:{name:'Fixture Gateway',base_url:'https://user:fixture-secret@gateway.example.invalid/v1?key=fixture-secret',env_key:'GATEWAY_API_KEY',requires_openai_auth:providerMode!=='env',http_headers:{'X-Api-Key':'fixture-secret'}}}}:{})},origins:{model:{name:{type:'user',file:path.join(process.env.CODEX_HOME,'config.toml')},version:'fixture'}}};
 if (method==='permissionProfile/list') return {data:[{id:':read-only',allowed:true},{id:':workspace',allowed:true},{id:':danger-full-access',allowed:false}],nextCursor:null};
 if (method==='collaborationMode/list') return {data:[{mode:'default',name:'Default'},{mode:'plan',name:'Plan'}]};
 if (method==='configRequirements/read') return {requirements:fs.existsSync(path.join(dir,'manual-review-only'))?{allowedApprovalsReviewers:['user']}:null};
 if (method==='model/list') return {data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture model',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}],nextCursor:null};
 if (method==='skills/list') return {data:[{cwd:p.cwds?.[0]||dir,skills:[
  {name:'fixture-skill',description:'Native fixture skill',scope:'user',enabled:true,path:path.join(dir,'skills/fixture/SKILL.md')},
  {name:'fixture-skill',description:'Project fixture skill',scope:'repo',enabled:true,path:path.join(p.cwds?.[0]||dir,'.agents/skills/fixture/SKILL.md')},
  {name:'disabled-skill',description:'Disabled fixture skill',scope:'user',enabled:false,path:path.join(dir,'skills/disabled/SKILL.md')},
 ],errors:[]}]};
 if (method==='mcpServerStatus/list') return {data:[{name:'fixture-mcp',authStatus:'notLoggedIn',runtimeStatus:p.threadId?'authenticationRequired':null}],nextCursor:null};
 if (method==='account/login/start') return {type:'chatgptDeviceCode',loginId:'fixture-login',verificationUrl:'https://example.invalid/login',userCode:'TEST-CODE'};
 if (method==='account/login/cancel') return {};
 if (method==='account/read') return {account:providerMode==='env'?null:providerMode==='key'?{type:'apiKey'}:{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'},requiresOpenaiAuth:providerMode!=='env'};
 if (method==='account/rateLimits/read') return {rateLimitsByLimitId:{codex:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:2000000000}}}};
 if (method==='thread/start' || method==='thread/fork') {
  const source=method==='thread/fork'?read(p.threadId):null;
  let turns=source?.turns||[];
  if (p.lastTurnId) turns=turns.slice(0,turns.findIndex(t=>t.id===p.lastTurnId)+1);
  const t={id:randomUUID(),sessionId:source?.sessionId||'tree-id',cwd:p.cwd,historyMode:'paginated',preview:'Fixture conversation',name:null,createdAt:Date.now()/1000,updatedAt:Date.now()/1000,status:{type:'idle'},turns};
  save(t);loaded.add(t.id);return response(t);
 }
 if (method==='thread/read') return {thread:read(p.threadId)};
 if (method==='thread/resume') {const t=read(p.threadId);loaded.add(t.id);return response(t);}
 if (method==='thread/turns/list') {const t=read(p.threadId),start=Number(p.cursor)||0,all=[...t.turns].reverse();const data=all.slice(start,start+Math.min(p.limit,2));return {data,nextCursor:start+data.length<all.length?String(start+data.length):null};}
 if (method==='thread/list') return {data:p.ancestorThreadId?[]:fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'))).filter(t=>!p.cwd||t.cwd===p.cwd),nextCursor:null};
 if (method==='thread/name/set') {const t=read(p.threadId);t.name=p.name;save(t);return {};}
 if (method==='thread/revert') {const t=read(p.threadId);t.turns=t.turns.slice(0,t.turns.findIndex(t=>t.id===p.beforeTurnId));save(t);return {thread:t};}
 if (method==='thread/unsubscribe') {
  if (fs.existsSync(path.join(dir,'block-unload'))) return {status:'unsubscribed'};
  loaded.delete(p.threadId);
  setTimeout(()=>{log({method:'unloaded',threadId:p.threadId});notify('thread/closed',{threadId:p.threadId});},250);
  return {status:'unsubscribed'};
 }
 if (method==='thread/backgroundTerminals/list') return {data:fs.existsSync(path.join(dir,'background-'+p.threadId))?[{itemId:'bg',command:'fixture background process',processId:'42',cwd:read(p.threadId).cwd}]:[],nextCursor:null};
 if (method==='thread/backgroundTerminals/clean') {fs.rmSync(path.join(dir,'background-'+p.threadId),{force:true});return {};}
 if (method==='turn/interrupt') {finish(p.threadId,'interrupted');return {};}
 if (method==='turn/start') {
  if (!loaded.has(p.threadId)) throw Error('Thread is not loaded');
  const t=read(p.threadId), turn={id:randomUUID(),status:'inProgress',items:[{id:randomUUID(),type:'userMessage',content:p.input}]};
  t.turns.push(turn);t.status={type:'active'};save(t);
  notify('turn/started',{threadId:t.id,turn});
  notify('item/started',{threadId:t.id,turnId:turn.id,item:turn.items[0]});
  const text=p.input[0].text;
  if (text==='crash') {setTimeout(()=>process.exit(9),20);return {turn};}
  if (text==='malformed') {setTimeout(()=>process.stdout.write('not json\n'),20);return {turn};}
  if (['approve','permissions','question','form','unknown-request','child-approve'].includes(text)) {
   const item={id:turn.id+'-tool',type:'commandExecution',command:'echo approved',aggregatedOutput:'',status:'inProgress'};
   turn.items.push(item);save(t);notify('item/started',{threadId:t.id,turnId:turn.id,item});
   const id=++requestId;requests.set(id,t.id);
   const params={threadId:t.id,turnId:turn.id,itemId:item.id,startedAtMs:Date.now(),command:item.command,cwd:t.cwd,availableDecisions:['accept','decline']};
   let method='item/commandExecution/requestApproval';
   if(text==='permissions'){method='item/permissions/requestApproval';params.permissions={network:{enabled:true}};}
   if(text==='question'){method='item/tool/requestUserInput';params.questions=[{id:'color',header:'Color',question:'Choose a color',options:[{label:'Blue',description:'Cool'}]}];}
   if(text==='form'){method='mcpServer/elicitation/request';Object.assign(params,{mode:'form',serverName:'fixture',message:'A form',requestedSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}});}
   if(text==='unknown-request')method='item/future/requestApproval';
   if(text==='child-approve'){params.threadId=t.id+'-child';notify('thread/started',{thread:{id:params.threadId,parentThreadId:t.id}});}
   write({id,method,params});
  } else if (text==='stream-hold') {
    const item={id:turn.id+'-answer',type:'agentMessage',phase:'commentary',text:''};
    notify('item/started',{threadId:t.id,turnId:turn.id,item});
    notify('item/agentMessage/delta',{threadId:t.id,turnId:turn.id,itemId:item.id,delta:'Still working'});
  } else if (text!=='hold') timers.set(t.id,setTimeout(()=>finish(t.id),80));
  notify('turn/plan/updated',{threadId:t.id,turnId:turn.id,plan:[{step:'Check fixture',status:'completed'}]});
  notify('turn/diff/updated',{threadId:t.id,turnId:turn.id,diff:'--- a/example.txt\n+++ b/example.txt\n@@ -0,0 +1 @@\n+fixture\n'});
  return {turn};
 }
 throw Error('Unsupported fixture method '+method);
}
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);log(m);
 if (!m.method) {const id=requests.get(m.id);if(id){requests.delete(m.id);notify('serverRequest/resolved',{threadId:id,requestId:m.id});finish(id);}return;}
 try {const result=await handle(m.method,m.params||{});if(m.id!=null)write({id:m.id,result});}
 catch(e){write({id:m.id,error:{code:-32602,message:e.message}});}
}).on('close',()=>process.exit());
