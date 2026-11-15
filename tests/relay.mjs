import assert from 'node:assert/strict';
import {createIdentity,registration,seal,openEnvelope} from '../docs/protocol.js';

const base = process.env.THREADY_TEST_RELAY || 'http://localhost:8787';
async function api(path,owner,body,expected = 200) {
  const response = await fetch(base + path,{
    method:body === undefined ? 'GET' : 'POST',
    headers:{
      ...(body === undefined ? {} : {'Content-Type':'application/json'}),
      ...(owner ? {Authorization:'Bearer ' + owner.card.id + '.' + owner.token} : {})
    },
    body:body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json();
  assert.equal(response.status,expected,JSON.stringify(value));
  return value;
}

const [alice,bob,eve] = await Promise.all(['Alice','Bob','Eve'].map(createIdentity));
for (const user of [alice,bob,eve]) await api('/register',user,await registration(user));
assert.deepEqual((await api('/contact?id=' + bob.card.id)).card,bob.card);
const event = {
  id:crypto.randomUUID(),author:alice.card.id,name:'Alice',clock:2,at:Date.now(),
  action:'send',fields:{text:'שלום https://example.com/'}
};
const item = await seal(alice,bob.card,event);
const outbound = {envelopes:[item],notify:false};
await api('/enqueue',alice,outbound);
await api('/enqueue',alice,outbound);
assert.deepEqual((await api('/inbox',eve)).envelopes,[]);
await api('/inbox',{...bob,token:eve.token},undefined,401);
const {envelopes} = await api('/inbox',bob);
assert.equal(envelopes.length,1);
assert.deepEqual((await openEnvelope(bob,envelopes[0])).event,event);
await api('/ack',bob,{accepted:[{id:item.id,from:alice.card.id}]});
await api('/enqueue',alice,outbound);
assert.deepEqual((await api('/inbox',bob)).envelopes,[]);
await api('/delete',bob,{});
await api('/delete',bob,{});
await api('/contact?id=' + bob.card.id,undefined,undefined,404);
await api('/register',bob,await registration(bob),409);
assert.deepEqual((await api('/enqueue',alice,outbound)).unavailable,[bob.card.id]);
for (const user of [alice,eve]) await api('/delete',user,{});
console.log('Relay integration passed');
