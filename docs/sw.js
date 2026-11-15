(() => {
  // ../docs/database.js
  var tables = ["meta", "events", "contacts", "outbox"];
  var database;
  function ready() {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("thready-pwa-v1", 1);
      request.onupgradeneeded = () => {
        for (const name of tables) request.result.createObjectStore(name);
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return database;
  }
  async function run(names, mode, work) {
    const db = await ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      tx.oncomplete = () => resolve(value?.result);
      tx.onabort = () => reject(tx.error || new Error("Device storage operation failed."));
      let value;
      try {
        value = work(tx);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }
  var get = (store, key) => run([store], "readonly", (tx) => tx.objectStore(store).get(key));
  function saveEvents(identity, events, outbox = []) {
    return run(["meta", "events", "outbox"], "readwrite", (tx) => {
      const request = tx.objectStore("meta").get("identity");
      request.onsuccess = () => {
        if (request.result?.card.id !== identity.card.id) {
          tx.abort();
          return;
        }
        const target = tx.objectStore("events");
        for (const event of events) {
          const existing = target.get(event.id);
          existing.onsuccess = () => {
            if (!existing.result) target.add(event, event.id);
          };
        }
        for (const item of outbox) tx.objectStore("outbox").put(item, item.id);
      };
    });
  }

  // ../docs/config.js
  var RELAY_URL = "";

  // ../docs/protocol.js
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();
  var bytes = (value) => encoder.encode(value);
  var utf8 = (value) => decoder.decode(value);
  function b64(value) {
    const input = new Uint8Array(value);
    let binary = "";
    for (let offset = 0; offset < input.length; offset += 8192) {
      binary += String.fromCharCode(...input.subarray(offset, offset + 8192));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }
  var unb64 = (value) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (x) => x.charCodeAt(0));
  var isId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  var isUuid = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
  var curve = { name: "ECDH", namedCurve: "P-256" };
  var signature = { name: "ECDSA", hash: "SHA-256" };
  var signing = { name: "ECDSA", namedCurve: "P-256" };
  var publicJwk = ([x, y]) => ({ kty: "EC", crv: "P-256", x, y });
  var digest = async (value) => b64(await crypto.subtle.digest("SHA-256", bytes(value)));
  async function checkedCard(card) {
    if (!card || !isId(card.id) || !Array.isArray(card.box) || !Array.isArray(card.sign) || card.box.length !== 2 || card.sign.length !== 2 || ![...card.box, ...card.sign].every(isId)) throw new Error("Invalid contact key");
    if (await digest(JSON.stringify([card.box, card.sign])) !== card.id) throw new Error("Contact key mismatch");
    await Promise.all([
      crypto.subtle.importKey("jwk", publicJwk(card.box), curve, false, []),
      crypto.subtle.importKey("jwk", publicJwk(card.sign), signing, false, ["verify"])
    ]);
    return { id: card.id, box: card.box, sign: card.sign };
  }
  async function verifyValue(card, value, proof) {
    const key = await crypto.subtle.importKey("jwk", publicJwk(card.sign), signing, false, ["verify"]);
    return crypto.subtle.verify(signature, key, unb64(proof), bytes(value));
  }
  async function sharedKey(identity, peer) {
    const own = await crypto.subtle.importKey("jwk", identity.box, curve, false, ["deriveKey"]);
    const other = await crypto.subtle.importKey("jwk", publicJwk(peer.box), curve, false, []);
    return crypto.subtle.deriveKey({ name: "ECDH", public: other }, own, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  var associatedData = (id, from, to) => bytes(JSON.stringify(["thready-envelope-v1", id, from, to]));
  async function openEnvelope(identity, envelope) {
    if (envelope.to !== identity.card.id || !isUuid(envelope.id)) throw new Error("Wrong message recipient");
    const sender = await checkedCard(envelope.sender);
    const key = await sharedKey(identity, sender);
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: unb64(envelope.iv),
      additionalData: associatedData(envelope.id, sender.id, envelope.to)
    }, key, unb64(envelope.body));
    const { signed, proof } = JSON.parse(utf8(plaintext));
    if (!await verifyValue(sender, signed, proof)) throw new Error("Invalid message signature");
    const event = JSON.parse(signed);
    if (event.id !== envelope.id || event.author !== sender.id || !Number.isSafeInteger(event.clock) || event.clock < 1 || !Number.isSafeInteger(event.at) || event.at < 0 || event.at > 864e13 || typeof event.name !== "string" || event.name.length > 60) throw new Error("Invalid message");
    if (event.action === "group") {
      if (!Array.isArray(event.fields?.cards) || event.fields.cards.length < 2 || event.fields.cards.length > 51) throw new Error("Invalid group");
      event.fields.cards = await Promise.all(event.fields.cards.map(checkedCard));
    }
    return { event, sender };
  }

  // ../docs/network.js
  async function relay(path, identity, body) {
    if (!RELAY_URL) throw new Error("Set the delivery service URL in docs/config.js.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12e3);
    try {
      const response = await fetch(RELAY_URL + path, {
        method: body === void 0 ? "GET" : "POST",
        headers: {
          ...identity ? { Authorization: "Bearer " + identity.card.id + "." + identity.token } : {},
          ...body === void 0 ? {} : { "Content-Type": "application/json" }
        },
        body: body === void 0 ? void 0 : JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || "Delivery service unavailable."), { status: response.status });
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
  async function storeEnvelopes(identity, envelopes) {
    const accepted = [];
    const events = [];
    for (const envelope of envelopes) {
      const existing = await get("events", envelope.id);
      if (existing?.author === envelope.sender?.id) {
        accepted.push({ id: envelope.id, from: envelope.sender.id });
        continue;
      }
      try {
        const { event, sender } = await openEnvelope(identity, envelope);
        if (existing) continue;
        events.push(event);
        accepted.push({ id: event.id, from: sender.id });
      } catch {
      }
    }
    if (events.length) await saveEvents(identity, events);
    return { accepted, events };
  }

  // src/service-worker.js
  var cacheName = "thready-pwa-shell-529717fee0352eb7";
  var shell = [
    "./",
    "./index.html",
    "./app.js",
    "./config.js",
    "./protocol.js",
    "./database.js",
    "./model.js",
    "./network.js",
    "./client.js",
    "./style.css",
    "./language.js",
    "./manifest.webmanifest",
    "./icons/thready-192.png",
    "./icons/thready-512.png"
  ];
  self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
      const cache = await caches.open(cacheName);
      await cache.addAll(shell.map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })());
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
      await Promise.all((await caches.keys()).filter((key) => key.startsWith("thready-pwa-shell-") && key !== cacheName).map((key) => caches.delete(key)));
      await self.clients.claim();
    })());
  });
  self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || !url.href.startsWith(self.registration.scope)) return;
    if (event.request.mode === "navigate") {
      if (![self.registration.scope, new URL("index.html", self.registration.scope).href].includes(url.origin + url.pathname)) return;
      event.respondWith(caches.open(cacheName).then((cache) => cache.match("./index.html")));
    } else if (shell.some((path) => new URL(path, self.registration.scope).href === url.href)) {
      event.respondWith(caches.open(cacheName).then(async (cache) => await cache.match(event.request) || fetch(event.request)));
    }
  });
  self.addEventListener("push", (event) => event.waitUntil(receivePush(event)));
  async function receivePush(event) {
    let push;
    try {
      push = event.data?.json();
    } catch {
      return;
    }
    if (push?.v !== 1) return;
    const label = push.lang === "he" ? "\u05D4\u05D5\u05D3\u05E2\u05D4 \u05D7\u05D3\u05E9\u05D4 \u05D1\u05BEThready" : "New message in Thready";
    const notice = self.registration.showNotification(label, {
      icon: "./icons/thready-192.png",
      tag: "thready-" + push.id,
      data: { id: push.id }
    });
    try {
      if (push.envelope) {
        const owner = await get("meta", "identity");
        if (owner) {
          const { accepted } = await storeEnvelopes(owner, [push.envelope]);
          if (accepted.length) await relay("/ack", owner, { accepted }).catch(() => {
          });
        }
      }
      const windows = await self.clients.matchAll({ type: "window" });
      for (const client of windows) client.postMessage({ type: "thready:update" });
    } finally {
      await notice;
    }
  }
  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil((async () => {
      const id = event.notification.data?.id;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
      if (existing) {
        existing.postMessage({ type: "thready:update", open: id });
        await existing.focus();
        return;
      }
      const page = new URL(self.registration.scope);
      if (id) page.searchParams.set("message", id);
      await self.clients.openWindow(page.href);
    })());
  });
})();
