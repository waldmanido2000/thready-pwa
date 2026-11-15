import {all,get,put,saveEvents,settleOutbox,exportDevice,restoreDevice,lockDevice,clearDevice} from './database.js';
import {b64,unb64,checkedCard,createIdentity,seal,openEnvelope,isId,encryptBackup,decryptBackup,registration,verifyRegistration,signInLookup} from './protocol.js';
import {apply,replay} from './model.js';
import {relay,register,storeEnvelopes} from './network.js';

let pendingSync;
let connected = false;
let registered = '';
let lastPull = 0;
let writes = Promise.resolve();
let lastView = '';
let revision = 0;
let sessionChanging = false;

export const isConnected = () => connected && navigator.onLine;
export const identity = () => get('meta','identity');
export const signInConfigured = async () => Boolean(await get('meta','signIn'));
export const signedOut = async () => Boolean(await get('meta','locked'));
export function requestSync(force = false) {
  if (sessionChanging) return Promise.resolve();
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

async function checkIdentity(owner,id = owner?.card?.id) {
  if (!isId(id) || owner?.card?.id !== id || !isId(owner.token) || typeof owner.name !== 'string') {
    throw new Error('Invalid backup.');
  }
  const {card} = await verifyRegistration(await registration(owner),owner.token);
  const probe = {id:crypto.randomUUID(),author:card.id,clock:1,at:0,name:owner.name,action:'revive',fields:{}};
  await openEnvelope(owner,{...await seal(owner,card,probe),sender:card});
}

function openForSignIn(capsule,passphrase) {
  return decryptBackup(capsule,passphrase).catch(() => { throw new Error('That Thready ID and passphrase did not match.'); });
}

export const localActions = {
  async create(name,invitation,requireOnline) {
    return serialized(async () => {
      name = name.trim();
      if (!name || name.length > 60) throw new Error('Enter a display name.');
      if (await identity() || await signedOut()) throw new Error('This installation already has an identity.');
      if (invitation && !isId(invitation)) throw new Error('Enter a valid invitation link.');
      let owner = (await get('meta','pendingRegistration'))?.owner;
      if (!owner) {
        owner = await createIdentity(name);
        await put('meta','pendingRegistration',{owner});
      }
      if (invitation || requireOnline) {
        await register(owner,invitation || undefined);
        registered = owner.card.id;
      }
      await put('meta','identity',{...owner,name});
      await put('meta','pendingRegistration',null);
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      void requestSync(true);
    });
  },
  async getId() {
    return (await identity())?.card.id;
  },
  async invitationRequired() {
    return (await relay('/invitations/status')).required;
  },
  async canInvite() {
    const owner = await identity();
    return Boolean(owner && (await relay('/invitations/admin',owner)).allowed);
  },
  async createInvitation() {
    const {invitation} = await relay('/invitations',await identity(),{});
    return invitation;
  },
  async redeemInvitation(invitation) {
    if (!isId(invitation)) throw new Error('Enter a valid invitation link.');
    await register(await identity(),invitation);
  },
  async contact(id,name) {
    return serialized(async () => {
      const owner = await identity();
      if (!owner || !isId(id) || id === owner.card.id) throw new Error('Enter a valid Thready ID.');
      const localName = name.trim();
      if (localName.length > 60) throw new Error('Enter a display name.');
      const {card} = await relay('/contact?id=' + encodeURIComponent(id));
      const verified = await checkedCard(card);
      await put('contacts',id,{...verified,localName});
    });
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
      if (sessionChanging) throw new Error('An account operation is in progress.');
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
  async configureSignIn(passphrase) {
    return serialized(async () => {
      const owner = await identity();
      if (!owner) throw new Error('Create an identity first.');
      if (passphrase.length < 12 || passphrase.length > 128) {
        throw new Error('Use a sign-in passphrase of at least 12 characters.');
      }
      const id = owner.card.id;
      const lookup = await signInLookup(id,passphrase);
      let capsule = await encryptBackup(owner,passphrase);
      await register(owner);
      try { await relay('/sign-in/setup',owner,{lookup,capsule}); }
      catch (error) {
        if (error.status !== 409) throw error;
        ({capsule} = await relay('/sign-in',null,{id,lookup}));
        await checkIdentity(await openForSignIn(capsule,passphrase),id);
      }
      await put('meta','signIn',{capsule});
    });
  },
  async signOut(passphrase) {
    return serialized(async () => {
      const owner = await identity();
      const signIn = await get('meta','signIn');
      if (!owner || !signIn) throw new Error('Set up sign-in first.');
      sessionChanging = true;
      try {
        if (pendingSync) await pendingSync;
        const check = await openForSignIn(signIn.capsule,passphrase);
        if (check?.card?.id !== owner.card.id || check.token !== owner.token) {
          throw new Error('That Thready ID and passphrase did not match.');
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const {stamp,...device} = await exportDevice(true);
          const vault = await encryptBackup({device,signIn},passphrase);
          if (await lockDevice(owner.card.id,stamp,vault)) {
            connected = false;
            registered = '';
            return;
          }
        }
        throw new Error('Device data changed during sign-out. Try again.');
      } finally {
        sessionChanging = false;
      }
    });
  },
  async signIn(id,passphrase) {
    return serialized(async () => {
      if (await identity()) throw new Error('Sign out before signing in again.');
      const locked = await get('meta','locked');
      if (locked) {
        const {device,signIn} = await openForSignIn(locked.vault,passphrase);
        await checkIdentity(device.identity,locked.id);
        await restoreDevice(device,{unlock:locked.stamp,signIn});
      } else {
        const lookup = await signInLookup(id,passphrase);
        const {capsule} = await relay('/sign-in',null,{id,lookup});
        const owner = await openForSignIn(capsule,passphrase);
        await checkIdentity(owner,id);
        await restoreDevice({identity:owner,events:[],contacts:[],outbox:[]},{signIn:{capsule}});
        if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      }
      void requestSync(true);
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
      await checkIdentity(owner);
      await restoreDevice(backup);
      void requestSync(true);
    });
  },
  async deleteEverywhere() {
    return serialized(async () => {
      const owner = await identity();
      sessionChanging = true;
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
        sessionChanging = false;
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
    return {
      async enable() {
        if (Notification.permission === 'denied') throw new Error('Allow notifications in your device settings.');
        subscription ??= await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:unb64(key)});
        await register(owner);
        await relay('/push',owner,{subscription:subscription.toJSON(),language:document.documentElement.lang});
      },
      async disable() {
        if (!subscription) return;
        await relay('/push',owner,{remove:subscription.endpoint});
        await subscription.unsubscribe();
        subscription = null;
      },
      async test() {
        if (Notification.permission !== 'granted' || !subscription) {
          throw new Error('Enable notifications in this browser before testing.');
        }
        try { await relay('/push/test',owner,{endpoint:subscription.endpoint}); }
        catch (error) {
          if (error.status === 410) {
            await subscription.unsubscribe().catch(() => {});
            subscription = null;
          }
          throw error;
        }
      }
    };
  }
};
