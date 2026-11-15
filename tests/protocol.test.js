import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createIdentity,registration,verifyRegistration,seal,openEnvelope,encryptBackup,decryptBackup} from '../docs/protocol.js';
import {replay} from '../docs/model.js';

test('contact registration binds the keys and bearer token',async () => {
  const alice = await createIdentity('Alice');
  const bob = await createIdentity('Bob');
  const request = await registration(alice);
  assert.equal((await verifyRegistration(request,alice.token)).card.id,alice.card.id);
  await assert.rejects(verifyRegistration(request,bob.token));
  await assert.rejects(verifyRegistration({...request,card:{...alice.card,box:bob.card.box}},alice.token));
});

test('sealed text is private, authenticated, and bound to its recipient',async () => {
  const alice = await createIdentity('Alice');
  const bob = await createIdentity('Bob');
  const eve = await createIdentity('Eve');
  const text = 'הודעה 🌿 https://example.test/' + 'מ'.repeat(11000);
  const event = {id:crypto.randomUUID(),author:alice.card.id,name:'Alice',clock:1,at:Date.now(),action:'send',fields:{text}};
  const encrypted = {...await seal(alice,bob.card,event),sender:alice.card};
  assert.ok(!JSON.stringify(encrypted).includes(text));
  assert.deepEqual((await openEnvelope(bob,encrypted)).event,event);
  await assert.rejects(openEnvelope(eve,encrypted));
  await assert.rejects(openEnvelope(bob,{...encrypted,id:crypto.randomUUID()}));
  await assert.rejects(openEnvelope(bob,{...encrypted,body:(encrypted.body[0] === 'W' ? 'X' : 'W') + encrypted.body.slice(1)}));
});

test('event replay handles branches, author-only edits and out-of-order delivery',async () => {
  const alice = await createIdentity('Alice');
  const bob = await createIdentity('Bob');
  const base = {author:alice.card.id,name:'Alice',at:Date.now()};
  const event = (clock,action,fields,author = alice.card.id) =>
    ({...base,id:crypto.randomUUID(),clock,action,fields,author});
  const group = event(1,'group',{title:'Hello',cards:[alice.card,bob.card]});
  const message = event(2,'send',{thread:group.id,text:'First'});
  const branch = event(3,'branch',{thread:group.id,title:'Branch',source:message.id});
  const forbidden = event(4,'edit',{message:message.id,text:'Wrong author'},bob.card.id);
  const move = event(5,'moveMessage',{thread:group.id,message:message.id,destination:branch.id});
  const view = replay(bob,[],[move,message,forbidden,group,branch]);
  assert.equal(view.messages.get(message.id).text,'First');
  assert.equal(view.messages.get(message.id).thread,branch.id);
  assert.equal(view.threads.get(branch.id).source,message.id);
});

test('backup restores identity and local history with the same passphrase',async () => {
  const identity = await createIdentity('Alice');
  const data = {identity,events:[{text:'א'.repeat(45000)}],contacts:[],outbox:[]};
  const backup = await encryptBackup(data,'a memorable phrase');
  assert.ok(!backup.includes(identity.token));
  assert.deepEqual(await decryptBackup(backup,'a memorable phrase'),data);
  await assert.rejects(decryptBackup(backup,'an incorrect phrase'));
});
