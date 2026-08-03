-- ============================================================
--  MIGRATION V8 — battery_current_capacity + battery_soc on
--  router_status, driven off battery_latest_data (matched by
--  ip_address) and the router's own up/down streak.
--
--  New columns:
--    battery_current_capacity  — running Ah value, starts at
--                                 that IP's Total_Battery_Capacity
--                                 (from battery_latest_data) and is
--                                 nudged up/down every 1 minute of
--                                 continuous Up/Down time.
--    battery_soc                — (battery_current_capacity /
--                                 total_battery_capacity) * 100
--    battery_up_accum_sec        — internal counter (seconds toward
--    battery_down_accum_sec        the next 1-minute charge/discharge
--                                 step). Not meant to be read by
--                                 clients, just lets the ping engine
--                                 pick back up correctly on restart.
-- ============================================================

ALTER TABLE router_status
  ADD COLUMN IF NOT EXISTS battery_current_capacity NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS battery_soc               NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS battery_up_accum_sec       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS battery_down_accum_sec     INTEGER NOT NULL DEFAULT 0;

-- ============================================================
--  VERIFY
-- ============================================================
-- SELECT ip_address, bts_name, status, battery_current_capacity, battery_soc
-- FROM router_status ORDER BY bts_name;
