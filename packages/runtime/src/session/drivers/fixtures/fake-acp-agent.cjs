// A scripted ACP agent for tests (newline-delimited JSON-RPC on stdio). Behaviour is driven by the prompt text:
//   hello | edit <abs path> | read <abs path> | term <cmd> | exec <cmd> | wait (hangs until session/cancel) | crash
// Env: FAKE_LOG=<file> (jsonl of every received method + pid), FAKE_LOAD=ok|refuse-live|refuse, FAKE_NOLOAD=1, FAKE_NO_MODELS=1
const fs = require('node:fs');
const log = (o) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n'); };
let nextId = 1000; const waiting = new Map(); let held = null; let seq = 0; let cancelWake = null;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const upd = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const ask = (method, params) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); send({ id, method, params }); });
const text = (s) => ({ type: 'text', text: s });

async function prompt(id, p) {
  const sid = p.sessionId; const t = (p.prompt.find((b) => b.type === 'text') || {}).text || '';
  // the daemon may put the blob's memory context before the user's words: the command is the last line
  const cmd = t.split('\n---\n').pop().trim().split('\n').pop().trim();
  const [verb, ...rest] = cmd.split(' '); const arg = rest.join(' ');
  if (verb === 'crash') process.exit(1);
  if (verb === 'hello') {
    upd(sid, { sessionUpdate: 'agent_thought_chunk', content: text('thinking') });
    upd(sid, { sessionUpdate: 'plan', entries: [{ content: 'greet', priority: 'high', status: 'in_progress' }] });
    upd(sid, { sessionUpdate: 'agent_message_chunk', content: text('Hel') });
    upd(sid, { sessionUpdate: 'agent_message_chunk', content: text('lo from ' + sid) });
    upd(sid, { sessionUpdate: 'usage_update', used: 120, size: 1000 });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (verb === 'edit' || verb === 'exec') {
    const kind = verb === 'edit' ? 'edit' : 'execute';
    const tc = { toolCallId: 'tc1', title: verb === 'edit' ? 'Edit ' + arg : 'Run ' + arg, kind, status: 'pending', rawInput: verb === 'edit' ? { path: arg } : { command: arg }, locations: verb === 'edit' ? [{ path: arg }] : [] };
    upd(sid, { sessionUpdate: 'tool_call', ...tc });
    const r = await ask('session/request_permission', { sessionId: sid, toolCall: tc, options: [
      { optionId: 'a1', name: 'Allow once', kind: 'allow_once' }, { optionId: 'a2', name: 'Always', kind: 'allow_always' }, { optionId: 'r1', name: 'Reject', kind: 'reject_once' }] });
    log({ permissionOutcome: r.outcome });
    if (r.outcome.outcome === 'selected' && r.outcome.optionId.startsWith('a')) {
      let msg = 'done';
      if (verb === 'edit') { try { await ask('fs/write_text_file', { sessionId: sid, path: arg, content: 'edited\n' }); } catch (e) { msg = 'write failed: ' + e.message; } }
      else { try { const term = await ask('terminal/create', { sessionId: sid, command: arg }); await ask('terminal/wait_for_exit', { sessionId: sid, terminalId: term.terminalId }); const o = await ask('terminal/output', { sessionId: sid, terminalId: term.terminalId }); msg = 'out:' + o.output.trim(); } catch (e) { msg = 'terminal failed: ' + e.message; } }
      upd(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: msg.includes('failed') ? 'failed' : 'completed', content: [{ type: 'content', content: text(msg) }] });
      upd(sid, { sessionUpdate: 'agent_message_chunk', content: text(msg) });
    } else {
      upd(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'failed' });
      upd(sid, { sessionUpdate: 'agent_message_chunk', content: text(r.outcome.outcome === 'cancelled' ? 'cancelled' : 'rejected') });
    }
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (verb === 'read') {
    let msg; try { msg = (await ask('fs/read_text_file', { sessionId: sid, path: arg })).content; } catch (e) { msg = 'read failed: ' + e.message; }
    upd(sid, { sessionUpdate: 'agent_message_chunk', content: text(msg) });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (verb === 'term') {
    let msg; try { const term = await ask('terminal/create', { sessionId: sid, command: arg }); await ask('terminal/wait_for_exit', { sessionId: sid, terminalId: term.terminalId }); msg = 'out:' + (await ask('terminal/output', { sessionId: sid, terminalId: term.terminalId })).output.trim(); } catch (e) { msg = 'terminal failed: ' + e.message; }
    upd(sid, { sessionUpdate: 'agent_message_chunk', content: text(msg) });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (verb === 'wait') {
    upd(sid, { sessionUpdate: 'agent_message_chunk', content: text('waiting') });
    await new Promise((r) => { cancelWake = r; });
    return send({ id, result: { stopReason: 'cancelled' } });
  }
  upd(sid, { sessionUpdate: 'agent_message_chunk', content: text('echo ' + cmd) });
  return send({ id, result: { stopReason: 'end_turn' } });
}

const FAIL = process.env.FAKE_FAIL || ''; // hang-init | unsupported | exit-start | hang-new
if (FAIL === 'exit-start') { process.stderr.write('fatal: boom at startup\n'); process.exit(3); }
function handle(m) {
  if (m.method === undefined) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); } return; }
  log({ method: m.method, params: m.params });
  const { id, params: p } = m;
  switch (m.method) {
    case 'initialize':
      if (FAIL === 'hang-init') return;
      if (FAIL === 'unsupported') return send({ id, error: { code: -32603, message: 'This client is no longer supported. Please migrate to Antigravity.' } });
      return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: !process.env.FAKE_NOLOAD, promptCapabilities: { image: true } }, authMethods: [], agentInfo: { name: 'fake-acp', version: '0' } } });
    case 'session/new': {
      if (FAIL === 'hang-new') return;
      held = 'sess-' + process.pid + '-' + (++seq);
      return send({ id, result: { sessionId: held, ...(process.env.FAKE_NO_MODELS ? {} : { models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'Model One' }, { modelId: 'm2', name: 'Model Two' }] } }) } });
    }
    case 'session/load': {
      const mode = process.env.FAKE_LOAD || 'ok';
      if (mode === 'refuse' || (mode === 'refuse-live' && held)) return send({ id, error: { code: -32602, message: mode === 'refuse' ? 'unknown session' : 'session already active in this process' } });
      held = p.sessionId;
      upd(p.sessionId, { sessionUpdate: 'user_message_chunk', content: text('OLD HISTORY') });
      upd(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('OLD REPLY') });
      return send({ id, result: process.env.FAKE_NO_MODELS ? {} : { models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'Model One' }, { modelId: 'm2', name: 'Model Two' }] } } });
    }
    case 'session/set_model': return send({ id, result: {} });
    case 'session/cancel': if (cancelWake) { cancelWake(); cancelWake = null; } return;
    case 'session/prompt': return void prompt(id, p).catch((e) => send({ id, error: { code: -32603, message: String(e.message) } }));
    default: return send({ id, error: { code: -32601, message: 'method not found' } });
  }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(JSON.parse(l)); } });
process.stdin.on('end', () => process.exit(0));
