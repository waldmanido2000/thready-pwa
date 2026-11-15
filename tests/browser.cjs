const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const appUrl = process.env.THREADY_TEST_URL || 'http://localhost:4173/thready-pwa/';
const relayUrl = process.env.THREADY_TEST_RELAY || 'http://localhost:8787';

(async () => {
  const browser = await chromium.launch({
    executablePath:process.env.THREADY_CHROMIUM || undefined,headless:true
  });
  const errors = [];
  try {
    async function setup(name) {
      const context = await browser.newContext({permissions:['notifications']});
      await context.addInitScript(() => localStorage.setItem('thready-language','en'));
      const page = await context.newPage();
      page.on('pageerror',error => errors.push(error.message));
      await page.goto(appUrl);
      await page.getByLabel('Display name').fill(name);
      await page.getByRole('button',{name:'Create account'}).click();
      await page.getByText('Connected',{exact:true}).waitFor();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      const owner = await page.evaluate(async () => (await import('./client.js')).identity());
      return {context,page,owner};
    }
    async function flush(page) {
      await page.evaluate(async () => {
        const {requestSync} = await import('./client.js');
        await requestSync(true);
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    async function send(page,text) {
      await page.getByRole('textbox',{name:'Message',exact:true}).fill(text);
      await page.getByRole('button',{name:'Send',exact:true}).click();
      await page.getByText(text,{exact:true}).waitFor();
    }
    async function inbox(owner) {
      const response = await fetch(relayUrl + '/inbox',{
        headers:{Authorization:'Bearer ' + owner.card.id + '.' + owner.token}
      });
      assert.equal(response.status,200);
      return (await response.json()).envelopes;
    }
    const alice = await setup('Alice');
    const bob = await setup('Bob');
    await bob.page.close();
    await alice.page.getByRole('button',{name:'Add contact',exact:true}).click();
    await alice.page.getByLabel('Thready ID or invite link').fill(bob.owner.card.id);
    await alice.page.getByLabel('Nickname on this device').fill('Bob');
    await alice.page.getByRole('dialog').getByRole('button',{name:'Add contact',exact:true}).click();
    await alice.page.getByText('Contact added.',{exact:true}).waitFor();
    await alice.page.getByRole('button',{name:'New conversation',exact:true}).click();
    await alice.page.getByLabel('Title',{exact:true}).fill('Test conversation');
    await alice.page.getByRole('checkbox').check();
    await alice.page.getByRole('button',{name:'Open conversation'}).click();
    await alice.page.getByRole('heading',{name:'Test conversation'}).waitFor();
    await alice.context.setOffline(true);
    await send(alice.page,'Waiting to send');
    await alice.page.getByText(/Pending upload/).waitFor();
    await alice.page.reload();
    await alice.page.getByRole('button',{name:/^Test conversation/}).click();
    await alice.page.getByText('Waiting to send',{exact:true}).waitFor();
    await alice.context.setOffline(false);
    await flush(alice.page);
    assert.equal((await inbox(bob.owner)).length,2);
    bob.page = await bob.context.newPage();
    await bob.page.goto(appUrl);
    await bob.page.getByRole('button',{name:/^Test conversation/}).click();
    await bob.page.getByText('Waiting to send',{exact:true}).waitFor();
    assert.equal((await inbox(bob.owner)).length,0);
    await send(bob.page,'Reply with a text link');
    await flush(bob.page);
    await flush(alice.page);
    await alice.page.getByText('Reply with a text link',{exact:true}).waitFor();
    await alice.page.getByRole('button',{name:'New branch'}).click();
    await alice.page.getByLabel('Title',{exact:true}).fill('Side topic');
    await alice.page.getByRole('button',{name:'Create branch'}).click();
    await alice.page.getByRole('heading',{name:'Side topic'}).waitFor();
    await send(alice.page,'Side topic message');
    await flush(alice.page);
    await flush(bob.page);
    await bob.page.getByRole('button',{name:/Threads \(1\)/}).click();
    await bob.page.getByRole('dialog').getByRole('button',{name:/Side topic/}).click();
    await bob.page.getByText('Side topic message',{exact:true}).waitFor();
    if (process.env.THREADY_TEST_PUSH) {
      const session = await bob.context.newCDPSession(bob.page);
      let registration;
      session.on('ServiceWorker.workerRegistrationUpdated', ({registrations}) => {
        registration = registrations.find(item => !item.isDeleted && item.scopeURL === appUrl);
      });
      await session.send('ServiceWorker.enable');
      await bob.page.route(relayUrl + '/inbox*',route => route.abort());
      await send(alice.page,'Pushed text https://example.com/');
      await flush(alice.page);
      const [envelope] = await inbox(bob.owner);
      assert.ok(registration);
      await session.send('ServiceWorker.deliverPushMessage',{
        origin:new URL(appUrl).origin,registrationId:registration.registrationId,
        data:JSON.stringify({v:1,id:envelope.id,lang:'en',envelope})
      });
      await bob.page.waitForFunction(async id => {
        const {get} = await import('./database.js');
        return (await get('events',id))?.fields?.text === 'Pushed text https://example.com/';
      },envelope.id);
      for (let i = 0; i < 20 && (await inbox(bob.owner)).length; i++) await bob.page.waitForTimeout(100);
      assert.equal((await inbox(bob.owner)).length,0);
    }
    if (process.env.THREADY_TEST_SCREENSHOT) await bob.page.screenshot({path:process.env.THREADY_TEST_SCREENSHOT});
    assert.deepEqual(errors,[]);
    console.log('Chromium integration passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error);process.exitCode = 1; });
