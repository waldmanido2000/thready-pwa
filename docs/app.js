import {identity,isConnected,localActions,requestSync,signInConfigured,signedOut} from './client.js';

const screen = document.querySelector('#screen');
const menu = document.querySelector('#menu');
const menuButton = document.querySelector('#menuButton');
const dialog = document.querySelector('#dialog');
const connection = document.querySelector('#connection');
const toast = document.querySelector('#toast');
const params = new URLSearchParams(location.hash.slice(1));
let invite = params.get('contact') || '';
let signupInvite = params.get('invite') || '';
if (signupInvite) {
  params.delete('invite');
  history.replaceState(history.state,'',location.pathname + location.search + (params.size ? '#' + params : ''));
}
let invitationRequired = null;
let admin = false;
let messageToOpen = new URLSearchParams(location.search).get('message') || '';
let token = '';
let passphraseSet = false;
let locked = false;
const sessionChannel = 'BroadcastChannel' in window ? new BroadcastChannel('thready-account-session') : null;
sessionChannel?.addEventListener('message',() => location.reload());
addEventListener('pageshow',event => { if (event.persisted) location.reload(); });

let data = null;
let lastConnection = {key:"",offline:false};
let current = '';
let toastTimer;
const sends = new Map();
let requestNumber = 0;
let appliedRequest = 0;
const drafts = new Map();
const byId = new Map();
const people = new Map();
const children = new Map();
const messages = new Map();
const messagesById = new Map();
const branchesBySource = new Map();
const latestMessage = new Map();
const groupActivity = new Map();
const groupsById = new Map();
const favorites = new Set();
const sleepStates = new Map();
const DAY = 86400000;

function el(tag, props = {}, ...items) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...items.flat().filter(item => item != null));
  return node;
}

function button(label, run, cls = '', extra = {}) {
  return el('button', {type:'button', class:cls, onclick:run, ...extra}, label);
}

function status(text, offline = false) {
  lastConnection = {key:text,offline};
  connection.textContent = tr(text);
  connection.classList.toggle('offline', offline);
}

function tell(text, open) {
  toast.replaceChildren(open ? button(text,() => { toast.hidden = true; open(); }) : text);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4100);
}

async function api(action,fields = {}) {
  if (action === 'snapshot') return localActions.snapshot(fields.since);
  return localActions.change(action,fields);
}

function showMenu(show) {
  menu.hidden = !show;
  menuButton.setAttribute('aria-expanded', String(show));
}

function modal(title, content) {
  if (dialog.open) dialog.close();
  dialog.replaceChildren(el('div',{class:'modal-head'},el('h2',{},title),button('×', () => dialog.close(), 'quiet', {'aria-label':tr('Close')})),content);
  dialog.showModal();
}

