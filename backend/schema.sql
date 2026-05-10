-- CloudAI SaaS Phase 5: Auth + Streaming + Payments

-- 用户表（增加 password_hash, stripe_customer_id）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  plan TEXT DEFAULT 'free',
  stripe_customer_id TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- AI 对话
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT,
  model TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, created_at DESC);

-- 消息
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens_used INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

-- 用量追踪
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  request_type TEXT DEFAULT 'chat',
  latency_ms INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_logs(user_id, created_at);

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL,
  name TEXT,
  last_used_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

-- 订阅/支付记录
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  stripe_session_id TEXT,
  stripe_customer_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT DEFAULT 'active',
  current_period_start INTEGER,
  current_period_end INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

-- 插入测试用户（密码: demo123）
INSERT OR IGNORE INTO users (id, email, password_hash, name, plan) VALUES
  ('demo-user-001', 'demo@cloudai.dev', 'a]6e01a0b56c357c4e0a5e6f0b5d8e2f8c1e3b5a7d9f1e2c4b6a8d0e2f4c6b8', 'Demo User', 'pro');
