-- ============================================================
--  MIGRATION V6 — battery_info table
--  Stores one row per BTS per uploaded month, from the monthly
--  Excel file. Uploading the same month again OVERWRITES that
--  month's data for each BTS (not duplicated). Different months
--  are kept separately, so history stays fully searchable.
--
--  Any Excel column that is empty/missing for a row is stored
--  as NULL — no defaults, no guessing.
-- ============================================================

CREATE TABLE IF NOT EXISTS battery_info (
    id                                  BIGSERIAL   PRIMARY KEY,
    bts_name                            TEXT        NOT NULL,
    report_month                        TEXT        NOT NULL,  -- 'YYYY-MM'

    camera_ip                           TEXT,
    zone                                TEXT,
    support_office                      TEXT,
    address                             TEXT,
    latitude                            TEXT,
    longitude                           TEXT,

    ups_a                               TEXT,
    ups_a_system_voltage                TEXT,
    ups_a_brand_name                    TEXT,
    ups_b                               TEXT,
    ups_b_system_voltage                TEXT,
    ups_b_brand_name                    TEXT,

    battery_type_a                      TEXT,
    battery_capacity_ah_a               TEXT,
    battery_quantity_a                  TEXT,
    battery_brand_name_a                TEXT,
    battery_type_b                      TEXT,
    battery_capacity_ah_b               TEXT,
    battery_quantity_b                  TEXT,
    battery_brand_name_b                TEXT,
    battery_type_c                      TEXT,
    battery_capacity_ah_c               TEXT,
    battery_quantity_c                  TEXT,
    battery_brand_name_c                TEXT,

    ups_a_charging_ampere                TEXT,
    ups_b_charging_ampere                TEXT,
    ups_a_discharge_ampere               TEXT,
    ups_b_discharge_ampere               TEXT,

    load_watt                           TEXT,
    power_backup_hour                   TEXT,
    generator_type                      TEXT,
    generator_capacity_kva              TEXT,

    cooling_a                           TEXT,
    cooling_a_capacity                  TEXT,
    cooling_b                           TEXT,
    cooling_b_capacity                  TEXT,

    contact_person                      TEXT,
    pdb_office                          TEXT,
    pdb_contact_number                  TEXT,

    link3_own_transformer               TEXT,
    single_phase_isolation_transformer  TEXT,
    isolation_transformer_qty           TEXT,
    radio_isolation_transformer         TEXT,
    mov                                 TEXT,

    infinibox_installation              TEXT,
    infinibox_sim_no                    TEXT,
    sms                                 TEXT,
    inquiry_time                        TEXT,

    uploaded_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Uploading the same month again for the same BTS overwrites
    -- (not duplicates) — this constraint enables that upsert.
    UNIQUE (bts_name, report_month)
);

CREATE INDEX IF NOT EXISTS idx_battery_info_bts_name     ON battery_info (bts_name);
CREATE INDEX IF NOT EXISTS idx_battery_info_report_month ON battery_info (report_month);

-- ============================================================
--  VERIFY
-- ============================================================
-- SELECT COUNT(*) FROM battery_info;
-- SELECT DISTINCT report_month FROM battery_info ORDER BY report_month DESC;
-- SELECT * FROM battery_info WHERE report_month = '2026-06' ORDER BY bts_name LIMIT 5;
