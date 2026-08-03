-- ============================================================
--  MIGRATION V7 — battery_latest_data table
--  ONE FIXED ROW PER IP ADDRESS (same pattern as router_status).
--
--  You upload the "Link3 BTS Details" Excel file every month
--  (any date). Each row in the file is matched to a row here by
--  ip_address:
--    - IP already exists  -> that row is UPDATED in place
--    - IP is new          -> a new row is INSERTED
--    - a column is empty/missing in the Excel row -> stored as
--      NULL (never guessed, never left as the old value)
--
--  So this table always reflects exactly what was in the LAST
--  uploaded file — no month history here (that's what
--  battery_info already does). Rows are otherwise fixed/stable
--  since the same BTS/IP list is uploaded every month.
-- ============================================================

CREATE TABLE IF NOT EXISTS battery_latest_data (
    ip_address                  VARCHAR(45)   PRIMARY KEY,
    bts_name                    TEXT,
    total_battery_capacity      NUMERIC(10,2),
    total_charging_ampere       NUMERIC(10,2),
    total_discharging_ampere    NUMERIC(10,2),
    load_watt                   NUMERIC(10,2),
    updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_battery_latest_data_bts_name
    ON battery_latest_data (bts_name);

