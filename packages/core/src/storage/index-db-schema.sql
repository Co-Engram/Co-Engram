-- packages/core/src/storage/index-db-schema.sql

-- 主表:engram 元数据
CREATE TABLE IF NOT EXISTS engrams (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  updated_at INTEGER NOT NULL,
  content_size INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public',
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_engrams_updated ON engrams(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_importance ON engrams(importance DESC, updated_at DESC);

-- 多值 tag
CREATE TABLE IF NOT EXISTS engram_domains (
  engram_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  PRIMARY KEY (engram_id, domain),
  FOREIGN KEY (engram_id) REFERENCES engrams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_domains_domain ON engram_domains(domain);

-- 突触
CREATE TABLE IF NOT EXISTS synapses (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  FOREIGN KEY (from_id) REFERENCES engrams(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES engrams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_synapses_from ON synapses(from_id);
CREATE INDEX IF NOT EXISTS idx_synapses_to ON synapses(to_id);

-- FTS5 trigram
CREATE VIRTUAL TABLE IF NOT EXISTS engram_fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  content_tokens,
  tokenize = 'trigram'
);
