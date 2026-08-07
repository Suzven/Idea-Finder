ALTER TABLE user_private_settings
    ADD COLUMN IF NOT EXISTS threads_username VARCHAR(255) NULL AFTER google_ads_service_account_json,
    ADD COLUMN IF NOT EXISTS threads_password TEXT NULL AFTER threads_username,
    ADD COLUMN IF NOT EXISTS threads_storage_state LONGTEXT NULL AFTER threads_password;
