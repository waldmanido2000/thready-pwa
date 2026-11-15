# Thready PWA

A Hebrew-first, installable version of Thready for text and links. Every participant keeps their own local threads and contacts. GitHub Pages serves the app. A Cloudflare Worker and D1 provide exact-ID contact lookup, offline delivery, and Web Push.

The project is ready to configure and deploy. Use the steps below with your own accounts. The sample GitHub and Cloudflare names throughout are placeholders.

## What you need

- A free GitHub account and a free Cloudflare account.
- [Node.js 22.12 or newer](https://nodejs.org/en/download), Git, and a terminal. The commands below work in PowerShell on Windows.
- An email address to put in the Web Push sender configuration. App users use a Thready ID.

Extract the ZIP. Open the **Thready-PWA** folder in VS Code or open a terminal there. This folder contains `docs`, `worker`, and this README.

## 1. Create the GitHub repository

On GitHub, create an empty **public** repository named `thready-pwa`. Leave the options to initialize a README, license, and .gitignore unchecked. Note your GitHub username. This example uses `YOUR-GITHUB-USERNAME`.

Your app URL will be:

```text
https://YOUR-GITHUB-USERNAME.github.io/thready-pwa/
```

GitHub Pages sites on the same `USERNAME.github.io` hostname share a browser origin. Use a dedicated hostname for Thready if you publish untrusted content on that hostname. Keep the hostname and app URL stable after users start storing data.

## 2. Create the Cloudflare database

From the **Thready-PWA** folder:

```powershell
cd worker
npm ci
npx wrangler login
npx wrangler d1 create thready-delivery
```

Wrangler opens a browser for sign-in. After the database is created, copy its `database_id` from the terminal. If an account picker appears, select the same account for D1 and Workers.

Open **worker/wrangler.toml** in VS Code and edit these three values:

| Setting | What to enter |
|---|---|
| `APP_ORIGIN` | `https://YOUR-GITHUB-USERNAME.github.io`, without the repo path or trailing slash. Use the hostname exactly as it appears in the browser, in lowercase. |
| `VAPID_SUBJECT` | `mailto:your-real-email@example.com`, using your email address. |
| `database_id` | The Cloudflare database ID from the previous command. |

Keep the existing `DB` binding. If the dashboard asks you to create a free `workers.dev` subdomain, follow its prompt.

Run these commands from **worker**:

```powershell
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

Approve the database migration when prompted. Copy the deployed Worker URL, for example `https://thready-delivery.your-subdomain.workers.dev`. Open it in a browser. It should return JSON with `"service":"Thready delivery"`.

## 3. Enable Web Push on the Worker

Run from **worker**:

```powershell
npm run keys
```

The output contains a `publicKey` and a `privateKey`. Run each command below and paste the matching value when prompted, without the quotation marks.

```powershell
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

Save the key pair in your own password manager. The **private key belongs in Cloudflare secrets**. The app retrieves the public key from the Worker automatically. Changing the keys later means users need to enable notifications again.

Open the Worker URL followed by `/push-key` in a browser to confirm it returns the public key.

## 4. Point Thready at the Worker and publish it

Edit **docs/config.js** and enter your Worker URL without a trailing slash:

```javascript
export const RELAY_URL = 'https://thready-delivery.YOUR-SUBDOMAIN.workers.dev';
```

From **worker**, rebuild the service worker after editing the URL. This copies the relay configuration into the background push handler and sets the offline cache version.

```powershell
npm run build:pwa
cd ..
git init -b main
git add .
git commit -m "Publish Thready PWA"
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/thready-pwa.git
git push -u origin main
```

If Git asks for your name/email, set them in Git and repeat the commit. If Git asks you to authenticate, complete Git Credential Manager’s browser flow or use an authenticated GitHub client.

On GitHub, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**. Set the branch to **main**, the folder to **/docs**, and click **Save**. Wait for the Pages workflow to complete in the **Actions** tab, then open the GitHub Pages URL over HTTPS. [GitHub Pages configuration](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 5. Install and verify on two devices

1. **iPhone or iPad** — Open your app URL in Safari, tap **Share → Add to Home Screen**, and then launch Thready from the icon. Web Push requires iOS or iPadOS 16.4 or newer. **Android** — Open the URL in Chrome and choose **Install app** or **Add to Home screen**. On desktop, use the Install option in Chrome or Edge. [Apple Web Push behavior](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
2. Create a different Thready identity on each device. Wait until each says **Connected**. Use **Menu → Language → English** if desired.
3. On the second device, open **Share my Thready ID** and copy the ID or invite link. On the first, use **Add contact** and paste it. Try this while the second device is offline after registration. The first device still needs internet for the lookup.
4. Open **New conversation**, choose the contact, and send text or an HTTPS link. Turn off internet on the receiving device, send another message, and close Thready on the sender once **Pending upload** disappears. Reconnect the recipient and open the app. The queued message should appear.
5. On the receiving device, use **Menu → Notifications → Enable notifications** and grant permission. Close Thready normally, lock the screen, and send a short test from the other device while the receiver has internet. Expect a generic alert. Tap it to open the message. Sound and lock-screen behavior are controlled by device notification settings.
6. Try **Menu → Backup** and download the encrypted backup. Keep its passphrase separately. Use **Load backup** on an empty installation or to merge a backup for the same identity.

## What is stored where

| Location | Data |
|---|---|
| Participant’s browser | Identity and private keys, local contact names, conversation events, favorites, and unsent updates. History is available offline after the app has loaded once. |
| Cloudflare Worker and D1 | Public contact keys and ID, a hash of the device credential, Web Push subscription, and encrypted envelopes awaiting delivery. The active queue clears ciphertext after receipt, or expires it after 30 days. Deduplication metadata can remain until expiry. Cloudflare Free D1’s recovery snapshots can contain previous encrypted queue data for up to seven days. |
| GitHub Pages | App files and the public relay URL. |

The app encrypts and signs conversation updates on-device. Short messages can be carried inside Web Push and saved by the recipient’s service worker. Longer text or links and missed pushes use the same encrypted queue. The notification itself is generic. Text is capped at 12,000 characters per message. Links open externally. [Cloudflare D1 retention](https://developers.cloudflare.com/d1/reference/time-travel/)

## Operational notes

- **One installation per identity.** Use an encrypted backup when moving to a replacement device, then use the replacement as the active installation. Keep browser data and the backup safe. Thready PWA uses a locally stored identity and a backup passphrase for recovery. The earlier Android app’s user IDs, passkeys, and backup files are specific to that edition.
- **Contact lookup uses exact IDs or invite links.** An identity must finish its first registration before another device can look it up. Local nicknames and address books stay in the browser.
- **Pending upload** means the update is still on the sender. When the label goes away, the relay has accepted it for processing. **Delivery failed for a participant** means an intended recipient was unavailable to the delivery service or the local outbox expired. The interface does not provide a read receipt.
- The local event history retains prior versions of edited or deleted messages for replay. The chat view shows the current version or the deletion marker.
- **Account deletion** removes local data, the public contact card, the push subscription record, and pending envelopes belonging to that ID. The relay keeps a minimal record to prevent that identity from registering again. Other participants control their local copies, and exported files remain usable as files. Deletion requires internet.
- The cryptography uses long-term device keys, with no forward secrecy or independent security audit. Anyone with access to the published app origin can change the code the browser runs. Protect your GitHub and Cloudflare accounts.
- The Cloudflare free tier currently includes 100,000 Worker requests per day and, for D1, 5 million row reads plus 100,000 row writes per day. A queue insertion and acknowledgment consume separate writes. Check the Workers and D1 dashboards for your actual usage. [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

## Updates and troubleshooting

| Symptom | Check |
|---|---|
| Thready stays offline | Open the Worker URL to confirm it responds. Recheck `docs/config.js`, the exact `APP_ORIGIN` in Wrangler, and whether the D1 migration ran on the remote database. |
| GitHub Pages shows 404 | Check **Settings → Pages** for **main /docs**, and wait for the Actions deploy. Use the URL ending in `/thready-pwa/`. |
| Contact ID gives 404 | Wait for **Connected** on the other user’s first run. Check that both copies of Thready use the same Worker URL. |
| iPhone can open the app but no push arrives | Launch the app from its Home Screen icon, check that **Enable notifications** succeeded, confirm the Worker secrets and `VAPID_SUBJECT`, and check iOS notifications and Focus settings. Try again while the device has internet. |
| Old settings are still visible after updating | Run `npm run build:pwa` from **worker**, commit both the edited files and regenerated **docs/sw.js**, and push again. Close and reopen Thready after Pages finishes publishing. Back up Thready before resetting any browser data. |

To update the frontend, rebuild with `npm run build:pwa` from **worker** and push your changes to GitHub. To update the backend, use `npm run deploy` from **worker**, applying any new migrations first.

## Source and local checks

The source was checked with the Cloudflare Worker and D1 running locally, two isolated Chromium sessions, and an injected Web Push event that exercised the service worker. The live iPhone and Android push checks are in step 5.

- `docs/` contains the static PWA. `worker/src/` contains the relay and service worker source. `worker/migrations/` contains the D1 schema. `docs/sw.js` is the generated service worker.
- From the project root, `npm test` runs the encryption, backup, and event replay tests.
- To run the local relay integration test, run `npx wrangler d1 migrations apply DB --local` and `npm run dev -- --port 8787 --var APP_ORIGIN:http://localhost:4173` from **worker**. In another terminal at the root, run `node tests/relay.mjs`. This test creates and deletes test users, so use a local database.
- The optional Chromium integration check uses Playwright from a Node installation where `require('playwright')` resolves. Temporarily set `docs/config.js` to `http://localhost:8787`, rebuild the PWA, and serve `docs/` as `http://localhost:4173/thready-pwa/` (or set `THREADY_TEST_URL` to the actual URL). Start the local Worker as above, then run `node tests/browser.cjs`. Restore your deployed relay URL and rebuild before publishing.
