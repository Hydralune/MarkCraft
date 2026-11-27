import net from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';

const providers = {codex: 'Codex', deepseek: 'DeepSeek Harness', claude: 'Claude Code', antigravity: 'Antigravity'};
const maxBytes = 16 * 1024 * 1024;
export const inject = ['workspaceRegistry', 'sessionPersistence'];

function seedFor(messages, source, title) {
  const events = [];
  let turn = 0, step = 0, time = 0, replied = false;
  const add = (type, data, surface = false) => events.push({
    type, data, seq: events.length, time, ...(surface ? {surfaceOp: 'append'} : {})
  });
  const end = () => {
    add('step/end', {turn, step});
    const reason = replied ? {kind:'completed'} : {kind:'error',error:{code:'MARKCRAFT_NO_REPLY',message:'原对话中的这条消息尚未收到回复。'}};
    add('turn/end', {turn, reason});
  };
  for (const m of messages) {
    if (!m || !['user','assistant'].includes(m.role) || typeof m.text !== 'string' || !m.text.trim())
      throw new Error('对话包含无法识别的消息。');
    if (m.role === 'user' && turn) end();
    const parsed = /^\d{10,13}$/.test(m.time) ? Number(m.time) * (m.time.length === 10 ? 1000 : 1) : Date.parse(m.time);
    time = Math.max(time, Number.isFinite(parsed) ? parsed : (time || Date.now()));
    const content = [{type:'text', text:m.text}];
    if (m.role === 'user') {
      turn++; step = 1; replied = false;
      add('turn/start', {turn});
      add('step/start', {turn, step});
      if (turn === 1) add('system/message', {turn, step, message:{
        id:randomUUID(), role:'system', content:[], source:{kind:'system-prompt'}
      }}, true);
      add('user/message', {id:randomUUID(), role:'user', content, source:{kind:'user'}}, true);
    } else {
      if (!turn) throw new Error('对话开头缺少用户原话，无法建立完整的接续。');
      replied = true;
      if (events.at(-1).type === 'assistant/message') {
        add('step/end', {turn, step});
        step++; add('step/start', {turn, step});
      }
      add('assistant/message', {turn, step, stream:[], message:{
        id:randomUUID(), role:'assistant', content, source:{kind:'model', provider:'markcraft-import', model:providers[source]}
      }}, true);
    }
  }
  end();
  add('session/title', {title, messageSeqs:[], source:{kind:'user'}});
  return events;
}

async function importSession(ctx, request) {
  const {source, sourceId, workspaceId, messages} = request;
  if (!Object.hasOwn(providers, source) || !/^[a-f0-9]{64}$/.test(sourceId) ||
      !Array.isArray(messages) || !messages.length || typeof request.title !== 'string')
    throw new Error('接续请求不完整。');
  const usingPath = typeof request.workspacePath === 'string' && request.workspacePath.length > 0;
  if (usingPath === Boolean(workspaceId)) throw new Error('请选择一个目标工作目录。');
  let title = providers[source] + ' · ';
  for (const c of request.title.replace(/\s+/gu,' ').trim()) {
    if (Buffer.byteLength(title + c) > 80) break;
    title += c;
  }
  if (request.displayTitle !== undefined) {
    if (typeof request.displayTitle !== 'string' || !request.displayTitle.trim() ||
        /[\u0000-\u001f\u007f]/u.test(request.displayTitle) || [...request.displayTitle].length > 120)
      throw new Error('请输入 1 至 120 个字符的单行名称。');
    title = request.displayTitle.trim();
  }
  const events = seedFor(messages, source, title);
  const workspace = usingPath
    ? await ctx.workspaceRegistry.create(request.workspacePath)
    : ctx.workspaceRegistry.get(workspaceId);
  if (!workspace || !(await stat(workspace.path)).isDirectory()) throw new Error('目标工作目录不存在，请重新选择。');
  const hash = createHash('sha256').update(JSON.stringify([1, workspace.id, sourceId, messages])).digest('hex');
  const id = [hash.slice(0,8),hash.slice(8,12),'8'+hash.slice(13,16),'a'+hash.slice(17,20),hash.slice(20,32)].join('-');
  const persistence = ctx.sessionPersistence;
  const existing = await persistence.stat(id);
  if (!existing) {
    const header = {version:SESSION_FORMAT_VERSION, id, createdAt:events[0].time, cwd:workspace.path, isSeeded:false};
    Session.create(id, events, header);
    const handle = await persistence.create(header);
    try { await handle.append(events); await handle.flush(); } finally { await handle.close(); }
    ctx.get('sessionProjectionCache')?.coldSnapshot(header, 0, events);
  } else {
    const handle = await persistence.open(id, 'read');
    try {
      const {events:last} = await handle.read(events.length - 1, 1);
      if (handle.header.cwd !== workspace.path || last[0]?.type !== 'session/title')
        throw new Error('接续副本写入不完整，已保留原对话。');
    } finally { await handle.close(); }
  }
  await workspace.attachSession(id);
  return {id, title, workspace:workspace.path, count:messages.length, existing:!!existing};
}

// A per-user discovery file keeps the loopback capability out of the WebView and the document.
export async function apply(ctx) {
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'markcraft');
  await mkdir(dir, {recursive:true, mode:0o700});
  const endpoint = join(dir, 'bridge-v1.json'), token = randomBytes(32).toString('hex');
  let writes = Promise.resolve();
  const server = net.createServer(socket => {
    socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    const chunks = [];
    let size = 0, done = false;
    socket.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) { socket.destroy(); return; }
      chunks.push(chunk);
      if (chunk[chunk.length - 1] !== 10) return;
      done = true;
      void (async () => {
        const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (req.token !== token) {socket.destroy(); return;}
        let result;
        if (req.action === 'targets') {
          result = {workspacePaths:true, namedHarness:true, targets:ctx.workspaceRegistry.list().map(({id,title,path}) => ({id,title,path}))};
        } else if (req.action === 'import') {
          const next = writes.then(() => importSession(ctx, req));
          writes = next.catch(() => {});
          result = await next;
        } else throw new Error('未知的接续操作。');
        socket.end(JSON.stringify(result)+'\n');
      })().catch(e => socket.end(JSON.stringify({error:String(e.message)})+'\n'));
    });
  });
  await new Promise((resolve,reject) => { server.once('error', reject); server.listen(0,'127.0.0.1',resolve); });
  ctx.effect(() => async () => {
    server.close();
    await writes;
    if (JSON.parse(await readFile(endpoint,'utf8').catch(()=>'{}')).token === token) await unlink(endpoint);
  });
  const temporary = endpoint+'.'+randomUUID();
  await writeFile(temporary, JSON.stringify({port:server.address().port,token}), {mode:0o600, flag:'wx'});
  await rename(temporary, endpoint);
}
