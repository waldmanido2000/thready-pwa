CREATE TABLE sign_in (
  account_id TEXT PRIMARY KEY,
  lookup_hash TEXT NOT NULL,
  sealed_identity TEXT NOT NULL
);
