
CREATE TABLE IF NOT EXISTS router_update (
    ip_address  TEXT        PRIMARY KEY
                             REFERENCES routers(ip_address)
                             ON DELETE CASCADE
                             ON UPDATE CASCADE,
    status      SMALLINT    NOT NULL DEFAULT 0 CHECK (status IN (0, 1)),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Backfill: add a row for every router that already exists ──
INSERT INTO router_update (ip_address, status, updated_at)
SELECT ip_address, 0, NOW() FROM routers
ON CONFLICT (ip_address) DO NOTHING;

-- ── Trigger: auto-insert a row whenever a NEW router is added ──
CREATE OR REPLACE FUNCTION fn_router_update_auto_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO router_update (ip_address, status, updated_at)
  VALUES (NEW.ip_address, 0, NOW())
  ON CONFLICT (ip_address) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_router_update_auto_insert ON routers;

CREATE TRIGGER trg_router_update_auto_insert
AFTER INSERT ON routers
FOR EACH ROW
EXECUTE FUNCTION fn_router_update_auto_insert();


