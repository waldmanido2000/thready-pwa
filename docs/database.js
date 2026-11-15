const tables = ['meta','events','contacts','outbox'];
let database;

function ready() {
  database ??= new Promise((resolve,reject) => {
    const request = indexedDB.open('thready-pwa-v1',1);
    request.onupgradeneeded = () => {
      for (const name of tables) request.result.createObjectStore(name);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  return database;
}

async function run(names,mode,work) {
  const db = await ready();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(names,mode);
    tx.oncomplete = () => resolve(value?.result);
    tx.onabort = () => reject(tx.error || new Error('Device storage operation failed.'));
    let value;
    try { value = work(tx); }
    catch (error) { tx.abort(); reject(error); }
  });
}

export const get = (store,key) => run([store],'readonly',tx => tx.objectStore(store).get(key));
export const all = store => run([store],'readonly',tx => tx.objectStore(store).getAll());
export const put = (store,key,value) => run([store],'readwrite',tx => tx.objectStore(store).put(value,key));

export function saveEvents(identity,events,outbox = []) {
  return run(['meta','events','outbox'],'readwrite',tx => {
    const request = tx.objectStore('meta').get('identity');
    request.onsuccess = () => {
      if (request.result?.card.id !== identity.card.id) {
        tx.abort();
        return;
      }
      const target = tx.objectStore('events');
      for (const event of events) {
        const existing = target.get(event.id);
        existing.onsuccess = () => {
          if (!existing.result) target.add(event,event.id);
        };
      }
      for (const item of outbox) tx.objectStore('outbox').put(item,item.id);
    };
  });
}

export function settleOutbox(identity,id,failed) {
  return run(['meta','outbox'],'readwrite',tx => {
    const meta = tx.objectStore('meta');
    const request = meta.get('identity');
    request.onsuccess = () => {
      if (request.result?.card.id !== identity.card.id) {
        tx.abort();
        return;
      }
      tx.objectStore('outbox').delete(id);
      if (failed) {
        const list = meta.get('failed');
        list.onsuccess = () => meta.put([...new Set([...(list.result || []),id])],'failed');
      }
    };
  });
}

export function exportDevice() {
  return run(tables,'readonly',tx => {
    const capture = {};
    const reads = {
      identity:tx.objectStore('meta').get('identity'),
      favorites:tx.objectStore('meta').get('favorites'),
      failed:tx.objectStore('meta').get('failed'),
      events:tx.objectStore('events').getAll(),
      contacts:tx.objectStore('contacts').getAll(),
      outbox:tx.objectStore('outbox').getAll()
    };
    for (const [key,request] of Object.entries(reads)) request.onsuccess = () => { capture[key] = request.result; };
    return {result:capture};
  });
}

export function restoreDevice(data) {
  return run(tables,'readwrite',tx => {
    const meta = tx.objectStore('meta');
    const current = meta.get('identity');
    current.onsuccess = () => {
      if (current.result && current.result.card.id !== data.identity.card.id) {
        tx.abort();
        return;
      }
      meta.put(data.identity,'identity');
      for (const key of ['favorites','failed']) {
        const list = meta.get(key);
        list.onsuccess = () => meta.put([...new Set([...(data[key] || []),...(list.result || [])])],key);
      }
      for (const name of ['events','contacts','outbox']) {
        const store = tx.objectStore(name);
        for (const item of data[name]) {
          const existing = store.get(item.id);
          existing.onsuccess = () => {
            if (!existing.result) store.add(item,item.id);
          };
        }
      }
    };
  });
}

export function clearDevice() {
  return run(tables,'readwrite',tx => {
    for (const name of tables) tx.objectStore(name).clear();
  });
}
