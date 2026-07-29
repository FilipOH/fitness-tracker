-- Add auth configuration table
CREATE TABLE IF NOT EXISTS auth_config (
  config_key TEXT PRIMARY KEY,
  config_value TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Store the API key (same as in Happycow314!.json)
INSERT OR REPLACE INTO auth_config (config_key, config_value)
VALUES ('api_key', 'my_secret_token_123');

-- Store password as plain text for now (in production you'd hash this)
-- Using same password as filename: Happycow314!
INSERT OR REPLACE INTO auth_config (config_key, config_value)
VALUES ('password', 'Happycow314!');
