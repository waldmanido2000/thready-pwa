import webpush from 'web-push';
import {bytes,digest,isId,isUuid,verifyRegistration} from '../../docs/protocol.js';

const retain = 30 * 24 * 60 * 60;
const epoch = () => Math.floor(Date.now()/1000);
const encoded = (value,min,max) => typeof value === 'string' && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);

class HttpError extends Error {
  constructor(status,message) {
    super(message);
    this.status = status;
  }
}
function check(condition,status,message) {
  if (!condition) throw new HttpError(status,message);
}

async function readJson(request,max) {
  check(request.headers.get('content-type')?.startsWith('application/json'),415,'JSON required.');
  const reader = request.body?.getReader();
  check(reader,400,'Request body required.');
  const decoder = new TextDecoder('utf-8',{fatal:true});
  let size = 0;
  let json = '';
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new HttpError(413,'Request too large.');
      }
      json += decoder.decode(value,{stream:true});
    }
    const result = JSON.parse(json + decoder.decode());
    check(result && typeof result === 'object' && !Array.isArray(result),400,'Invalid request.');
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400,'Invalid JSON.');
  } finally {
    reader.releaseLock();
  }
}

function credentials(request) {
  const bearer = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(bearer);
  check(match,401,'Sign in to the delivery service.');
  return {id:match[1],token:match[2]};
}

async function authenticate(request,env,allowDeleted = false) {
  const {id,token} = credentials(request);
  const account = await env.DB.prepare('SELECT card,token_hash,deleted FROM accounts WHERE id=?').bind(id).first();
  check(account && (allowDeleted || !account.deleted) && account.token_hash === await digest(token),401,'Delivery identity unavailable.');
  return {id,card:account.deleted ? null : JSON.parse(account.card)};
}

async function register(request,env) {
  const {id,token} = credentials(request);
  const input = await readJson(request,2048);
  let registration;
  try {
    registration = await verifyRegistration(input,token);
  } catch {
    throw new HttpError(400,'Invalid registration.');
  }
  const {card,tokenHash} = registration;
  check(card.id === id,400,'Invalid registration.');
  await env.DB.prepare('INSERT OR IGNORE INTO accounts (id,card,token_hash) VALUES (?,?,?)')
    .bind(id,JSON.stringify(card),tokenHash).run();
  const row = await env.DB.prepare('SELECT token_hash,deleted FROM accounts WHERE id=?').bind(id).first();
  check(row && !row.deleted && row.token_hash === tokenHash,409,'This Thready ID cannot register.');
  return {id};
}

async function contact(url,env) {
  const id = url.searchParams.get('id');
  check(isId(id),400,'Enter a valid Thready ID.');
  const row = await env.DB.prepare('SELECT card FROM accounts WHERE id=? AND deleted=0').bind(id).first();
  check(row,404,'That Thready ID is not registered.');
  return {card:JSON.parse(row.card)};
}

async function enqueue(request,env,ctx,account) {
  const {envelopes,notify} = await readJson(request,8*1024*1024);
  check(Array.isArray(envelopes) && envelopes.length && envelopes.length <= 50 &&
    typeof notify === 'boolean',400,'Invalid outbound packet.');
  const ids = new Set();
  for (const item of envelopes) {
    check(item && item.id === envelopes[0].id && isUuid(item.id) && isId(item.to) && item.to !== account.id &&
      encoded(item.iv,16,16) && encoded(item.body,22,145000) && !ids.has(item.to),400,'Invalid outbound packet.');
    ids.add(item.to);
  }
  const card = JSON.stringify(account.card);
  const expiration = epoch()+retain;
  const insert = env.DB.prepare(`INSERT OR IGNORE INTO delivery
    (sender_id,recipient_id,event_id,sender_card,iv,body,expires)
    SELECT ?,id,?,?,?,?,? FROM accounts WHERE id=? AND deleted=0
    AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND deleted=0)`);
  const results = await env.DB.batch(envelopes.map(item =>
    insert.bind(account.id,item.id,card,item.iv,item.body,expiration,item.to,account.id)));
  const added = envelopes.filter((item,i) => results[i].meta.changes === 1);
  if (notify && env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY && added.length) {
    ctx.waitUntil(sendNotifications(env,account,added).catch(() => {}));
  }
  const contacts = [...ids];
  const targets = await env.DB.prepare(`SELECT id FROM accounts WHERE deleted=0 AND id IN (${contacts.map(() => '?').join(',')})`)
    .bind(...contacts).all();
  const active = new Set(targets.results.map(target => target.id));
  return {unavailable:contacts.filter(id => !active.has(id))};
}

async function inbox(url,env,account) {
  const raw = url.searchParams.get('after') || '0';
  check(/^\d{1,15}$/.test(raw),400,'Invalid cursor.');
  const results = await env.DB.prepare(`SELECT seq,sender_card,recipient_id,event_id,iv,body FROM delivery
    WHERE recipient_id=? AND seq>? AND body IS NOT NULL AND expires>? ORDER BY seq LIMIT 25`)
    .bind(account.id,Number(raw),epoch()).all();
  return {
    envelopes:results.results.map(row => ({
      id:row.event_id,to:row.recipient_id,sender:JSON.parse(row.sender_card),iv:row.iv,body:row.body
    })),
    next:results.results.length === 25 ? String(results.results[24].seq) : ''
  };
}

