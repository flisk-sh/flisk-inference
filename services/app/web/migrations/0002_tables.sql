-- Users, keys and usage as rows, so one change touches one row (revoke = UPDATE keys SET revoked = 1; usage = n + ?)
-- and two requests that overlap cannot write each other's state back. The old single-row `kv` table is copied once
-- and then left alone (nothing reads it), so the change can be undone.
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, last4 TEXT NOT NULL,
  created TEXT NOT NULL, last_used TEXT, requests INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS keys_user ON keys (user_id);
CREATE TABLE IF NOT EXISTS key_days (key_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key_id, day));
CREATE TABLE IF NOT EXISTS day_totals (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, neurons REAL NOT NULL DEFAULT 0);

-- Copy what the old row holds. With no row (a fresh database) json_each(NULL) yields nothing.
INSERT OR IGNORE INTO users (id, login, name, avatar, created)
  SELECT u.key, json_extract(u.value, '$.login'), COALESCE(json_extract(u.value, '$.name'), json_extract(u.value, '$.login')),
         COALESCE(json_extract(u.value, '$.avatar'), ''), COALESCE(json_extract(u.value, '$.created'), '')
  FROM json_each(json_extract((SELECT v FROM kv WHERE k = 'db'), '$.users')) AS u;
INSERT OR IGNORE INTO keys (id, user_id, name, hash, prefix, last4, created, last_used, requests, input, output, revoked)
  SELECT json_extract(k.value, '$.id'), json_extract(k.value, '$.userId'), json_extract(k.value, '$.name'), json_extract(k.value, '$.hash'),
         json_extract(k.value, '$.prefix'), json_extract(k.value, '$.last4'), json_extract(k.value, '$.created'), json_extract(k.value, '$.lastUsed'),
         COALESCE(json_extract(k.value, '$.requests'), 0), COALESCE(json_extract(k.value, '$.input'), 0), COALESCE(json_extract(k.value, '$.output'), 0),
         CASE WHEN json_extract(k.value, '$.revoked') THEN 1 ELSE 0 END
  FROM json_each(json_extract((SELECT v FROM kv WHERE k = 'db'), '$.keys')) AS k;
INSERT OR IGNORE INTO key_days (key_id, day, requests, input, output)
  SELECT json_extract(k.value, '$.id'), d.key, COALESCE(json_extract(d.value, '$.requests'), 0), COALESCE(json_extract(d.value, '$.input'), 0), COALESCE(json_extract(d.value, '$.output'), 0)
  FROM json_each(json_extract((SELECT v FROM kv WHERE k = 'db'), '$.keys')) AS k,
       json_each(json_extract(k.value, '$.daily')) AS d;
INSERT OR IGNORE INTO day_totals (day, requests, neurons)
  SELECT t.key, t.value, 0 FROM json_each(json_extract((SELECT v FROM kv WHERE k = 'db'), '$.total')) AS t;
UPDATE day_totals SET neurons = COALESCE((SELECT n.value FROM json_each(json_extract((SELECT v FROM kv WHERE k = 'db'), '$.neurons')) AS n WHERE n.key = day_totals.day), 0);
INSERT OR IGNORE INTO day_totals (day, requests, neurons)
  SELECT n.key, 0, n.value FROM json_each(json_extract((SELECT v FROM kv WHERE k = 'db'), '$.neurons')) AS n;
