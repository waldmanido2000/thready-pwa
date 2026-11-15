import {all,get,put,saveEvents,settleOutbox,exportDevice,restoreDevice,clearDevice} from './database.js';
import {b64,unb64,checkedCard,createIdentity,seal,openEnvelope,isId,encryptBackup,decryptBackup,registration,verifyRegistration} from './protocol.js';
import {apply,replay} from './model.js';
import {relay,register,storeEnvelopes} from './network.js';

let pendingSync;
let connected = false;
let registered = '';
let lastPull = 0;
let writes = Promise.resolve();
let lastView = '';
let revision = 0;
let deleting = false;

export const isConnected = () => connected && navigator.onLine;
export const identity = () => get('meta','identity');
export function requestSync(force = false) {
  if (deleting) return Promise.resolve();
  if (force) lastPull = 0;
  if (!pendingSync) pendingSync = sync().finally(() => { pendingSync = null; });
  return pendingSync;
}

async function sync() {
  const owner = await identity();
  if (!owner || !navigator.onLine || Date.now() - lastPull < 1500) return;
  lastPull = Date.now();
  try {
    if (registered !== owner.card.id) {
      await register(owner);
      registered = owner.card.id;
    }
    const outbox = await all('outbox');
    for (const item of outbox) {
      // A stable ID lets the Worker accept retries without re-delivering acknowledged data.
      const expired = item.created && Date.now() - item.created > 30 * 86400000;
      const outcome = expired ? {unavailable:item.envelopes.map(envelope => envelope.to)}
        : await relay('/enqueue',owner,{notify:item.notify,envelopes:item.envelopes});
      await settleOutbox(owner,item.id,outcome.unavailable.length > 0);
    }
    let pages = 0;
    let cursor = '';
    do {
      const {envelopes,next} = await relay('/inbox?after=' + encodeURIComponent(cursor),owner);
      const {accepted} = await storeEnvelopes(owner,envelopes);
      if (accepted.length) await relay('/ack',owner,{accepted});
      cursor = next;
    } while (cursor && ++pages < 20);
    connected = true;
  } catch (error) {
    if (error.status === 401) registered = '';
    connected = false;
  }
}

function serialized(work) {
  const done = writes.then(() => navigator.locks ? navigator.locks.request("thready-write",work) : work());
  writes = done.catch(() => {});
  return done;
}

async function state() {
  const owner = await identity();
  if (!owner) throw new Error('Create an identity first.');
  const [contacts,events,favorites,outbox,failed] = await Promise.all([
    all('contacts'),all('events'),get('meta','favorites'),all('outbox'),get('meta','failed')
  ]);
  const model = replay(owner,contacts,events);
  return {owner,model,events,favorites:favorites || [],outbox,failed:failed || []};
}

