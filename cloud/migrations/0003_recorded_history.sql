CREATE INDEX events_recorded_history ON events(account_id,julianday(at) DESC,seq DESC);