function openForm(title, submitLabel, fields, onSave, modalForm = true) {
  const error = el('div',{class:'error',role:'alert',hidden:true});
  const submit = el('button',{type:'submit',class:'primary'},submitLabel);
  const form = el('form',{class:'form'},fields,error,submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    error.hidden = true;
    try {
      await onSave(Object.fromEntries(new FormData(form)));
      if (modalForm && dialog.contains(form)) dialog.close();
    } catch (problem) {
      error.textContent = errorText(problem.message);
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  if (modalForm) modal(title,form);
  return form;
}

function field(label, name, opts = {}, value = '') {
  const input = el(opts.rows ? 'textarea' : 'input', {name, required:true, ...opts});
  input.value = value;
  return el('label',{}, label,input);
}

function password(label = tr('Passphrase'), creation = false) {
  return field(label, 'code', {type:'password', maxlength:128, minlength:creation ? 12 : undefined,
    autocomplete:creation ? 'new-password' : 'current-password'});
}

async function init() {
  try {
    token = (await identity())?.card.id || '';
    passphraseSet = Boolean(token) && await signInConfigured();
    locked = !token && await signedOut();
    if (token) {
      await update(true);
      if (signupInvite) redeemInvitationDialog();
      if (invite && invite !== token) addContact(invite);
      void refresh(true);
      return;
    }
    auth();
    if (!locked) {
      invitationRequired = await localActions.invitationRequired().catch(() => null);
      if (!token) auth();
    }
  } catch (error) {
    status('Offline',true);
    screen.replaceChildren(el('div',{class:'auth'},el('h2',{},tr('Thready is unavailable')),
      el('p',{class:'hint'},errorText(error.message)),button(tr('Retry'),init,'primary')));
  }
}

function auth() {
  data = null;
  current = '';
  menuButton.hidden = false;
  showMenu(false);
  status('On this device');
  if (locked) {
    screen.className = '';
    screen.replaceChildren(el('section',{class:'auth'},el('h1',{},tr('Sign in')),
      el('p',{class:'hint'},tr('Enter your passphrase to unlock this device.')),
      signInForm(false)));
    return;
  }
  const form = openForm(tr('Create your account'),tr('Create account'),[
    field(tr('Display name'),'name',{maxlength:60,autocomplete:'nickname',dir:'auto'},screen.querySelector('[name=name]')?.value || ''),
    invitationRequired === false && !signupInvite ? null :
      field(tr('One-time invitation link'),'invitation',{
        required:invitationRequired === true,dir:'ltr',maxlength:512,autocapitalize:'none',autocomplete:'off'
      },screen.querySelector('[name=invitation]')?.value || signupInvite)
  ],async fields => {
    await localActions.create(fields.name,invitationCode(fields.invitation),invitationRequired !== false);
    signupInvite = '';
    await init();
  },false);
  screen.className = '';
  screen.replaceChildren(el('section',{class:'auth'},el('h1',{},tr('Create your account')),
    el('p',{class:'hint'},tr('Your identity and chat history live on this device.')),
    form,el('div',{class:'row'},button(tr('Sign in'),() => signInForm(),'quiet'),
      button(tr('Load backup'),restoreDialog,'quiet'))));
}

function signInForm(modalForm = true) {
  return openForm(tr('Sign in'),tr('Sign in'),[
    locked ? null : field(tr('Thready ID'),'id',{dir:'ltr',maxlength:43,autocomplete:'username',autocapitalize:'none'}),
    password(tr('Sign-in passphrase'))
  ],async fields => {
    await localActions.signIn((fields.id || '').trim(),fields.code);
    sessionChannel?.postMessage('sign-in');
    if (dialog.open) dialog.close();
    await init();
  },modalForm);
}

function signInSettings() {
  openForm(tr('Set sign-in passphrase'),tr('Enable sign-in'),[
    el('p',{class:'hint'},tr('Use this passphrase and your Thready ID to sign in on another device. Keep an encrypted backup to move your chats.')),
    password(tr('Sign-in passphrase'),true),
    field(tr('Confirm passphrase'),'confirm',{type:'password',maxlength:128,minlength:12,autocomplete:'new-password'})
  ],async fields => {
    if (fields.code !== fields.confirm) throw new Error('The passphrases do not match.');
    await localActions.configureSignIn(fields.code);
    passphraseSet = true;
    tell(tr('Sign-in is ready.'));
  });
}

function signOutDialog() {
  openForm(tr('Sign out'),tr('Sign out'),[
    el('p',{class:'hint'},tr('Your chats will be locked on this device until you sign in again.')),
    password(tr('Sign-in passphrase'))
  ],async fields => {
    await localActions.signOut(fields.code);
    sessionChannel?.postMessage('sign-out');
    location.reload();
  });
}

function index() {
  byId.clear();
  people.clear();
  children.clear();
  messages.clear();
  messagesById.clear();
  branchesBySource.clear();
  latestMessage.clear();
  groupActivity.clear();
  groupsById.clear();
  favorites.clear();
  for (const group of data.groups) groupsById.set(group.id,group);
  for (const id of data.favorites || []) favorites.add(id);
  for (const person of data.people) people.set(person.id,person);
  for (const thread of data.threads) {
    byId.set(thread.id,thread);
    if (thread.source) {
      const branches = branchesBySource.get(thread.source) || [];
      branches.push(thread);
      branchesBySource.set(thread.source,branches);
    }
    const bucket = children.get(thread.parent) || [];
    bucket.push(thread);
    children.set(thread.parent,bucket);
  }
  for (const message of data.messages) {
    messagesById.set(message.id,message);
    const timestamp = Math.max(message.at,message.edited || 0,message.moved || 0,message.deletedAt || 0);
    latestMessage.set(message.thread,Math.max(timestamp,latestMessage.get(message.thread) || 0));
    const group = byId.get(message.thread).group;
    groupActivity.set(group,Math.max(timestamp,groupActivity.get(group) || 0));
    const bucket = messages.get(message.thread) || [];
    bucket.push(message);
    messages.set(message.thread,bucket);
  }
  for (const bucket of messages.values()) bucket.sort((a,b) => a.at - b.at || a.id.localeCompare(b.id));
}

function asleep(thread) {
  return thread.sleep || data.now - thread.activity >= thread.days * DAY;
}

function accountName(uid) {
  const person = people.get(uid);
  return person && !person.deleted ? person.name || tr('Unnamed contact') : tr('Deleted user');
}
function groupFor(thread) { return groupsById.get(thread.group); }
function byMessageUpdate(a,b) {
  return (latestMessage.get(b.id) || 0) - (latestMessage.get(a.id) || 0) || a.title.localeCompare(b.title,language);
}
function byConversationUpdate(a,b) {
  const activity = thread => thread.parent ? latestMessage.get(thread.id) : groupActivity.get(thread.group);
  return (activity(b) || 0) - (activity(a) || 0) || byMessageUpdate(a,b);
}
function ancestors(thread) {
  const path = [];
  for (let cursor = thread; cursor; cursor = byId.get(cursor.parent)) path.push(cursor);
  return path.reverse();
}
function walk(parent, visibleOnly) {
  const result = [];
  const stack = [...(children.get(parent) || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    const sleeping = asleep(node);
    if (visibleOnly && !sleeping) {
      result.push(node);
      continue;
    }
    if (!visibleOnly && sleeping) result.push(node);
    const nested = children.get(node.id) || [];
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]);
  }
  return result.sort(byMessageUpdate);
}

async function update(force = false) {
  const activeToken = token;
  const sequence = ++requestNumber;
  const fresh = await api('snapshot', {since:force ? -1 : data?.revision ?? -1});
  if (activeToken !== token || sequence < appliedRequest) return;
  appliedRequest = sequence;
  const previousCount = current ? messages.get(current)?.length || 0 : 0;
  const shouldFollow = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 170;
  let redraw = !!fresh.groups;
  let incoming = [];
  if (fresh.groups) {
    if (data?.me === fresh.me) {
      incoming = fresh.messages.filter(message => !message.deleted && message.author !== fresh.me &&
        !messagesById.has(message.id));
    }
    data = fresh;
    index();
  } else if (data) {
    data.now = fresh.now;
  }
  if (!data) return;
  for (const thread of data.threads) {
    const sleeping = asleep(thread);
    if (sleepStates.get(thread.id) !== sleeping) redraw = true;
    sleepStates.set(thread.id,sleeping);
  }
  status(isConnected() ? 'Connected' : 'Offline',!isConnected());
  menuButton.hidden = false;
  if (redraw) {
    render();
    if (current && shouldFollow && (messages.get(current)?.length || 0) > previousCount) {
      requestAnimationFrame(() => window.scrollTo(0,document.documentElement.scrollHeight));
    }
  }
  if (incoming.length && !document.hidden) alertGuests(incoming);
  if (messageToOpen) {
    const target = messagesById.get(messageToOpen);
    if (target) {
      messageToOpen = '';
      history.replaceState(null,'',location.pathname + location.hash);
      navigate(target.thread,target.id);
    }
  }
}

let refreshing = false;
async function refresh(force = false) {
  if (!token || (document.hidden && !force) || refreshing) return;
  refreshing = true;
  try {
    await requestSync(force);
    admin = isConnected() && await localActions.canInvite().catch(() => false);
    if (token) await update();
  } catch (error) {
    tell(errorText(error.message));
  } finally {
    refreshing = false;
  }
}
setInterval(refresh,20000);
addEventListener('online',() => refresh(true));
addEventListener('offline',() => { if (token) status('Offline',true); });
document.addEventListener('visibilitychange',() => { if (!document.hidden) refresh(true); });
navigator.serviceWorker?.addEventListener('message',event => {
  if (event.data?.type !== 'thready:update') return;
  if (event.data.open) messageToOpen = event.data.open;
  refresh(true);
});

function navigate(id, messageId) {
  current = id || '';
  showMenu(false);
  if (dialog.open) dialog.close();
  render();
  if (!current) {
    window.scrollTo(0,0);
    return;
  }
  const threadId = current;
  requestAnimationFrame(() => {
    if (current !== threadId) return;
    if (!messageId) window.scrollTo(0,document.documentElement.scrollHeight);
    const target = messageId ? document.getElementById('m-' + messageId) : screen.querySelector('.message:last-child');
    if (target) {
      if (messageId) target.scrollIntoView({block:'center'});
      target.focus({preventScroll:true});
    }
  });
}

function preserveComposer() {
  const composer = document.querySelector('#messageText');
  if (!composer || document.activeElement !== composer) return null;
  return [composer.selectionStart,composer.selectionEnd];
}

function render() {
  if (!data) return;
  const selection = preserveComposer();
  const focusedThread = document.activeElement?.dataset.thread;
  const focusedMessage = screen.contains(document.activeElement) && document.activeElement?.classList.contains("message")
    ? document.activeElement.id : null;
  if (!byId.has(current)) current = '';
  const node = current ? chat(byId.get(current)) : home();
  screen.className = current ? 'chat-screen' : '';
  screen.replaceChildren(node);
  const composer = document.querySelector('#messageText');
  if (selection && composer && focusedThread === current) {
    composer.focus({preventScroll:true});
    composer.setSelectionRange(...selection);
  } else if (focusedMessage) {
    document.getElementById(focusedMessage)?.focus({preventScroll:true});
  }
  const crumbs = document.querySelector('.crumbs');
  if (crumbs) crumbs.scrollLeft = document.dir === 'rtl' ? -crumbs.scrollWidth : crumbs.scrollWidth;
}

function populateMenu() {
  const items = [[tr('Language'),languageDialog]];
  if (data) items.unshift(
    [tr('Home'),() => navigate('')],
    [tr('Search threads'),() => searchDialog('threads')],
    [tr('Search contacts'),() => searchDialog('contacts')],
    [tr('Search text'),() => searchDialog('text')]);
  if (data) items.push([tr('Add contact'),addContact],[tr('Share my Thready ID'),showInvite],
    [tr('Backup'),backupDialog],[tr('Load backup'),restoreDialog],
    [tr('Notifications'),notificationSettings],
    passphraseSet ? [tr('Sign out'),signOutDialog] : [tr('Set sign-in passphrase'),signInSettings],
    [tr('Delete account'),deleteAccountDialog]);
  if (data && admin) items.splice(1,0,[tr('Invite someone'),createInvitationDialog]);

  menu.replaceChildren(...items.map(([label,run]) => button(label,() => {
    showMenu(false);
    run();
  })));
}

menuButton.addEventListener('click',() => { populateMenu(); showMenu(menu.hidden); });
document.querySelector('#brand').addEventListener('click',() => { if (data) navigate(''); });
document.addEventListener('click',event => {
  if (!menu.hidden && !menu.contains(event.target) && !menuButton.contains(event.target)) showMenu(false);
});
window.threadyBack = () => {
  if (dialog.open) { dialog.close(); return; }
  if (!menu.hidden) { showMenu(false); return; }
  if (current && data) navigate(byId.get(current)?.parent || '');
};

function item(title, subtitle, run, icon = '↳') {
  return el('button',{type:'button',class:'list-item',onclick:run},
    el('span',{class:'avatar','aria-hidden':'true'},icon),
    el('span',{class:'item-text'},el('strong',{dir:'auto'},title),subtitle ? el('small',{dir:'auto'},subtitle) : null),
    el('span',{class:'chev','aria-hidden':'true'},'›'));
}

function home() {
  const container = el('section',{},
    el('div',{class:'row spread'},el('div',{class:'heading'},el('h1',{},tr('Conversations')),
      el('p',{class:'hint'},tr('Signed in as {name}',{name:accountName(data.me)}))),
      button(tr('New conversation'),newGroup,'primary')));
  container.append(el('div',{class:'row'},button(tr('Add contact'),addContact,'quiet'),
    button(tr('Share my Thready ID'),showInvite,'quiet')));
  const live = [], dormant = [];
  for (const group of data.groups) {
    const root = byId.get(group.root);
    if (asleep(root)) {
      live.push(...walk(root.id,true));
      dormant.push(root);
    } else {
      live.push(root);
    }
  }
  const browse = thread => {
    const names = groupFor(thread).members.filter(uid => uid !== data.me).map(accountName).join(', ');
    const path = thread.parent ? ancestors(thread).slice(0,-1).map(node => node.title).join(' › ') : '';
    const subtitle = [path,names,asleep(thread) ? tr('Dormant') : ''].filter(Boolean).join(' · ');
    return browseThread(thread,subtitle,thread.parent ? '↳' : thread.title.slice(0,1).toUpperCase());
  };
  const saved = data.threads.filter(thread => favorites.has(thread.id)).sort(byMessageUpdate);
  if (saved.length) {
    container.append(el('section',{class:'favorites'},el('h2',{},tr('Favorite threads')),el('div',{class:'list'},saved.map(browse))));
  }
  const otherThreads = live.filter(thread => !favorites.has(thread.id)).sort(byConversationUpdate);
  const otherDormant = dormant.filter(thread => !favorites.has(thread.id)).sort(byConversationUpdate);
  const section = el('section',{},el('h2',{},tr('Other threads')),
    el('div',{class:'list'},otherThreads.length ? otherThreads.map(browse)
      : !otherDormant.length ? el('div',{class:'empty panel'},tr(data.groups.length ? 'No other threads.' : 'Add a contact to start a conversation.')) : null));
  if (otherDormant.length) section.append(el('details',{class:'disclosure'},
    el('summary',{},tr('Wake up ({count})',{count:otherDormant.length})),
    el('div',{class:'list'},otherDormant.map(browse))));
  container.append(section);
  return container;
}

function newGroup(preselected = '') {
  const contacts = data.people.filter(person => person.id !== data.me && !person.deleted);
  if (!contacts.length) {
    addContact();
    return;
  }
  const checkboxes = el('div',{class:'dialog-list'},contacts.map(person =>
    el('label',{class:'check'},el('input',{type:'checkbox',value:person.id,checked:person.id === preselected}),
      el('span',{dir:'auto'},[accountName(person.id),originalContactName(person)].filter(Boolean).join(' · ')))));
  openForm(tr('New conversation'),tr('Open conversation'),[field(tr('Title'),'title',{maxlength:100,dir:'auto'}),checkboxes],
    async fields => {
      const members = [...checkboxes.querySelectorAll(':checked')].map(input => input.value);
      const result = await api('group',{title:fields.title,members});
      await update(true);
      navigate(result.thread);
    });
}

function messageCount(count) {
  return tr(count === 1 ? '{count} message' : '{count} messages',{count});
}

function threadItem(thread, anchor, dormant = false) {
  const path = ancestors(thread);
  const at = path.findIndex(node => node.id === anchor.id);
  const between = path.slice(at + 1,-1).map(node => node.title).join(' › ');
  const subtitle = [between ? tr('In {path}',{path:between}) : '',dormant ? tr('Dormant') : '',messageCount(messages.get(thread.id)?.length || 0)]
    .filter(Boolean).join(' · ');
  return browseThread(thread,subtitle,dormant ? '◷' : '↳');
}

function browseThread(thread,subtitle,icon = '↳') {
  const node = item(thread.title,subtitle,() => navigate(thread.id),favorites.has(thread.id) ? '★' : icon);
  if (thread.parent) longPress(node,() => moveDialog(thread));
  return node;
}

function favoriteButton(thread) {
  const saved = favorites.has(thread.id);
  const label = tr(saved ? 'Remove from favorites' : 'Add to favorites');
  return button(saved ? '★' : '☆',() => act('favorite',{thread:thread.id,favorite:!saved}), 'icon star',
    {'aria-label':label,'title':label,'aria-pressed':String(saved)});
}

function browseBranches(thread, sleeping) {
  const branches = walk(thread.id,!sleeping);
  const title = tr(sleeping ? 'Wake up ({count})' : 'Threads ({count})',{count:branches.length});
  modal(title,el('div',{class:'list dialog-list'},branches.length ? branches.map(branch => threadItem(branch,thread,sleeping))
    : el('p',{class:'hint'},tr(sleeping ? 'No dormant branches.' : 'No active branches.'))));
}

function longPress(node, run) {
  let timer, startX, startY, fired = false;
  node.addEventListener('pointerdown',event => {
    if (event.button !== 0) return;
    fired = false;
    startX = event.clientX;
    startY = event.clientY;
    timer = setTimeout(() => { fired = true; run(); },540);
  });
  node.addEventListener('pointermove',event => {
    if (Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY) > 12) clearTimeout(timer);
  });
  for (const type of ['pointercancel','pointerup','pointerleave']) node.addEventListener(type,() => clearTimeout(timer));
  node.addEventListener('click',event => { if (fired) { event.preventDefault(); event.stopImmediatePropagation(); fired = false; } },true);
  node.addEventListener('contextmenu',event => { event.preventDefault(); clearTimeout(timer); if (!fired) run(); });
}

