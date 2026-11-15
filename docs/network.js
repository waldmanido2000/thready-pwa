import {RELAY_URL} from './config.js';
import {get,saveEvents} from './database.js';
import {openEnvelope,registration} from './protocol.js';

export async function relay(path,identity,body) {
  if (!RELAY_URL) throw new Error('Set the delivery service URL in docs/config.js.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),12000);
  try {
    const response = await fetch(RELAY_URL + path,{
      method:body === undefined ? 'GET' : 'POST',
      headers:{
        ...(identity ? {Authorization:'Bearer ' + identity.card.id + '.' + identity.token} : {}),
        ...(body === undefined ? {} : {'Content-Type':'application/json'})
      },
      body:body === undefined ? undefined : JSON.stringify(body),
      cache:'no-store',
      signal:controller.signal
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Delivery service unavailable.'),{status:response.status});
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function register(identity,invitation) {
  const proof = await registration(identity);
  return relay('/register',identity,{...proof,invitation});
}

export async function storeEnvelopes(identity,envelopes) {
  const accepted = [];
  const events = [];
  for (const envelope of envelopes) {
    const existing = await get('events',envelope.id);
    if (existing?.author === envelope.sender?.id) {
      accepted.push({id:envelope.id,from:envelope.sender.id});
      continue;
    }
    try {
      const {event,sender} = await openEnvelope(identity,envelope);
      if (existing) continue;
      events.push(event);
      accepted.push({id:event.id,from:sender.id});
    } catch {
      // Leave unverified packets unacknowledged. The relay expires them automatically.
    }
  }
  if (events.length) await saveEvents(identity,events);
  return {accepted,events};
}
