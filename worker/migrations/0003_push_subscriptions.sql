CREATE TABLE browser_subscriptions (
  endpoint TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  subscription TEXT NOT NULL,
  language TEXT NOT NULL,
  next_test INTEGER NOT NULL DEFAULT 0
);
INSERT INTO browser_subscriptions (endpoint, account_id, subscription, language)
  SELECT endpoint, account_id, subscription, language FROM subscriptions;
DROP TABLE subscriptions;
ALTER TABLE browser_subscriptions RENAME TO subscriptions;
CREATE INDEX subscriptions_account ON subscriptions (account_id);
