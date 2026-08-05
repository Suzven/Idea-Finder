CREATE TABLE IF NOT EXISTS creative_notes (
    client_id VARCHAR(100) NOT NULL,
    ad_id VARCHAR(160) NOT NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, ad_id),
    CONSTRAINT creative_notes_favorite_fk
        FOREIGN KEY (client_id, ad_id)
        REFERENCES favorites (client_id, ad_id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_analysis_reports (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(100) NOT NULL,
    collection_id BIGINT UNSIGNED NULL,
    collection_name VARCHAR(120) NOT NULL,
    report_name VARCHAR(220) NOT NULL,
    model VARCHAR(80) NOT NULL,
    analyzed_count SMALLINT UNSIGNED NOT NULL,
    total_count INTEGER UNSIGNED NOT NULL,
    opportunity_score TINYINT UNSIGNED NOT NULL,
    niche VARCHAR(255) NOT NULL,
    result_json JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ai_analysis_reports_client_created_idx (client_id, created_at),
    KEY ai_analysis_reports_collection_idx (client_id, collection_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
