import {get} from '../../docs/database.js';
import {relay,storeEnvelopes} from '../../docs/network.js';

const cacheName = 'thready-pwa-shell-' + __SHELL_VERSION__;
const shell = [
  './','./index.html','./app.js','./config.js','./protocol.js','./database.js',
  './model.js','./network.js','./client.js','./style.css','./language.js',
  './manifest.webmanifest','./icons/thready-192.png','./icons/thready-512.png'
];

self.addEventListener('install',event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(shell.map(url => new Request(url,{cache:'reload'})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(key => key.startsWith('thready-pwa-shell-') && key !== cacheName)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !url.href.startsWith(self.registration.scope)) return;
  if (event.request.mode === 'navigate') {
    if (![self.registration.scope,new URL('index.html',self.registration.scope).href].includes(url.origin + url.pathname)) return;
    event.respondWith(caches.open(cacheName).then(cache => cache.match('./index.html')));
  } else if (shell.some(path => new URL(path,self.registration.scope).href === url.href)) {
    event.respondWith(caches.open(cacheName).then(async cache => await cache.match(event.request) || fetch(event.request)));
  }
});

self.addEventListener('push',event => event.waitUntil(receivePush(event)));
async function receivePush(event) {
  let push;
  try { push = event.data?.json(); }
  catch { return; }
  if (push?.v !== 1) return;
  const label = push.test
    ? (push.lang === 'he' ? 'התראת בדיקה מ־Thready' : 'Thready test notification')
    : (push.lang === 'he' ? 'הודעה חדשה ב־Thready' : 'New message in Thready');
  const notice = self.registration.showNotification(label,{
    icon:'./icons/thready-192.png',
    tag:'thready-' + push.id,
    data:{id:push.test ? null : push.id}
  });
  try {
    if (push.envelope) {
      const owner = await get('meta','identity');
      if (owner) {
        const {accepted} = await storeEnvelopes(owner,[push.envelope]);
        if (accepted.length) await relay('/ack',owner,{accepted}).catch(() => {});
      }
    }
    const windows = await self.clients.matchAll({type:'window'});
    for (const client of windows) client.postMessage({type:'thready:update'});
  } finally {
    await notice;
  }
}

self.addEventListener('notificationclick',event => {
  event.notification.close();
  event.waitUntil((async () => {
    const id = event.notification.data?.id;
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      existing.postMessage({type:'thready:update',open:id});
      await existing.focus();
      return;
    }
    const page = new URL(self.registration.scope);
    if (id) page.searchParams.set('message',id);
    await self.clients.openWindow(page.href);
  })());
});
