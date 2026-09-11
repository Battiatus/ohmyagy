// Audit-only reproduction. All mutations are confined to fresh OS temp fixtures.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const broker = join(repo, 'dist/src/mcp/broker-server.js');
const cli = join(repo, 'dist/bin/oma.js');
const base = mkdtempSync(join(tmpdir(), 'oma-audit-20260910-'));
let seq = 0;
function rpc(root, calls) {
  const requests = calls.map(([name, args]) => ({ jsonrpc: '2.0', id: ++seq,
    method: 'tools/call', params: { name, arguments: args } }));
  const env = { ...process.env, OMA_WORKSPACE_ROOT: root };
  for (const k of ['OMA_BRAIN_PATH', 'OMA_GATES_PATH', 'OMA_LEDGER_PATH', 'OMA_MISSION_ID']) delete env[k];
  const initialize = { jsonrpc: '2.0', id: ++seq, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oma-audit', version: '1' } } };
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const p = spawnSync(process.execPath, [broker], { cwd: root, env,
    input: [initialize, initialized, ...requests].map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', timeout: 20000 });
  if (p.error || p.status !== 0) throw new Error(p.error?.message ?? p.stderr);
  return p.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(r => r.id !== initialize.id).map(r => {
    return { isError: r.result?.isError, data: r.result?.structuredContent ?? r.error };
  });
}
function fixture(label) { return mkdtempSync(join(base, label + '-')); }
function status(root, mission) {
  const p = spawnSync(process.execPath, [cli, 'status', '--json', '--mission', mission],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
  const projection = p.stdout.trim() ? JSON.parse(p.stdout) : undefined;
  return { exitCode: p.status, status: projection?.status, missionId: projection?.missionId,
    progress: projection?.progress, workItemIds: Object.keys(projection?.workGraph?.workItems ?? {}),
    artifactCount: Object.keys(projection?.provenance?.artifacts ?? {}).length, stderr: p.stderr.trim() };
}
const node = { id: 'audit-task', title: 'Read-only audit task', kind: 'agent', activation: 'all',
  completionAuthority: 'broker', completionAuthorityId: 'oma-broker',
  executor: { adapter: 'agy', persona: 'explorer' }, scope: ['README.md'] };
const findings = { fixtureRoot: base, probes: {} };

const first = fixture('bootstrap');
findings.probes.bootstrap = rpc(first, [
  ['graph_init', { missionId: 'mission-a', goal: 'Audit databases and debt' }],
  ['converge_step', { missionId: 'mission-a' }],
  ['graph_init', { missionId: 'mission-b', goal: 'Second unrelated objective' }],
]);
findings.probes.bootstrapStatus = status(first, 'mission-a');

const second = fixture('progress');
findings.probes.progress = rpc(second, [
  ['graph_init', { missionId: 'mission-a', nodes: [node], edges: [] }],
  ['converge_step', { missionId: 'mission-a' }],
  ['graph_mark_node', { missionId: 'mission-a', nodeId: node.id, state: 'running', dispatchId: 'audit-dispatch' }],
  ['graph_mark_node', { missionId: 'mission-a', nodeId: node.id, state: 'succeeded', dispatchId: 'audit-dispatch', authority: 'broker', authorityId: 'oma-broker', evidence: 'synthetic audit probe only' }],
  ['converge_step', { missionId: 'mission-a' }],
  ['converge_step', { missionId: 'unrelated-mission' }],
]);
findings.probes.foreignMissionStatus = status(second, 'unrelated-mission');

const third = fixture('trust');
findings.probes.trustedCompletion = rpc(third, [
  ['graph_init', { missionId: 'mission-a', nodes: [node], edges: [] }],
  ['converge_step', { missionId: 'mission-a', isIntegrated: true }],
]);

const fourth = fixture('memory');
findings.probes.memory = rpc(fourth, [
  ['brain_summarize', { context: 'First synthetic exchange', actions: 'No model invoked' }],
  ['brain_summarize', { context: 'Second synthetic exchange', actions: 'No model invoked' }],
  ['brain_query', {}],
]);

const incidentPath = 'C:/Users/User/.gemini/antigravity-cli/conversations/d9cef86b-978c-43d8-889b-cb84720df89a.db';
if (existsSync(incidentPath)) {
  const db = new DatabaseSync(incidentPath, { readOnly: true });
  const records = db.prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx').all();
  // Recognize protobuf call-id followed by field 2 tool-name. No chat text is exported.
  const calls = [];
  for (const row of records.filter(r => r.step_type === 132)) {
    const s = Buffer.from(row.step_payload).toString('latin1');
    const match = /call_\d+\x12([\x01-\x7f])/.exec(s);
    if (match) {
      const start = match.index + match[0].length;
      calls.push({ step: row.idx, tool: s.slice(start, start + match[1].charCodeAt(0)) });
    }
  }
  findings.incident = { path: incidentPath, steps: records.length, recognizedCalls: calls,
    toolCounts: calls.reduce((a, c) => ({ ...a, [c.tool]: (a[c.tool] ?? 0) + 1 }), {}) };
  db.close();
}

const out = fileURLToPath(new URL('./probe-results.json', import.meta.url));
writeFileSync(out, JSON.stringify(findings, null, 2) + '\n');
console.log(JSON.stringify(findings, null, 2));