function chat(thread) {
  const path = ancestors(thread);
  const group = groupFor(thread);
  const dormant = asleep(thread);
  const activeCount = walk(thread.id,true).length;
  const sleepingCount = walk(thread.id,false).length;
  const container = el('section',{},
    el('div',{class:'thread-top'},
      el('nav',{class:'crumbs','aria-label':tr('Parent threads')},
        button(tr('Home'),() => navigate('')),path.slice(0,-1).filter(parent => dormant || !asleep(parent)).flatMap(parent =>
          [el('span',{},'›'),button(parent.title,() => navigate(parent.id))])),
      el('div',{class:'thread-heading'},el('h1',{dir:'auto'},thread.title),
        favoriteButton(thread),button('⋯',() => threadOptions(thread),'icon',{'aria-label':tr('Thread options')})),
      el('div',{class:'row memberline'},dormant ? el('span',{class:'pill'},tr('Dormant')) : null,
        el('span',{class:'meta member-names',dir:'auto'},group.members.map(accountName).join(', '))),
      el('div',{class:'row thread-tools'},
        button(tr('New branch'),() => branchDialog(thread),'quiet'),
        button(tr('Threads ({count})',{count:activeCount}),() => browseBranches(thread,false),'quiet'),
        button(tr('Wake up ({count})',{count:sleepingCount}),() => browseBranches(thread,true),'quiet'),
        dormant ? button(tr('Revive thread'),() => act('revive',{thread:thread.id}),'quiet') : null)));
  const source = messagesById.get(thread.source);
  if (source && !source.deleted) container.append(el('div',{class:'anchor',dir:'auto'},tr('Branched from {name}',{name:accountName(source.author)}) + ' · ' + source.text.slice(0,240)));
  const shown = messages.get(thread.id) || [];
  container.append(el('div',{class:'messages','aria-label':tr('Messages')},
    shown.length ? shown.map(message => bubble(thread,message)) : el('div',{class:'empty'},tr('No messages yet.'))));
  const input = el('textarea',{id:'messageText',placeholder:dormant ? tr('Write a message to revive this thread') : tr('Write a message'),
    'aria-label':tr('Message'),maxlength:12000,dir:'auto',rows:1,'data-thread':thread.id});
  input.value = drafts.get(thread.id) || '';
  input.addEventListener('input',() => { drafts.set(thread.id,input.value); });
  const submit = el('button',{type:'submit',class:'primary',disabled:sends.get(thread.id)?.pending},tr('Send'));
  const form = el('form',{class:'compose'},input,submit);
  form.addEventListener('submit',async event => {
    event.preventDefault();
    const value = input.value.trim();
    const previous = sends.get(thread.id);
    if (!value || previous?.pending) return;
    submit.disabled = true;
    const nonce = previous?.value === value ? previous.nonce
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');
    const send = {value,nonce,pending:true};
    sends.set(thread.id,send);
    const activeToken = token;
    try {
      await api('send',{thread:thread.id,nonce,text:value});
      if (activeToken !== token) return;
      sends.delete(thread.id);
      if ((drafts.get(thread.id) || '').trim() === value) {
        drafts.delete(thread.id);
        input.value = '';
      }
      await update(true);
      if (current === thread.id) requestAnimationFrame(() => window.scrollTo(0,document.documentElement.scrollHeight));
    } catch (error) {
      tell(errorText(error.message));
    } finally {
      send.pending = false;
      submit.disabled = false;
      if (current === thread.id) {
        const visible = document.querySelector('.compose button');
        if (visible) visible.disabled = false;
      }
    }
  });
  container.append(form);
  return container;
}

