CREATE TABLE IF NOT EXISTS collections (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(100) NOT NULL,
    name VARCHAR(120) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY collections_client_name_unique (client_id, name),
    UNIQUE KEY collections_client_id_unique (client_id, id),
    KEY collections_client_updated_idx (client_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS favorite_collections (
    client_id VARCHAR(100) NOT NULL,
    ad_id VARCHAR(160) NOT NULL,
    collection_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, ad_id, collection_id),
    KEY favorite_collections_collection_idx (client_id, collection_id, created_at),
    CONSTRAINT favorite_collections_favorite_fk
        FOREIGN KEY (client_id, ad_id)
        REFERENCES favorites (client_id, ad_id)
        ON DELETE CASCADE,
    CONSTRAINT favorite_collections_collection_fk
        FOREIGN KEY (client_id, collection_id)
        REFERENCES collections (client_id, id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
