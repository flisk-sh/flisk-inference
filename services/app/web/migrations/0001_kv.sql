-- The portal keeps its whole state (users, hashed keys, usage) as one JSON row; see src/worker.ts.
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
