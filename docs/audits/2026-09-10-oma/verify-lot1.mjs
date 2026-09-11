// Independent acceptance checks: launches the compiled MCP server, no AI calls.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const repo = resolve(process.argv[2] ?? '.');
const out = process.argv[3];
const base = mkdtempSync(join(tmpdir(), 'oma-lot1-independent-'));
const results = [];
const node = { id: 'task', title: 'Synthetic acceptance task', kind: 'agent', activation: 'all',
  completionAuthority: 'broker', completionAuthorityId: 'oma-broker',
  executor: { adapter: 'agy', persona: 'explorer' }, scope: ['README.md'] };
const fixture = () => mkdtempSync(join(base, 'case-'));
function rpc(root, calls) {
  const env = { ...process.env, OMA_WORKSPACE_ROOT: root };
  for (const k of ['OMA_BRAIN_PATH','OMA_GATES_PATH','OMA_LEDGER_PATH','OMA_MISSION_ID']) delete env[k];
  const messages = [
    {jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'independent-check',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    ...calls.map(([name,args],i)=>({jsonrpc:'2.0',id:i+1,method:'tools/call',params:{name,arguments:args}}))
  ];
  const p=spawnSync(process.execPath,[join(repo,'dist/src/mcp/broker-server.js')],{
    cwd:root,env,input:messages.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:15000});
  assert.equal(p.status,0,p.error?.message ?? p.stderr);
  return p.stdout.trim().split('\n').map(JSON.parse).filter(r=>r.id!==0).map(r=>r.result??r.error);
}
function snapshot(root) {
  const files={};
  function walk(dir,rel='') {
    if(!existsSync(dir))return;
    for(const name of readdirSync(dir).sort()) {
      const path=join(dir,name), key=rel+'/'+name;
      if(statSync(path).isDirectory())walk(path,key);
      else files[key]=createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  walk(join(root,'.oma')); return files;
}
function check(name,fn) {
  try { fn();results.push({name,passed:true}); }
  catch(e){results.push({name,passed:false,error:e.message});}
}
function init(root,extra={}) {
  const [r]=rpc(root,[['graph_init',{missionId:'mission-a',nodes:[node],edges:[],...extra}]]);
  assert.equal(r.isError,false,JSON.stringify(r));
}
function finish(root) {
  const r=rpc(root,[
    ['graph_mark_node',{nodeId:'task',state:'running',dispatchId:'dispatch-task'}],
    ['graph_mark_node',{nodeId:'task',state:'succeeded',dispatchId:'dispatch-task',authority:'broker',authorityId:'oma-broker',evidence:'Synthetic QA evidence'}]
  ]); for(const v of r)assert.equal(v.isError,false,JSON.stringify(v));
}
function proposal(extra={}) {
  return {schemaVersion:2,proposalId:'prop_independent',author:'oma-planner',parentRevision:1,
    delta:{nodesToAdd:[{...node,id:'next-task'}],edgesToAdd:[]},
    rationale:{summary:'Independent QA extension'},...extra};
}
check('bootstrap is not business success',()=>{
  const root=fixture();
  const r=rpc(root,[['graph_init',{missionId:'mission-a',goal:'Audit objective'}],['converge_step',{}]]);
  assert.notEqual(r[1].structuredContent?.status,'succeeded');
  assert.equal(r[1].structuredContent?.progress.acceptedWorkItems,0);
});
check('caller cannot force success with ready work',()=>{
  const root=fixture();init(root);
  const [r]=rpc(root,[['converge_step',{isIntegrated:true}]]);
  assert.notEqual(r.structuredContent?.status,'succeeded');
});
check('current counts and valid completion survive process restart',()=>{
  const root=fixture();init(root);rpc(root,[['converge_step',{}]]);finish(root);
  const [r]=rpc(root,[['converge_step',{}]]);
  assert.equal(r.structuredContent?.status,'succeeded',JSON.stringify(r));
  assert.equal(r.structuredContent.progress.acceptedWorkItems,1);
  assert.equal(r.structuredContent.progress.totalWorkItems,1);
  const [again]=rpc(root,[['converge_step',{}]]);
  assert.equal(again.structuredContent?.missionId,'mission-a');
  assert.equal(existsSync(join(root,'.oma/missions/oma-session')),false);
  const cli=spawnSync(process.execPath,[join(repo,'dist/bin/oma.js'),'status','--json','--mission','mission-a'],{cwd:root,encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status,'succeeded');
});
check('bootstrap still permits genuine planning and completion',()=>{
  const root=fixture();
  rpc(root,[['graph_init',{missionId:'mission-a',goal:'Audit objective'}],['converge_step',{}]]);
  const planned=proposal({delta:{nodesToAdd:[node],edgesToAdd:[]}});
  const [r]=rpc(root,[['graph_apply',{missionId:'mission-a',proposal:planned}]]);
  assert.equal(r.isError,false,JSON.stringify(r));finish(root);
  const [done]=rpc(root,[['converge_step',{}]]);
  assert.equal(done.structuredContent?.status,'succeeded',JSON.stringify(done));
  assert.equal(done.structuredContent.progress.acceptedWorkItems,1);
  assert.equal(done.structuredContent.progress.totalWorkItems,1);
});
for(const [label,args] of [
  ['top-level',{missionId:'foreign-mission',proposal:proposal()}],
  ['nested',{proposal:proposal({missionId:'foreign-mission'})}],
  ['conflicting nested',{missionId:'mission-a',proposal:proposal({missionId:'foreign-mission'})}]
])check(`graph_apply ${label}: reject before graph mutation`,()=>{
  const root=fixture();init(root);const before=snapshot(root);
  const [r]=rpc(root,[['graph_apply',args]]);
  assert.equal(r.isError,true,JSON.stringify(r));
  assert.deepEqual(snapshot(root),before);
});
for(const [tool,args] of [
  ['converge_step',{}],
  ['graph_mark_node',{nodeId:'task',state:'running'}],
  ['graph_replan',{failedNodeId:'task',failureReason:'synthetic'}],
  ['converge_status',{}]
])check(`${tool}: foreign mission rejected without any persistence`,()=>{
  const root=fixture();init(root);const before=snapshot(root);
  const [r]=rpc(root,[[tool,{...args,missionId:'foreign-mission'}]]);
  assert.equal(r.isError,true,JSON.stringify(r));
  assert.deepEqual(snapshot(root),before,'State changed on rejected mission identity');
});
const report={repo,fixtureRoot:base,results,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length};
if(out)writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exitCode=report.failed?1:0;
