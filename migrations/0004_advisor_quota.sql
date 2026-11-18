-- 0004_advisor_quota.sql — durable daily advisor quota.
--
-- Why: the handler's original limiter is an in-memory Map, so each edge
-- isolate (and each new isolate after eviction) had its own 4-query counter.
-- The real daily allowance was therefore a multiple of 4 rather than 4.
--
-- Constraints:
--   * Never store a raw client IP. `ip_hash` is SHA-256 of
--     "<ADVISOR_IP_SALT>:<ip>" with the salt held in a secret binding.
--   * One row per (ip_hash, utc_day); the primary key is the uniqueness and
--     idempotency contract for the upsert-increment.
--   * The day is the UTC calendar day, so the window reset is deterministic
--     across isolates instead of starting when a given isolate first saw the IP.
--   * The rows are only counters. They carry no message content, no provider
--     choice, and no timestamp finer than `updated_at`.

CREATE TABLE IF NOT EXISTS advisor_quota_usage (
  -- SHA-256 (hex) of the salted client IP.
  ip_hash     TEXT    NOT NULL,

  -- UTC calendar day of the window, 'YYYY-MM-DD'.
  utc_day     TEXT    NOT NULL,

  -- Successful model queries recorded for this client on this day.
  count       INTEGER NOT NULL DEFAULT 0,

  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (ip_hash, utc_day),
  CHECK (length(ip_hash) = 64),
  CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (count >= 0)
);

-- Retention sweep: DELETE FROM advisor_quota_usage WHERE utc_day < ?
CREATE INDEX IF NOT EXISTS idx_advisor_quota_usage_day
  ON advisor_quota_usage (utc_day);
