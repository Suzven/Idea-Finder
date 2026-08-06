CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY users_username_unique (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY user_sessions_user_idx (user_id, expires_at),
    KEY user_sessions_expiry_idx (expires_at),
    CONSTRAINT user_sessions_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_private_settings (
    user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    openai_api_key TEXT NULL,
    google_ads_developer_token TEXT NULL,
    google_ads_customer_id VARCHAR(10) NULL,
    google_ads_login_customer_id VARCHAR(10) NULL,
    google_ads_service_account_json LONGTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT user_private_settings_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Базовый пользователь. Пароль: логин12344321!
-- После первого входа пароль желательно сменить на свой уникальный.
INSERT INTO users (username, password_hash, display_name, role)
VALUES (
    'admin',
    'scrypt$v1$QNLgMCZLIsp-g2PNDfFYMA$auUhqrWBmC6psATKu6J4nsK74duA3FLMx8ClPtO_q4oSMTFgfuAI5_1jlCgbtsSNmxsYE65MmXIh54bP4jn3xQ',
    'Administrator',
    'admin'
)
ON DUPLICATE KEY UPDATE username = VALUES(username);

