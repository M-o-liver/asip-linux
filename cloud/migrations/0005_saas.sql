CREATE TABLE billing_accounts(account_id TEXT PRIMARY KEY REFERENCES accounts(id),status TEXT NOT NULL DEFAULT 'trialing',trial_started_at TEXT NOT NULL,trial_ends_at TEXT NOT NULL,stripe_customer_id TEXT UNIQUE,stripe_subscription_id TEXT,period_ends_at TEXT,cancel_at_period_end INTEGER NOT NULL DEFAULT 0,checkout_id TEXT,checkout_url TEXT,checkout_expires INTEGER,updated_at TEXT NOT NULL);
INSERT INTO billing_accounts(account_id,status,trial_started_at,trial_ends_at,updated_at) SELECT id,'founder',datetime('now'),datetime('now','+7 days'),datetime('now') FROM accounts;
CREATE TABLE billing_events(id TEXT PRIMARY KEY,processed_at TEXT NOT NULL);
CREATE INDEX identities_account ON identities(account_id);
ALTER TABLE oauth_states ADD COLUMN return_path TEXT;