async function acknowledge(request,env,account) {
  const {accepted} = await readJson(request,6000);
  check(Array.isArray(accepted) && accepted.length && accepted.length <= 25 &&
    accepted.every(item => isUuid(item?.id) && isId(item.from)),400,'Invalid acknowledgment.');
  const update = env.DB.prepare(`UPDATE delivery SET body=NULL,iv=NULL,sender_card=NULL
    WHERE recipient_id=? AND sender_id=? AND event_id=? AND body IS NOT NULL`);
  await env.DB.batch(accepted.map(item => update.bind(account.id,item.from,item.id)));
  return {ok:true};
}

function validEndpoint(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return false;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    return ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(url.hostname) ||
      url.hostname.endsWith('.push.apple.com') || url.hostname.endsWith('.notify.windows.com');
  } catch {
    return false;
  }
}

async function subscribe(request,env,account) {
  const {subscription,language,remove} = await readJson(request,4096);
  if (validEndpoint(remove)) {
    await env.DB.prepare('DELETE FROM subscriptions WHERE account_id=? AND endpoint=?').bind(account.id,remove).run();
    return {ok:true};
  }
  check(validEndpoint(subscription?.endpoint) && encoded(subscription.keys?.p256dh,87,87) &&
    encoded(subscription.keys?.auth,22,22),400,'Unsupported push subscription.');
  const value = JSON.stringify({endpoint:subscription.endpoint,keys:subscription.keys});
  // One active push subscription per Thready ID.
  await env.DB.prepare(`INSERT OR REPLACE INTO subscriptions (account_id,endpoint,subscription,language)
    VALUES (?,?,?,?)`).bind(account.id,subscription.endpoint,value,language === 'he' ? 'he' : 'en').run();
  return {ok:true};
}

async function sendNotifications(env,account,items) {
  const targets = await env.DB.prepare(`SELECT account_id,subscription,endpoint,language FROM subscriptions
    WHERE account_id IN (${items.map(() => '?').join(',')})`).bind(...items.map(item => item.to)).all();
  const byRecipient = new Map(items.map(item => [item.to,item]));
  for (let offset = 0; offset < targets.results.length; offset += 5) {
    await Promise.allSettled(targets.results.slice(offset,offset+5).map(async target => {
      const item = byRecipient.get(target.account_id);
      const base = {v:1,id:item.id,lang:target.language};
      const full = JSON.stringify({...base,envelope:{...item,sender:account.card}});
      const payload = bytes(full).length <= 3800 ? full : JSON.stringify(base);
      const details = webpush.generateRequestDetails(JSON.parse(target.subscription),payload,{
        TTL:3600,urgency:'high',vapidDetails:{
          subject:env.VAPID_SUBJECT,publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY
        }
      });
      const response = await fetch(details.endpoint,{
        method:'POST',headers:details.headers,body:details.body,redirect:'error',
        signal:AbortSignal.timeout(6000)
      });
      if (response.status === 404 || response.status === 410) {
        await env.DB.prepare('DELETE FROM subscriptions WHERE account_id=? AND endpoint=?')
          .bind(target.account_id,target.endpoint).run();
      } else if (!response.ok) {
        console.warn('Push provider rejected a request',response.status);
      }
      await response.body?.cancel();
    }));
  }
}

async function deleteAccount(env,account) {
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET deleted=1,card='' WHERE id=?").bind(account.id),
    env.DB.prepare('DELETE FROM subscriptions WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM delivery WHERE recipient_id=? OR sender_id=?').bind(account.id,account.id)
  ]);
  return {ok:true};
}

async function route(request,env,ctx) {
  const url = new URL(request.url);
  const action = request.method + ' ' + url.pathname;
  switch (action) {
    case 'GET /': return {service:'Thready delivery',version:1};
    case 'POST /register': return register(request,env);
    case 'GET /contact': return contact(url,env);
    case 'GET /push-key':
      check(env.VAPID_PUBLIC_KEY,503,'Notifications are not configured.');
      return {key:env.VAPID_PUBLIC_KEY};
    case 'POST /enqueue': return enqueue(request,env,ctx,await authenticate(request,env));
    case 'GET /inbox': return inbox(url,env,await authenticate(request,env));
    case 'POST /ack': return acknowledge(request,env,await authenticate(request,env));
    case 'POST /push': return subscribe(request,env,await authenticate(request,env));
    case 'POST /delete': return deleteAccount(env,await authenticate(request,env,true));
    default: throw new HttpError(404,'Unknown endpoint.');
  }
}

export default {
  async fetch(request,env,ctx) {
    const origin = request.headers.get('Origin');
    const headers = {
      'Access-Control-Allow-Origin':env.APP_ORIGIN,
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Authorization, Content-Type',
      'Access-Control-Max-Age':'3600',
      'Cache-Control':'no-store',
      Vary:'Origin'
    };
    const response = (body,status = 200) => Response.json(body,{status,headers});
    if (origin && origin !== env.APP_ORIGIN) return response({error:'Unexpected application origin.'},403);
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
    try {
      return response(await route(request,env,ctx));
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Delivery request failed',error.name);
      return response({error:error instanceof HttpError ? error.message : 'Delivery service unavailable.'},error.status || 500);
    }
  },
  async scheduled(_controller,env) {
    await env.DB.prepare('DELETE FROM delivery WHERE seq IN (SELECT seq FROM delivery WHERE expires<=? LIMIT 5000)')
      .bind(epoch()).run();
  }
};
