// Opt-in protocol check against the pinned binary. Isolated home; no login or model turns.
// node test/codex-native.mjs /absolute/path/to/@openai/codex/bin/codex.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createCodex} from '../server/codex.mjs';
const bin=process.argv[2];
if(!bin)throw Error('Pass the absolute path to the pinned codex.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iro-codex-native-'));
process.env.CODEX_HOME=path.join(root,'home');fs.mkdirSync(process.env.CODEX_HOME);
process.env.IRO_TEST_CODEX_BIN=path.resolve(bin);
const sessions=new Map(),events=[];
const codex=createCodex({dir:root,sessions,remote:()=>[],emit:(sid,e)=>events.push({sid,...e}),partial:()=>{},resetEvents:()=>{},resolveDir:p=>p,addFolder:()=>{}});
try {
 const schema=path.join(root,'schema');
 execFileSync(process.execPath,[bin,'app-server','generate-json-schema','--experimental','--out',schema]);
 // This exact executable is the fixture's schema authority; fail on wire method removal.
 const protocol=fs.readFileSync(path.join(schema,'ClientRequest.json'),'utf8');
 for(const method of ['thread/turns/list','thread/fork','thread/revert','permissionProfile/list','account/login/start','account/rateLimits/read','thread/unsubscribe'])assert(protocol.includes('"'+method+'"'),method);
 const options=await codex.handlers.engineOptions(null,{cwd:root});
 assert(options.permissions.some(p=>p.id&&typeof p.allowed==='boolean'));
 const {sid}=await codex.handlers.new(null,{cwd:root,blank:true});
 assert(sessions.get(sid).nativeSessionId);
 assert(events.some(e=>e.kind==='init'&&e.permissionLabel));
 await codex.handlers.close(null,{sid});
 assert(sessions.get(sid).closed,'unsubscribe must confirm thread/closed');
 const auto=await codex.handlers.new(null,{cwd:root,blank:true,permissions:':workspace',approvalsReviewer:'auto_review'});
 assert.equal(sessions.get(auto.sid).nativePermissions,':workspace');
 assert.equal(sessions.get(auto.sid).effectiveReviewer,'auto_review');
 assert.equal(sessions.get(auto.sid).approvalPolicy,'on-request');
 await codex.handlers.close(null,auto);
 await codex.rpc.stop();
 fs.writeFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'model_provider = "custom"\n[model_providers.custom]\nname = "Native test provider"\nbase_url = "https://example.invalid/v1"\nwire_api = "responses"\nenv_key = "IRO_NATIVE_PROVIDER_KEY"\n');
 process.env.IRO_NATIVE_PROVIDER_KEY='test-only';
 const info=await codex.handlers.engineAccount(null,{cwd:root});
 assert.equal(info.provider.id,'custom');
 assert.equal(info.provider.baseUrl,'https://example.invalid/v1');
 assert.equal(info.provider.envKey,'IRO_NATIVE_PROVIDER_KEY');
 assert.equal(info.requiresOpenaiAuth,false);
 assert.equal(info.account,null);
 const configFile=path.join(process.env.CODEX_HOME,'config.toml');
 fs.writeFileSync(configFile,'model_reasoning_effort = "high"\n'+fs.readFileSync(configFile,'utf8'));
 const refreshed=await codex.handlers.engineOptions(null,{cwd:root});
 assert.equal(refreshed.effort,'high','config/read observes external edits without interrupting the runtime');
 assert.equal(refreshed.sources.model_reasoning_effort.type,'user');
 const environment=await codex.handlers.engineEnvironment(null,{cwd:root});
 assert(Array.isArray(environment.skills)&&Array.isArray(environment.mcp));
 const skillDir=path.join(process.env.CODEX_HOME,'skills','iro-fixture');fs.mkdirSync(skillDir,{recursive:true});
 fs.writeFileSync(path.join(skillDir,'SKILL.md'),'---\nname: iro-fixture\ndescription: A temporary protocol test skill.\n---\nReport the current directory.\n');
 const skills=await codex.handlers.engineSkills(null,{cwd:root,forceReload:true});
 const skill=skills.data.flatMap(entry=>entry.skills).find(s=>s.name==='iro-fixture');
 assert(skill?.enabled,'skills/list finds a newly created enabled skill');
 assert.equal(skill.path,fs.realpathSync(path.join(skillDir,'SKILL.md')));
 console.log('PASS pinned schema, native config, custom provider, start and confirmed unload (no model calls)');
} finally {await codex.rpc.stop();fs.rmSync(root,{recursive:true,force:true});}
