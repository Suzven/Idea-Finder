BEGIN;

CREATE TABLE IF NOT EXISTS favorites (
    client_id VARCHAR(100) NOT NULL,
    ad_id VARCHAR(160) NOT NULL,
    source VARCHAR(20) NOT NULL CHECK (source IN ('meta', 'tiktok')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (client_id, ad_id)
);

CREATE INDEX IF NOT EXISTS favorites_client_created_idx
    ON favorites (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collected_ads (
    id VARCHAR(160) PRIMARY KEY,
    source VARCHAR(20) NOT NULL CHECK (source IN ('meta', 'tiktok')),
    external_id VARCHAR(128) NOT NULL,
    advertiser_name TEXT NOT NULL,
    country_code VARCHAR(3),
    media_type VARCHAR(20),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    normalized_payload JSONB NOT NULL,
    source_payload JSONB,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS collected_ads_source_started_idx
    ON collected_ads (source, started_at DESC);
CREATE INDEX IF NOT EXISTS collected_ads_country_idx
    ON collected_ads (country_code);
CREATE INDEX IF NOT EXISTS collected_ads_payload_gin_idx
    ON collected_ads USING GIN (normalized_payload);

CREATE TABLE IF NOT EXISTS saved_searches (
    id BIGSERIAL PRIMARY KEY,
    client_id VARCHAR(100) NOT NULL,
    name VARCHAR(120) NOT NULL,
    source VARCHAR(20) NOT NULL CHECK (source IN ('meta', 'tiktok')),
    filters JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS saved_searches_client_idx
    ON saved_searches (client_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS collection_runs (
    id BIGSERIAL PRIMARY KEY,
    source VARCHAR(20) NOT NULL CHECK (source IN ('meta', 'tiktok')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    cursor TEXT,
    items_collected INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

COMMIT;
