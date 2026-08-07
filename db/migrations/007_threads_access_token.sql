ALTER TABLE user_private_settings
  ADD COLUMN IF NOT EXISTS threads_access_token LONGTEXT NULL AFTER openai_api_key;
