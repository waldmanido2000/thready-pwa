CREATE TABLE invitation_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  admin_id TEXT NOT NULL REFERENCES accounts(id)
);

CREATE TABLE invitations (
  code_hash TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  redeemed_by TEXT
);

CREATE INDEX invitations_expiry ON invitations(expires);
