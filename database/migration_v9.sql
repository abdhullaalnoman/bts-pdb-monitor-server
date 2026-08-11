-- ============================================================
--  MIGRATION V9 — battery_source_updated_at on router_status
--
--  Lets the ping engine detect "this IP's row in
--  battery_latest_data was just re-uploaded" so it can reset
--  battery_current_capacity to the NEW Total_Battery_Capacity
--  right away — no server restart needed.
--
--  It stores the updated_at timestamp of battery_latest_data
--  that battery_current_capacity was last calculated against.
--  Every cycle, the engine compares this to the live
--  battery_latest_data.updated_at for that IP:
--    - same        -> keep charging/discharging as normal
--    - different    -> a fresh upload happened -> re-sync to
--                      the new total capacity (full charge)
-- ============================================================

ALTER TABLE router_status
  ADD COLUMN IF NOT EXISTS battery_source_updated_at TIMESTAMPTZ;

-- ============================================================
--  VERIFY
-- ============================================================
-- SELECT ip_address, battery_current_capacity, battery_soc, battery_source_updated_at
-- FROM router_status ORDER BY bts_name;
