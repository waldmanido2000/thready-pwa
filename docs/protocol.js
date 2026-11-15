const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const bytes = value => encoder.encode(value);
export const utf8 = value => decoder.decode(value);
export const random = size => crypto.getRandomValues(new Uint8Array(size));
export function b64(value) {
  const input = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < input.length; offset += 8192) {
    binary += String.fromCharCode(...input.subarray(offset,offset+8192));
  }
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export const unb64 = value => Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')), x => x.charCodeAt(0));
export const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const isUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const curve = {name:'ECDH',namedCurve:'P-256'};
const signature = {name:'ECDSA',hash:'SHA-256'};
const signing = {name:'ECDSA',namedCurve:'P-256'};
const coords = key => [key.x,key.y];
const publicJwk = ([x,y]) => ({kty:'EC',crv:'P-256',x,y});
export const digest = async value => b64(await crypto.subtle.digest('SHA-256', bytes(value)));

export async function checkedCard(card) {
  if (!card || !isId(card.id) || !Array.isArray(card.box) || !Array.isArray(card.sign) ||
      card.box.length !== 2 || card.sign.length !== 2 || ![...card.box,...card.sign].every(isId)) throw new Error('Invalid contact key');
  if (await digest(JSON.stringify([card.box,card.sign])) !== card.id) throw new Error('Contact key mismatch');
  await Promise.all([
    crypto.subtle.importKey('jwk',publicJwk(card.box),curve,false,[]),
    crypto.subtle.importKey('jwk',publicJwk(card.sign),signing,false,['verify'])
  ]);
  return {id:card.id,box:card.box,sign:card.sign};
}

export async function createIdentity(name) {
  const [box, sign] = await Promise.all([
    crypto.subtle.generateKey(curve,true,['deriveKey']),
    crypto.subtle.generateKey(signing,true,['sign','verify'])
  ]);
  const card = {
    box:coords(await crypto.subtle.exportKey('jwk',box.publicKey)),
    sign:coords(await crypto.subtle.exportKey('jwk',sign.publicKey))
  };
  card.id = await digest(JSON.stringify([card.box,card.sign]));
  return {
    name, card, token:b64(random(32)),
    box:await crypto.subtle.exportKey('jwk',box.privateKey),
    sign:await crypto.subtle.exportKey('jwk',sign.privateKey)
  };
}

async function signValue(identity,value) {
  const key = await crypto.subtle.importKey('jwk',identity.sign,signing,false,['sign']);
  return b64(await crypto.subtle.sign(signature,key,bytes(value)));
}
async function verifyValue(card,value,proof) {
  const key = await crypto.subtle.importKey('jwk',publicJwk(card.sign),signing,false,['verify']);
  return crypto.subtle.verify(signature,key,unb64(proof),bytes(value));
}

export async function registration(identity) {
  const tokenHash = await digest(identity.token);
  return {card:identity.card,proof:await signValue(identity,'thready-register-v1:' + tokenHash)};
}

export async function verifyRegistration(input,token) {
  const card = await checkedCard(input.card);
  const tokenHash = await digest(token);
  if (typeof input.proof !== 'string' || input.proof.length !== 86 ||
      !await verifyValue(card,'thready-register-v1:' + tokenHash,input.proof)) throw new Error('Invalid registration proof');
  return {card, tokenHash};
}

async function sharedKey(identity,peer) {
  const own = await crypto.subtle.importKey('jwk',identity.box,curve,false,['deriveKey']);
  const other = await crypto.subtle.importKey('jwk',publicJwk(peer.box),curve,false,[]);
  return crypto.subtle.deriveKey({name:'ECDH',public:other},own,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
const associatedData = (id,from,to) => bytes(JSON.stringify(['thready-envelope-v1',id,from,to]));

export async function seal(identity, recipient, event) {
  const signed = JSON.stringify(event);
  const proof = await signValue(identity,signed);
  const text = bytes(JSON.stringify({signed,proof}));
  const iv = random(12);
  const key = await sharedKey(identity,recipient);
  const ciphertext = await crypto.subtle.encrypt({
    name:'AES-GCM',iv,additionalData:associatedData(event.id,identity.card.id,recipient.id)
  },key,text);
  return {id:event.id,to:recipient.id,iv:b64(iv),body:b64(ciphertext)};
}

export async function openEnvelope(identity,envelope) {
  if (envelope.to !== identity.card.id || !isUuid(envelope.id)) throw new Error('Wrong message recipient');
  const sender = await checkedCard(envelope.sender);
  const key = await sharedKey(identity,sender);
  const plaintext = await crypto.subtle.decrypt({
    name:'AES-GCM',iv:unb64(envelope.iv),additionalData:associatedData(envelope.id,sender.id,envelope.to)
  },key,unb64(envelope.body));
  const {signed,proof} = JSON.parse(utf8(plaintext));
  if (!await verifyValue(sender,signed,proof)) throw new Error('Invalid message signature');
  const event = JSON.parse(signed);
  if (event.id !== envelope.id || event.author !== sender.id || !Number.isSafeInteger(event.clock) ||
      event.clock < 1 || !Number.isSafeInteger(event.at) || event.at < 0 ||
      event.at > 8.64e15 || typeof event.name !== 'string' || event.name.length > 60) throw new Error('Invalid message');
  if (event.action === 'group') {
    if (!Array.isArray(event.fields?.cards) || event.fields.cards.length < 2 || event.fields.cards.length > 51) throw new Error('Invalid group');
    event.fields.cards = await Promise.all(event.fields.cards.map(checkedCard));
  }
  return {event,sender};
}

async function backupKey(password,salt) {
  const key = await crypto.subtle.importKey('raw',bytes(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

export async function encryptBackup(data,password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a backup passphrase of at least 12 characters.');
  const salt = random(16), iv = random(12);
  const key = await backupKey(password,salt);
  const plaintext = bytes(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plaintext);
  // Encode in chunks because backups can be much larger than a chat message.
  const input = new Uint8Array(ciphertext);
  let encoded = '';
  for (let i = 0; i < input.length; i += 24576) encoded += b64(input.subarray(i,i+24576));
  return JSON.stringify({format:'thready-pwa-v1',salt:b64(salt),iv:b64(iv),body:encoded});
}

export async function decryptBackup(raw,password) {
  const file = JSON.parse(raw);
  if (file.format !== 'thready-pwa-v1') throw new Error('Choose a Thready PWA backup file.');
  try {
    const salt = unb64(file.salt), iv = unb64(file.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error('Invalid backup');
    const key = await backupKey(password,salt);
    return JSON.parse(utf8(await crypto.subtle.decrypt({name:'AES-GCM',iv},key,unb64(file.body))));
  } catch {
    throw new Error('Could not open the backup. Check the file and passphrase.');
  }
}
