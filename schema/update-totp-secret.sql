-- Update TOTP secret to RFC-compliant length (128+ bits)
-- New secret: QXQGQAAL4EHLMAADJWG6XOA7L65GSLFV
-- 
-- NOTE: User will need to reconfigure their authenticator app!
-- Generate QR code with: otpauth://totp/FitnessTracker:user?secret=QXQGQAAL4EHLMAADJWG6XOA7L65GSLFV&issuer=FitnessTracker

UPDATE auth_config 
SET config_value = 'QXQGQAAL4EHLMAADJWG6XOA7L65GSLFV'
WHERE config_key = 'totp_secret';