function formatMessage(text) {
  return text.split(/(https?:\/\/[^\s<>"']+)/giu).map((part,index) => index % 2
    ? el('a',{href:part,target:'_blank',rel:'noopener noreferrer'},part) : part);
}

function bubble(thread,message) {
  const self = message.author === data.me;
  const branches = (branchesBySource.get(message.id) || []).filter(child => child.id !== thread.id && !asleep(child)).sort(byMessageUpdate);
  return el('article',{class:'message' + (self ? ' mine' : ''),id:'m-' + message.id,tabindex:-1},
    el('div',{class:'meta'},el('strong',{dir:'auto'},accountName(message.author)),
      message.deleted ? null : button('⋯',() => messageOptions(thread,message), '', {'aria-label':tr('Message options')})),
    el('p',{dir:'auto'},message.deleted ? tr('Message deleted') : formatMessage(message.text)),
    branches.map(branch => button('↳ ' + branch.title,() => navigate(branch.id),'branch-link')),
    el('small',{},[
      message.pending && !message.deleted ? tr('Pending upload') : null,
      message.failed && !message.deleted ? tr('Delivery failed for a participant') : null,
      message.edited && !message.deleted ? tr('Edited') : null,
      message.moved && !message.deleted ? tr('Moved') : null,
      new Date(message.at).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit'})
    ].filter(Boolean).join(' · ')));
}

function messageOptions(thread,message) {
  const options = [button(tr('Branch from message'),() => branchDialog(thread,message.id),'primary')];
  if (message.author === data.me) {
    options.push(button(tr('Edit message'),() => openForm(tr('Edit message'),tr('Save changes'),
      [field(tr('Message'),'text',{maxlength:12000,rows:5,dir:'auto'},message.text)],
      fields => change('edit',{message:message.id,...fields}))));
    options.push(button(tr('Move message'),() => moveMessageDialog(thread,message)));
    options.push(button(tr('Delete message'),() => confirmDialog(tr('Delete message'),tr('Other participants will see that this message was deleted.'),
      tr('Delete'),() => change('deleteMessage',{message:message.id})),'danger'));
  }
  modal(tr('Message'),el('div',{class:'row'},options));
}

function threadOptions(thread) {
  const controls = [
    button(tr('Title and decay'),() => openForm(tr('Thread settings'),tr('Save'),
      [field(tr('Title'),'title',{maxlength:100,dir:'auto'},thread.title),field(tr('Decay period in days'),'days',{type:'number',min:1,max:3650},thread.days)],
      values => change('threadSettings',{thread:thread.id,...values}))),
    button(asleep(thread) ? tr('Revive thread') : tr('Dormant thread'),() => {
      dialog.close();
      act(asleep(thread) ? 'revive' : 'dormant',{thread:thread.id});
    }),
    thread.parent ? button(tr('Move thread'),() => moveDialog(thread)) : null
  ];
  modal(tr('Thread options'),el('div',{class:'row'},controls));
}

function branchDialog(thread,source = '') {
  openForm(tr('New branch'),tr('Create branch'),[field(tr('Title'),'title',{maxlength:100,dir:'auto'})],async fields => {
    const result = await api('branch',{thread:thread.id,source,...fields});
    await update(true);
    navigate(result.thread);
  });
}

function moveDialog(thread) {
  const candidates = data.threads.filter(target => target.group === thread.group && target.id !== thread.parent &&
      !ancestors(target).some(node => node.id === thread.id));
  const selector = el('select',{name:'destination',required:true},
    el('option',{value:''},tr('Choose a parent thread')),
    candidates.map(target => el('option',{value:target.id},ancestors(target).map(n => n.title).join(' › '))));
  openForm(tr('Move {title}',{title:thread.title}),tr('Move branch'),[
    el('p',{class:'hint'},tr('The branch moves with its messages and sub-threads.')),
    el('label',{},tr('New parent'),selector)
  ],fields => change('move',{thread:thread.id,...fields}));
}

function moveMessageDialog(thread,message) {
  const members = JSON.stringify(groupFor(thread).members);
  const candidates = data.threads.filter(candidate => candidate.id !== thread.id &&
    JSON.stringify(groupFor(candidate).members) === members).sort(byMessageUpdate);
  if (!candidates.length) {
    modal(tr('Move message'),el('p',{class:'hint'},tr('There are no other threads with these participants.')));
    return;
  }
  const selector = el('select',{name:'destination',required:true},
    el('option',{value:''},tr('Choose a destination thread')),
    candidates.map(target => el('option',{value:target.id},ancestors(target).map(node => node.title).join(' › '))));
  openForm(tr('Move message'),tr('Move message'),[el('label',{},tr('Destination thread'),selector)],async fields => {
    await change('moveMessage',{message:message.id,thread:thread.id,destination:fields.destination});
    navigate(fields.destination,message.id);
  });
}

async function change(action,fields) {
  await api(action,fields);
  await update(true);
}

async function act(action,fields) {
  try { await change(action,fields); } catch (error) { tell(errorText(error.message)); }
}

function confirmDialog(title, note, label, work) {
  openForm(title,label,[el('p',{class:'hint'},note)],work);
}

function searchDialog(type) {
  const label = {threads:tr('Search threads'), contacts:tr('Search contacts'), text:tr('Search text')}[type];
  const input = el('input',{type:'search',placeholder:label,'aria-label':label,dir:'auto'});
  const list = el('div',{class:'list dialog-list'});
  const refresh = () => {
    const query = input.value.trim().toLocaleLowerCase();
    const matches = value => value.toLocaleLowerCase().includes(query);
    let results = [];
    if (type === 'contacts') results = data.people
      .filter(person => !person.deleted && person.id !== data.me &&
        (matches(accountName(person.id)) || matches(person.originalName)))
      .slice(0,80).map(person => item(accountName(person.id),originalContactName(person),
        () => contactDetails(person),accountName(person.id).slice(0,1).toUpperCase()));
    if (type === 'threads') results = data.threads.filter(t => matches(t.title)).sort(byMessageUpdate).slice(0,80)
      .map(t => browseThread(t,ancestors(t).map(n => n.title).join(' › ') + (asleep(t) ? ' · ' + tr('Dormant') : '')));
    if (type === 'text' && query) results = data.messages.filter(m => !m.deleted && matches(m.text)).slice(-80).reverse()
      .map(m => item(m.text.slice(0,180),byId.get(m.thread)?.title,() => navigate(m.thread,m.id),'“'));
    list.replaceChildren(...(results.length ? results : [el('p',{class:'empty'},type === 'text' && !query ? tr('Enter text to search your conversations.') : tr('No matches.'))]));
  };
  modal(label,el('div',{},input,list));
  input.addEventListener('input',refresh);
  refresh();
  input.focus();
}

function originalContactName(person) {
  return person.nickname && person.originalName !== person.nickname ? person.originalName : '';
}

function contactDetails(person) {
  openForm(accountName(person.id),tr('Save nickname'),[
    person.originalName ? el('p',{class:'hint',dir:'auto'},tr('Original name: {name}',{name:person.originalName})) : null,
    field(tr('Nickname on this device'),'nickname',{required:false,maxlength:60,dir:'auto'},person.nickname),
    button(tr('New conversation'),() => newGroup(person.id),'quiet')
  ],async fields => {
    await localActions.renameContact(person.id,fields.nickname);
    await update(true);
    searchDialog('contacts');
  });
}

async function showInvite() {
  const id = await localActions.getId();
  const link = new URL(location.pathname,location.origin);
  link.hash = new URLSearchParams({contact:id}).toString();
  const text = el('input',{type:'text',value:link.href,readonly:true,dir:'ltr','aria-label':tr('Invite link')});
  modal(tr('Share my Thready ID'),el('div',{},
    el('p',{class:'hint'},tr('Share this ID or invite link with a contact. First-time registration needs internet.')),
    el('code',{class:'recovery',dir:'ltr'},id),text,
    el('div',{class:'row'},button(tr('Copy link'),async () => {
      try { await navigator.clipboard.writeText(link.href); tell(tr('Link copied.')); }
      catch { text.select(); }
    },'primary'),button(tr('Copy ID'),async () => {
      try { await navigator.clipboard.writeText(id); tell(tr('Thready ID copied.')); }
      catch { text.value = id; text.select(); }
    },'quiet'),navigator.share ? button(tr('Share'),() => navigator.share({title:'Thready PWA',url:link.href}).catch(() => {}),'quiet') : null)));
}

function invitationCode(value = '') {
  const text = value.trim();
  try {
    return new URLSearchParams(new URL(text).hash.slice(1)).get('invite') || text;
  } catch {
    return text;
  }
}

function redeemInvitationDialog() {
  openForm(tr('Use invitation'),tr('Use invitation'),[
    field(tr('One-time invitation link'),'invitation',{dir:'ltr',autocomplete:'off'},signupInvite)
  ],async fields => {
    await localActions.redeemInvitation(invitationCode(fields.invitation));
    signupInvite = '';
    await refresh(true);
    tell(tr('Invitation accepted.'));
  });
}

function createInvitationDialog() {
  openForm(tr('Invite someone'),tr('Create invite link'),[
    el('p',{class:'hint'},tr('This link can create one account and expires in seven days. Share it privately.'))
  ],async () => {
    const code = await localActions.createInvitation();
    const link = new URL(location.pathname,location.origin);
    link.hash = new URLSearchParams({invite:code}).toString();
    const input = el('input',{type:'text',value:link.href,readonly:true,dir:'ltr','aria-label':tr('One-time invitation link')});
    modal(tr('One-time invitation link'),el('div',{class:'form'},input,
      el('div',{class:'row'},button(tr('Copy link'),async () => {
        try { await navigator.clipboard.writeText(link.href); tell(tr('Link copied.')); }
        catch { input.select(); }
      },'primary'),navigator.share ? button(tr('Share'),() => navigator.share({title:'Thready PWA',url:link.href}).catch(() => {}),'quiet') : null)));
  });
}

function addContact(prefill = '') {
  if (typeof prefill !== 'string') prefill = '';
  openForm(tr('Add contact'),tr('Add contact'),[
    field(tr('Thready ID or invite link'),'id',{dir:'ltr',autocapitalize:'none',autocomplete:'off'},prefill),
    field(tr('Nickname on this device'),'name',{required:false,maxlength:60,dir:'auto'})
  ],async fields => {
    let id = fields.id.trim();
    try { id = new URLSearchParams(new URL(id).hash.slice(1)).get('contact') || id; }
    catch { /* A plain ID is also valid. */ }
    await localActions.contact(id,fields.name);
    if (invite) {
      invite = '';
      history.replaceState(null,'',location.pathname + location.search);
    }
    await update(true);
    tell(tr('Contact added.'));
  });
}

function backupDialog() {
  openForm(tr('Encrypted backup'),tr('Save backup'),[
    el('p',{class:'hint'},tr('The backup includes your identity, contacts, and local conversations. Keep its passphrase safe.')),
    password(tr('Backup passphrase'),true)
  ],async fields => {
    const content = await localActions.backup(fields.code);
    const url = URL.createObjectURL(new Blob([content],{type:'application/octet-stream'}));
    const link = el('a',{class:'backup-download',href:url,download:'Thready-' + new Date().toISOString().slice(0,10) + '.thready-pwa'},
      tr('Download encrypted backup'));
    modal(tr('Encrypted backup'),el('div',{},link));
    dialog.addEventListener('close',() => setTimeout(() => URL.revokeObjectURL(url),1000),{once:true});
  });
}

function restoreDialog() {
  const file = el('input',{type:'file',accept:'.thready-pwa',required:true});
  openForm(tr('Load backup'),tr('Restore conversations'),[
    el('p',{class:'hint'},tr('Restore a Thready PWA backup on your replacement device.')),
    el('label',{},tr('Choose backup file'),file),
    password(tr('Backup passphrase'))
  ],async fields => {
    const selected = file.files[0];
    if (!selected || selected.size > 100 * 1024 * 1024) throw new Error('Choose a backup file under 100 MB.');
    await localActions.restore(await selected.text(),fields.code);
    await init();
    tell(tr('Backup restored.'));
  });
}

function setLanguage(value) {
  language = value;
  localStorage.setItem('thready-language',value);
  document.documentElement.lang = value;
  document.documentElement.dir = value === 'he' ? 'rtl' : 'ltr';
  menuButton.setAttribute('aria-label',tr('Menu'));
  document.querySelector('#brand').setAttribute('aria-label',tr('Thready home'));
  menu.setAttribute('aria-label',tr('Main menu'));
}

function languageDialog() {
  modal(tr('Language'),el('div',{class:'row'},[['he','עברית'],['en','English']].map(([value,name]) =>
    button(name,() => {
      setLanguage(value);
      dialog.close();
      if (data) {
        status(lastConnection.key,lastConnection.offline);
        render();
      } else auth();
    },value === language ? 'primary' : 'quiet',{lang:value,'aria-pressed':String(value === language)}))));
}

function deleteAccountDialog() {
  openForm(tr('Delete account'),tr('Delete my account'),[
    el('p',{class:'hint'},tr('This deletes the identity and device data. Other participants keep their local copies.')),
    el('label',{class:'check'},el('input',{name:'confirm',type:'checkbox',required:true}),
      tr('Confirm that you want to delete your account.'))
  ],async () => {
    await localActions.deleteEverywhere();
    token = '';
    drafts.clear();
    sends.clear();
    dialog.close();
    await init();
    tell(tr('Account deleted.'));
  });
}

function alertGuests(incoming) {
  if (!incoming.length) return;
  const message = incoming.reduce((latest,next) => next.at >= latest.at ? next : latest);
  const thread = byId.get(message.thread);
  if (!thread) return;
  const label = incoming.length === 1 ? tr('New message in {thread}',{thread:thread.title})
    : tr('{count} new messages',{count:incoming.length});
  tell(label,() => navigate(message.thread,message.id));
}

async function notificationSettings() {
  const notice = el('p',{class:'hint',role:'status'},tr('Allow alerts for new messages while Thready is closed. On iPhone, open Thready from the Home Screen.'));
  const actions = el('div',{class:'row'});
  modal(tr('Notifications'),el('div',{},notice,actions));
  try {
    const controls = await localActions.notificationControls();
    const change = async (action,message) => {
      for (const item of actions.children) item.disabled = true;
      try {
        await controls[action]();
        notice.textContent = tr(message);
      } catch (error) {
        notice.textContent = errorText(error.message);
      } finally {
        for (const item of actions.children) item.disabled = false;
      }
    };
    actions.append(
      button(tr('Enable notifications'),() => change('enable','Notifications enabled.'),'primary'),
      button(tr('Test notification'),() => change('test','Test sent. Check this browser’s system notifications.'),'quiet'),
      button(tr('Disable notifications'),() => change('disable','Notifications disabled.'),'quiet'));
  } catch (error) { notice.textContent = errorText(error.message); }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(error => {
    console.warn('Thready offline setup failed',error.name);
  });
}

setLanguage(language);
init();
