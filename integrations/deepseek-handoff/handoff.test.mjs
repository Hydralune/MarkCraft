import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import * as bridge from './index.js';

test('a text snapshot becomes one durable, resumable session in the chosen native workspace', async () => {
  const home = await mkdtemp(join(tmpdir(),'markcraft-native-'));
  const prior = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const ctx = new Context();
  try {
    for (const [name, config] of [
      ['session', {}], ['session-persistence-jsonl', {root:join(home,'sessions')}],
      ['storage', {}], ['storage-json', {root:join(home,'storages')}],
      ['storage-domain', {backend:'json'}], ['workspace', {}]
    ]) {
      const mod = await import('@deepseek-ai/dsh-'+name);
      await ctx.plugin(mod.default ?? mod, config);
    }
    const path = join(home, '目标目录');
    await mkdir(path);
    const target = await ctx.workspaceRegistry.create(path);
    await ctx.plugin(bridge);
    const {port,token} = JSON.parse(await readFile(join(home,'markcraft/bridge-v1.json'),'utf8'));
    function send(request) {
      return new Promise((resolve,reject) => {
        let response = '';
        const client = net.connect(port,'127.0.0.1',() => client.write(JSON.stringify({...request,token})+'\n'));
        client.setEncoding('utf8');
        client.on('data',chunk => {response += chunk;});
        client.on('error',reject);
        client.on('end',() => {try {resolve(JSON.parse(response));} catch(e) {reject(e);}});
      });
    }
    assert.equal((await send({action:'targets'})).targets[0].id,target.id);
    const messages = [['user','计划 A'], ['assistant','已检查'], ['assistant','改用 B'], ['user','继续']].map(
      ([role,text],i) => ({role,text,time:new Date(60_000*i).toISOString()})
    );
    const request = {action:'import',source:'codex',sourceId:'a'.repeat(64),title:'交接',workspaceId:target.id,messages};
    const copies = await Promise.all([send(request),send(request)]);
    assert.equal(copies[0].id,copies[1].id);
    assert.deepEqual(copies.map(r=>r.existing).sort(),[false,true]);
    assert.deepEqual(target.sessionIds,[copies[0].id]);
    const project = join(home,'原项目');
    await mkdir(project);
    const original = {...request,workspaceId:undefined,workspacePath:project};
    const imported = await send(original);
    assert.equal(imported.workspace,project);
    const owned = await ctx.workspaceRegistry.resolveByPath(project);
    assert.deepEqual(owned.sessionIds,[imported.id]);
    assert.equal((await send({...request,workspaceId:owned.id})).id,imported.id);
    assert.ok((await send({...original,workspacePath:join(home,'不存在')})).error);
    assert.ok((await send({...original,workspaceId:target.id})).error);
    assert.equal(ctx.workspaceRegistry.list().length,2);
    const handle = await ctx.sessionPersistence.open(copies[0].id,'read');
    try {
      assert.equal(handle.header.cwd,target.path);
      const {events} = await handle.read();
      const texts = events.filter(e => ['user/message','assistant/message'].includes(e.type))
        .map(e => (e.data.message || e.data).content[0].text);
      assert.deepEqual(texts,messages.map(m=>m.text));
      assert.equal(events.filter(e=>e.type==='turn/end').at(-1).data.reason.kind,'error');
    } finally { await handle.close(); }
    assert.ok((await send({...request,workspaceId:'unknown'})).error);
    assert.ok((await send({...request,messages:[messages[1]]})).error);
    assert.deepEqual(target.sessionIds,[copies[0].id]);
    assert.equal((await send({action:'targets'})).namedHarness,true);
    const named = await send({...request,sourceId:'b'.repeat(64),displayTitle:'复核方案 · 第二稿'});
    assert.notEqual(named.id,copies[0].id);
    const renamed = await ctx.sessionPersistence.open(named.id,'read');
    try {
      assert.equal((await renamed.read()).events.at(-1).data.title,'复核方案 · 第二稿');
    } finally { await renamed.close(); }
  } finally {
    await ctx.fiber.dispose();
    if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior;
    await rm(home,{recursive:true,force:true});
  }
});
