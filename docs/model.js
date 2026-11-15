import {isId,isUuid} from './protocol.js';

function requireValue(condition,message) {
  if (!condition) throw new Error(message);
}

function str(value,max,message) {
  requireValue(typeof value === 'string' && value.trim().length && value.length <= max,message);
  return value.trim();
}

const newThread = (id,group,parent,title,source,at) => ({
  id,group,parent,title,source,days:30,sleep:false,activity:at
});
const sameMembers = (a,b) => a.length === b.length && a.every((member,i) => member === b[i]);

export function emptyModel(identity,contacts) {
  const people = new Map(contacts.map(person => [person.id,person]));
  people.set(identity.card.id,{...identity.card,name:identity.name});
  return {groups:new Map(),threads:new Map(),messages:new Map(),people};
}

export function apply(model,event,localId) {
  const {id,author,action,fields:f,at} = event;
  const {groups,threads,messages,people} = model;
  requireValue(f && typeof f === 'object','Invalid action.');
  const thread = id => {
    const entry = threads.get(id);
    requireValue(entry && groups.get(entry.group)?.members.includes(author),'Thread unavailable.');
    return entry;
  };
  switch (action) {
    case 'group': {
      const title = str(f.title,100,'Enter a title.');
      const cards = f.cards;
      requireValue(Array.isArray(cards) && cards.length >= 2 && cards.length <= 51,'Choose 1 to 50 contacts.');
      const members = [...new Set(cards.map(card => card.id))].sort();
      requireValue(members.length === cards.length && members.every(isId) &&
        members.includes(author) && members.includes(localId),'Invalid participants.');
      for (const card of cards) if (!people.has(card.id)) people.set(card.id,card);
      groups.set(id,{id,members,root:id});
      threads.set(id,newThread(id,id,'',title,'',at));
      return {thread:id};
    }
    case 'branch': {
      const parent = thread(f.thread);
      const title = str(f.title,100,'Enter a title.');
      const anchor = messages.get(f.source);
      requireValue(!f.source || (anchor && !anchor.deleted && anchor.thread === parent.id),'Message unavailable.');
      threads.set(id,newThread(id,parent.group,parent.id,title,f.source || '',at));
      return {thread:id};
    }
    case 'threadSettings': {
      const entry = thread(f.thread);
      const days = Number(f.days);
      requireValue(Number.isInteger(days) && days >= 1 && days <= 3650,'Choose a decay period between 1 and 3,650 days.');
      entry.title = str(f.title,100,'Enter a title.');
      entry.days = days;
      break;
    }
    case 'dormant':
    case 'revive': {
      const entry = thread(f.thread);
      entry.sleep = action === 'dormant';
      if (!entry.sleep) entry.activity = at;
      break;
    }
    case 'move': {
      const entry = thread(f.thread);
      const dest = thread(f.destination);
      requireValue(entry.parent && dest.group === entry.group,'Choose a destination with the same participants.');
      for (let cursor = dest; cursor; cursor = threads.get(cursor.parent)) {
        requireValue(cursor.id !== entry.id,'A thread cannot be moved inside itself or its descendants.');
      }
      if (dest.id !== entry.parent) {
        entry.parent = dest.id;
        entry.source = '';
      }
      break;
    }
    case 'send': {
      const entry = thread(f.thread);
      const text = str(f.text,12000,'Enter a message of up to 12,000 characters.');
      messages.set(id,{id,thread:entry.id,author,text,at});
      entry.sleep = false;
      entry.activity = at;
      return {message:id};
    }
    case 'edit':
    case 'deleteMessage':
    case 'moveMessage': {
      const message = messages.get(f.message);
      requireValue(message?.author === author && !message.deleted,'Your message is unavailable.');
      const source = thread(message.thread);
      if (action === 'edit') {
        message.text = str(f.text,12000,'Enter a message of up to 12,000 characters.');
        message.edited = at;
      } else if (action === 'deleteMessage') {
        Object.assign(message,{text:'',deleted:true,deletedAt:at});
      } else {
        const dest = thread(f.destination);
        requireValue(sameMembers(groups.get(source.group).members,groups.get(dest.group).members),
          'Choose a destination with the same participants.');
        requireValue(source.id === f.thread,'The message has already moved. Open its current thread.');
        Object.assign(message,{thread:dest.id,moved:at});
        dest.sleep = false;
        dest.activity = at;
      }
      break;
    }
    default: throw new Error('Invalid action.');
  }
  return {};
}

export function replay(identity,contacts,events) {
  const model = emptyModel(identity,contacts);
  const order = [...events].sort((a,b) => a.clock-b.clock || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let clock = 0;
  for (const event of order) {
    if (!isUuid(event.id) || !Number.isSafeInteger(event.clock)) continue;
    clock = Math.max(clock,event.clock);
    try {
      apply(model,event,identity.card.id);
      const person = model.people.get(event.author);
      if (person && event.name && event.author !== identity.card.id) {
        model.people.set(event.author,{...person,name:event.name});
      }
    } catch {
      // A concurrent move can invalidate another action. Replay order is identical on all devices.
    }
  }
  return {...model,clock};
}
