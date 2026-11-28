import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../server/usage.js';

test('A background question covers continuations and children created during the turn, not the next question', async t => {
  t.mock.method(globalThis,'fetch',async () => Response.json({data:[]}));
  let now = 100;
  t.mock.method(Date,'now',()=>now);
  const hooks = {}, storage = new Map();
  const infos = {parent:{time:{created:1}},child:{time:{created:150},parentID:'parent'},fork:{parentID:'parent',fork:{},time:{created:150}}};
  let command, prompt;
  const ctx = {
    model:{transform:async()=>{}}, rpc:{register:async()=>{}}, command:{transform:async f=>f({add:c=>command=c})},
    storage:{get:async k=>structuredClone(storage.get(k)),set:async(k,v)=>storage.set(k,structuredClone(v))},
    session:{hook:async(k,f)=>hooks[k]=f,get:async({sessionID})=>infos[sessionID],prompt:async p=>prompt=p},
  };
  const dispose = await plugin.setup(ctx);
  t.after(dispose);
  await command.execute({sessionID:'parent',prompt:{text:'check docs'},delivery:'queue'});
  const context=(id,metadata)=>hooks.context({sessionID:id,messages:[{role:'user',metadata}]});
  const headers=async id=>{
    const e={sessionID:id,request:new Request('http://127.0.0.1:17334/v1/responses')};
    await hooks['http.request'](e);return e.request.headers;
  };
  await context('parent',prompt.metadata);
  assert.equal((await headers('parent')).get('x-prism-priority'),'background');
  now=200;
  await context('parent',{prismPriority:'normal'});
  assert.equal((await headers('parent')).get('x-prism-priority'),'normal');
  await context('child',{prismPriority:'normal'});
  const child=await headers('child');
  assert.equal(child.get('x-prism-ancestors'),'parent');
  assert.equal(child.get('x-prism-priority'),'background');
  assert.equal((await headers('fork')).get('x-prism-priority'),'normal');
});
