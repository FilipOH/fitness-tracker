-- Add config/goals table
CREATE TABLE IF NOT EXISTS user_config (
  user_id INTEGER NOT NULL,
  config_key TEXT NOT NULL,
  config_value TEXT NOT NULL,
  effective_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, config_key, effective_date),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Add device tokens table (already in main schema but adding here for completeness)
CREATE TABLE IF NOT EXISTS device_tokens_v2 (
  device_fingerprint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_token TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
