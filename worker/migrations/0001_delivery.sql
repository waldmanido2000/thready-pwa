CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  card TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE delivery (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sender_card TEXT,
  iv TEXT,
  body TEXT,
  expires INTEGER NOT NULL,
  UNIQUE (sender_id,recipient_id,event_id)
);
CREATE INDEX delivery_inbox ON delivery (recipient_id,seq) WHERE body IS NOT NULL;
CREATE INDEX delivery_expiry ON delivery (expires);
CREATE TABLE subscriptions (
  account_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  subscription TEXT NOT NULL,
  language TEXT NOT NULL
);
