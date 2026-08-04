CREATE TABLE IF NOT EXISTS favorites (
    client_id VARCHAR(100) NOT NULL,
    ad_id VARCHAR(160) NOT NULL,
    source ENUM('meta', 'tiktok') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, ad_id),
    KEY favorites_client_created_idx (client_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS collected_ads (
    id VARCHAR(160) PRIMARY KEY,
    source ENUM('meta', 'tiktok') NOT NULL,
    external_id VARCHAR(128) NOT NULL,
    advertiser_name TEXT NOT NULL,
    country_code VARCHAR(3),
    media_type VARCHAR(20),
    started_at DATETIME,
    ended_at DATETIME,
    normalized_payload JSON NOT NULL,
    source_payload JSON,
    collected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY collected_ads_source_external_unique (source, external_id),
    KEY collected_ads_source_started_idx (source, started_at),
    KEY collected_ads_country_idx (country_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS saved_searches (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(100) NOT NULL,
    name VARCHAR(120) NOT NULL,
    source ENUM('meta', 'tiktok') NOT NULL,
    filters JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY saved_searches_client_idx (client_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS collection_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source ENUM('meta', 'tiktok') NOT NULL,
    status ENUM('running', 'completed', 'failed') NOT NULL,
    cursor TEXT,
    items_collected INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
