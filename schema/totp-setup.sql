-- TOTP/MFA Configuration and Rate Limiting

-- Add TOTP secret to auth_config
INSERT OR REPLACE INTO auth_config (config_key, config_value)
VALUES ('totp_secret', 'JBSWY3DPEHPK3PXP');

-- Create rate limiting table for TOTP verification
CREATE TABLE IF NOT EXISTS totp_rate_limit (
  device_fingerprint TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt TIMESTAMP NOT NULL,
  locked_until TIMESTAMP
);

-- Create index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_totp_locked_until ON totp_rate_limit(locked_until);