export const localActions = {
  async create(name) {
    return serialized(async () => {
      name = name.trim();
      if (!name || name.length > 60) throw new Error('Enter a display name.');
      if (await identity()) throw new Error('This installation already has an identity.');
      const owner = await createIdentity(name);
      await put('meta','identity',owner);
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      void requestSync(true);
    });
  },
  async getId() {
    return (await identity())?.card.id;
  },
  async contact(id,name) {
    const owner = await identity();
    if (!isId(id) || id === owner?.card.id) throw new Error('Enter a valid Thready ID.');
    const localName = name.trim();
    if (localName.length > 60) throw new Error('Enter a display name.');
    const {card} = await relay('/contact?id=' + encodeURIComponent(id));
    const verified = await checkedCard(card);
    await put('contacts',id,{...verified,localName});
  },
  async renameContact(id,name) {
    return serialized(async () => {
      const {owner,model} = await state();
      const person = model.people.get(id);
      if (!person || id === owner.card.id) throw new Error('Contact unavailable.');
      const localName = name.trim();
      if (localName.length > 60) throw new Error('Enter a display name.');
      await put('contacts',id,{id,box:person.box,sign:person.sign,localName});
    });
  },
  async snapshot(since) {
    const {owner,model,events,favorites,outbox,failed} = await state();
    const pending = new Set(outbox.map(item => item.id));
    const failures = new Set(failed);
    const checksum = JSON.stringify([owner.card.id,events.map(event => event.id),favorites,
      [...model.people.values()].map(person => [person.id,person.localName]),[...pending],failed]);
    if (checksum !== lastView) {
      revision += 1;
      lastView = checksum;
    }
    const result = {revision,now:Date.now()};
    if (since === revision) return result;
    return {...result,me:owner.card.id,groups:[...model.groups.values()],threads:[...model.threads.values()],
      messages:[...model.messages.values()].map(message => ({...message,pending:pending.has(message.id),failed:failures.has(message.id)})),
      people:[...model.people.values()].map(person => ({
        id:person.id,name:person.localName || person.name || '',
        originalName:person.name || '',nickname:person.localName || ''
      })),favorites};
  },
  async change(action,fields) {
    return serialized(async () => {
      if (deleting) throw new Error('Account deletion in progress.');
      const {owner,model,events,favorites} = await state();
      if (action === 'favorite') {
        const next = new Set(favorites);
        if (fields.favorite) next.add(fields.thread);
        else next.delete(fields.thread);
        await put('meta','favorites',[...next]);
        return {};
      }
      let members;
      if (action === 'group') {
        members = [...new Set([owner.card.id,...fields.members])].sort();
        const cards = members.map(id => {
          const card = model.people.get(id);
          if (!card?.box || !card?.sign) throw new Error('Contact key unavailable.');
          return {id,box:card.box,sign:card.sign};
        });
        if (!fields.title?.trim()) throw new Error('Enter a title.');
        const prior = [...model.groups.values()].find(group => group.members.join() === members.join());
        if (prior) return {thread:prior.root};
        fields = {title:fields.title,cards};
      } else {
        const message = model.messages.get(fields.message);
        const thread = model.threads.get(message?.thread || fields.thread);
        members = model.groups.get(thread?.group)?.members;
        if (!members) throw new Error('Thread unavailable.');
      }
      if (action === 'send') {
        const prior = events.find(e => e.action === 'send' && e.author === owner.card.id && e.fields.nonce === fields.nonce);
        if (prior) return {message:prior.id};
      }
      const event = {
        id:crypto.randomUUID(),author:owner.card.id,name:owner.name,clock:model.clock+1,at:Date.now(),action,fields
      };
      const result = apply(model,event,owner.card.id);
      const envelopes = await Promise.all(members.filter(id => id !== owner.card.id).map(id => {
        const peer = model.people.get(id);
        if (!peer?.box) throw new Error('Contact key unavailable.');
        return seal(owner,peer,event);
      }));
      await saveEvents(owner,[event],[{id:event.id,envelopes,created:event.at,notify:action === 'send'}]);
      void requestSync(true);
      return result;
    });
  },
  async backup(passphrase) {
    return encryptBackup(await exportDevice(),passphrase);
  },
  async restore(content,passphrase) {
    return serialized(async () => {
      const backup = await decryptBackup(content,passphrase);
      const owner = backup.identity;
      if (!owner?.card || !isId(owner.token) || typeof owner.name !== 'string' ||
          ![backup.contacts,backup.events,backup.outbox].every(Array.isArray)) throw new Error('Invalid backup.');
      const current = await identity();
      if (current && current.card.id !== owner.card.id) throw new Error('Use a fresh installation to restore another identity.');
      const {card} = await verifyRegistration(await registration(owner),owner.token);
      const probe = {id:crypto.randomUUID(),author:card.id,clock:1,at:0,name:owner.name,action:'revive',fields:{}};
      // Check the stored encryption key as well as the signing key before committing the import.
      await openEnvelope(owner,{...await seal(owner,card,probe),sender:card});
      await restoreDevice(backup);
      void requestSync(true);
    });
  },
  async deleteEverywhere() {
    return serialized(async () => {
      const owner = await identity();
      deleting = true;
      try {
        if (pendingSync) await pendingSync;
        if (!owner) return;
        try { await register(owner); }
        catch (error) { if (error.status !== 409) throw error; }
        await relay('/delete',owner,{});
        await clearDevice();
        registered = '';
        connected = false;
      } finally {
        deleting = false;
      }
    });
  },
  async notificationControls() {
    const owner = await identity();
    if (!owner || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      throw new Error('Open the installed Thready app on a device that supports Web Push.');
    }
    const [worker,{key}] = await Promise.all([navigator.serviceWorker.ready,relay('/push-key')]);
    let subscription = await worker.pushManager.getSubscription();
    if (subscription) {
      const priorKey = subscription.options?.applicationServerKey;
      if (priorKey && b64(priorKey) !== key) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    return async enable => {
      if (enable) {
        if (Notification.permission === 'denied') throw new Error('Allow notifications in your device settings.');
        subscription ??= await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:unb64(key)});
        await register(owner);
        await relay('/push',owner,{subscription:subscription.toJSON(),language:document.documentElement.lang});
      } else if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        subscription = null;
        await relay('/push',owner,{remove:endpoint});
      }
    };
  }
};
