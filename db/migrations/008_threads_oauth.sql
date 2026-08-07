ALTER TABLE user_private_settings
  ADD COLUMN IF NOT EXISTS threads_app_id TEXT NULL AFTER threads_access_token,
  ADD COLUMN IF NOT EXISTS threads_app_secret TEXT NULL AFTER threads_app_id;
