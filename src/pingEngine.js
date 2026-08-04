// src/pingEngine.js — Production ICMP ping engine
// Windows ICMP ping | 40 routers per batch
// | countdown-based down detection WITH retroactive correction
// | batched DB writes (2 queries per cycle, +1 tiny correction
//   query only on the rare cycle a router gets confirmed Down)

require('dotenv').config();
const ping = require('ping');
const { query } = require('./db');

const PING_INTERVAL_MS     = parseInt(process.env.PING_INTERVAL_MS)     || 30000;
const BATCH_SIZE           = parseInt(process.env.PING_BATCH_SIZE)      || 40;
const COUNTDOWN_THRESHOLD  = parseInt(process.env.COUNTDOWN_THRESHOLD)  || 10;
const PING_TIMEOUT_S       = Math.floor((parseInt(process.env.PING_TIMEOUT_MS) || 3000) / 1000);

// In-memory state per router (keyed by ip_address)
// { upTime, downTime, status, countdown }
const routerState = {};

// In-memory battery state per router (keyed by ip_address).
// { current, soc, upAccum, downAccum } — preloaded from
// router_status at startup so a restart picks up where it left off.
const batteryState = {};

// ─── Ping a single IP with Windows ICMP (single attempt, no retry) ──────────
async function pingOne(ip) {
  try {
    const res = await ping.promise.probe(ip, {
      timeout: PING_TIMEOUT_S,
      extra:   ['-n', '1'],   // Windows: -n 1 (send 1 packet)
    });
    return res.alive;
  } catch {
    return false;
  }
}

// ─── Ping a batch of routers concurrently (1 attempt each) ──────────────────
async function pingBatch(routers) {
  return Promise.all(
    routers.map(async (router) => {
      const alive = await pingOne(router.ip_address);
      return { bts_name: router.bts_name, ip_address: router.ip_address, alive };
    })
  );
}

// ─── Update in-memory state using countdown logic ───────────────────────────
//
//  alive=true:
//    countdown = 0, status = 'Up', up_time += 30, down_time = 0
//
//  alive=false:
//    countdown += 1 (capped at COUNTDOWN_THRESHOLD)
//    countdown 1..(THRESHOLD-1) → still reported 'Up' (grace period),
//                                  up_time keeps growing normally
//    countdown == THRESHOLD     → CONFIRMED DOWN this cycle.
//                                  The entire grace window (the previous
//                                  THRESHOLD-1 cycles that were stored as
//                                  'Up') is now retroactively wrong — the
//                                  router was actually down that whole
//                                  time. down_time jumps straight to
//                                  THRESHOLD*30 (the full confirmed
//                                  window), and justConfirmed=true is
//                                  returned so runPingCycle() can fix
//                                  those already-written history rows.
//    countdown stays == THRESHOLD on later cycles (still down) →
//                                  down_time keeps growing normally (+30)
//
function updateState(ip, alive) {
  if (!routerState[ip]) {
    routerState[ip] = { upTime: 0, downTime: 0, status: 'Unknown', countdown: 0 };
  }
  const s = routerState[ip];
  let justConfirmed = false;

  if (alive) {
    s.countdown = 0;
    s.status    = 'Up';
    s.upTime   += 30;
    s.downTime  = 0;
  } else {
    const wasBelowThreshold = s.countdown < COUNTDOWN_THRESHOLD;
    if (s.countdown < COUNTDOWN_THRESHOLD) s.countdown += 1;

    if (s.countdown < COUNTDOWN_THRESHOLD) {
      // still in grace period — reported as Up for now
      s.status    = 'Up';
      s.upTime   += 30;
      s.downTime  = 0;
    } else {
      // confirmed down (countdown just hit, or already sitting at, threshold)
      s.status = 'Down';
      s.upTime = 0;

      if (wasBelowThreshold) {
        // this is the exact cycle the countdown reached the threshold —
        // the whole grace window is now retroactively "was actually down"
        justConfirmed = true;
        s.downTime = COUNTDOWN_THRESHOLD * 30;
      } else {
        // already confirmed down previously, still down, keep growing
        s.downTime += 30;
      }
    }
  }
  return { ...s, justConfirmed };
}

// ─── Get 24h up/down sums for ALL routers in ONE query ──────────────────────
async function get24hSumsForAll() {
  const sql = `
    SELECT
      ip_address,
      COALESCE(SUM(CASE WHEN status = 'Up'   THEN 30 ELSE 0 END), 0) AS up24,
      COALESCE(SUM(CASE WHEN status = 'Down' THEN 30 ELSE 0 END), 0) AS down24
    FROM ping_history
    WHERE checked_at >= NOW() - INTERVAL '24 hours'
    GROUP BY ip_address
  `;
  const res = await query(sql);
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.ip_address, {
      up24:   parseInt(row.up24),
      down24: parseInt(row.down24),
    });
  }
  return map;
}

// ─── For a router that just got confirmed Down, find the 24h up/down ───────
// ─── sums as they stood right BEFORE its grace period began (i.e. skip ─────
// ─── over the THRESHOLD-1 rows that are about to be corrected). This is ────
// ─── called BEFORE the correction UPDATE runs, so these 9 rows still ──────
// ─── exist as 'Up' at this point — we just skip past them with OFFSET. ─────
async function getPreGraceSums(ip) {
  const sql = `
    SELECT up_time_last_24h, down_time_last_24h
    FROM ping_history
    WHERE ip_address = $1
    ORDER BY checked_at DESC
    OFFSET $2
    LIMIT 1
  `;
  const res = await query(sql, [ip, COUNTDOWN_THRESHOLD - 1]);
  if (res.rowCount === 0) return { up24: 0, down24: 0 }; // brand-new router, no history yet
  return {
    up24:   parseInt(res.rows[0].up_time_last_24h)   || 0,
    down24: parseInt(res.rows[0].down_time_last_24h) || 0,
  };
}

// ─── Retroactively flip the last (THRESHOLD-1) history rows for this IP ─────
// ─── from Up → Down, now that the router has been confirmed Down. ──────────
//
//  FIX #1 — matches rows by ip_address + checked_at (real, stable, unique
//  column values) instead of ctid. ping_history is a TimescaleDB hypertable,
//  internally split into per-time-range chunks — ctid is only unique WITHIN
//  a single physical chunk, so a CTE-vs-UPDATE join on ctid alone can
//  silently fail to match rows. Matching on real column values guarantees
//  every intended row is actually found and updated.
//
//  FIX #2 — this function MUST be called (from runPingCycle, below) BEFORE
//  the current cycle's new row is inserted into ping_history. If the new
//  row were already inserted first, "the last 9 rows" would incorrectly
//  include that brand-new row, shifting the window by one and leaving the
//  oldest real grace row (countdown=1) stuck as 'Up' while rows 2-10 became
//  'Down'. Calling this first guarantees exactly rows 1-9 (the true grace
//  window) get corrected, and the current cycle's own row (inserted next)
//  becomes the 10th Down row.
async function correctGraceWindow(ip, preGrace) {
  const graceRows = COUNTDOWN_THRESHOLD - 1;
  if (graceRows <= 0) return;

  const sql = `
    WITH grace AS (
      SELECT checked_at, ROW_NUMBER() OVER (ORDER BY checked_at DESC) AS rn
      FROM ping_history
      WHERE ip_address = $1
      ORDER BY checked_at DESC
      LIMIT $2
    )
    UPDATE ping_history p
    SET
      status              = 'Down',
      up_time             = 0,
      down_time           = (($2 + 1) - grace.rn) * 30,
      up_time_last_24h    = $3,
      down_time_last_24h  = $4 + (($2 + 1) - grace.rn) * 30
    FROM grace
    WHERE p.ip_address = $1
      AND p.checked_at = grace.checked_at
  `;
  await query(sql, [ip, graceRows, preGrace.up24, preGrace.down24]);
}

// ─── Preload battery state from router_status (survives restarts) ──────────
async function preloadBatteryState() {
  try {
    const res = await query(`
      SELECT ip_address, battery_current_capacity, battery_soc,
             battery_up_accum_sec, battery_down_accum_sec
      FROM router_status
    `);
    for (const row of res.rows) {
      batteryState[row.ip_address] = {
        current:   row.battery_current_capacity !== null ? parseFloat(row.battery_current_capacity) : null,
        soc:       row.battery_soc              !== null ? parseFloat(row.battery_soc)              : null,
        upAccum:   row.battery_up_accum_sec   || 0,
        downAccum: row.battery_down_accum_sec || 0,
      };
    }
    console.log(`[PING ENGINE] Preloaded battery state for ${res.rowCount} router(s)`);
  } catch (err) {
    console.error('[PING ENGINE] Failed to preload battery state:', err.message);
  }
}

// ─── Get Total_Battery_Capacity / charging / discharging ampere ─────────────
// ─── for every IP from battery_latest_data, in ONE query ───────────────────
async function getBatteryLatestMap() {
  const map = new Map();
  try {
    const res = await query(`
      SELECT ip_address, total_battery_capacity, total_charging_ampere, total_discharging_ampere
      FROM battery_latest_data
    `);
    for (const row of res.rows) {
      map.set(row.ip_address, {
        totalCapacity: row.total_battery_capacity      !== null ? parseFloat(row.total_battery_capacity)      : null,
        chargeAmp:     row.total_charging_ampere        !== null ? parseFloat(row.total_charging_ampere)       : null,
        dischargeAmp:  row.total_discharging_ampere     !== null ? parseFloat(row.total_discharging_ampere)    : null,
      });
    }
  } catch (err) {
    console.error('[PING ENGINE] Failed to load battery_latest_data:', err.message);
  }
  return map;
}

// ─── Step battery_current_capacity / battery_soc for one router ────────────
//
//  Runs every ping cycle (30s), but the charge/discharge step itself
//  only actually happens once enough continuous Up (or Down) seconds
//  have accumulated to cross a full 1-minute boundary — a status flip
//  resets the OTHER direction's accumulator to 0 so a brief blip
//  doesn't carry over a stale partial minute.
//
//  Up   1 min -> current = min(total, current + charge_ampere / 60)
//  Down 1 min -> current = max(0,     current - discharge_ampere / 60)
//
//  If current is already at total (charging) or already at 0
//  (discharging), it simply stops moving in that direction — the
//  min()/max() clamps handle that automatically.
function stepBattery(ip, status, batteryInfo, justConfirmed) {
  if (!batteryState[ip]) {
    batteryState[ip] = { current: null, soc: null, upAccum: 0, downAccum: 0 };
  }
  const b = batteryState[ip];

  // No battery_latest_data row (or no capacity value) for this IP —
  // e.g. the table was truncated, or this IP was never in the file.
  // Clear it out (don't leave stale numbers sitting in router_status).
  // Next time real data shows up for this IP, b.current === null
  // below will re-initialize it fresh, starting full again.
  if (!batteryInfo || batteryInfo.totalCapacity === null) {
    b.current = null;
    b.soc = null;
    b.upAccum = 0;
    b.downAccum = 0;
    return b;
  }
  const totalCapacity = batteryInfo.totalCapacity;

  // First time we see this IP with real battery data — start full.
  if (b.current === null) b.current = totalCapacity;

  if (status === 'Up') {
    b.downAccum = 0;
    b.upAccum += 30;
    while (b.upAccum >= 60) {
      b.upAccum -= 60;
      if (batteryInfo.chargeAmp !== null && b.current < totalCapacity) {
        b.current = Math.min(totalCapacity, b.current + batteryInfo.chargeAmp / 60);
      }
      // else: already full (or no charge-ampere data) — stays the same
    }
  } else if (status === 'Down') {
    b.upAccum = 0;

    // This is the exact cycle the grace window got retroactively
    // confirmed Down (down_time just jumped to COUNTDOWN_THRESHOLD*30,
    // e.g. 300s/5min, in ping_history + router_status). The battery
    // was actually discharging that whole grace window too, but
    // stepBattery() only saw status='Up' during those cycles — so
    // catch up here by crediting the FULL confirmed window at once
    // instead of just this cycle's 30s, keeping battery in sync with
    // down_time/down_time_last_24h.
    b.downAccum += justConfirmed ? COUNTDOWN_THRESHOLD * 30 : 30;

    while (b.downAccum >= 60) {
      b.downAccum -= 60;
      if (batteryInfo.dischargeAmp !== null && b.current > 0) {
        b.current = Math.max(0, b.current - batteryInfo.dischargeAmp / 60);
      }
      // else: already at 0 (or no discharge-ampere data) — stays the same
    }
  }

  b.current = Math.round(b.current * 100) / 100;
  b.soc = totalCapacity > 0 ? Math.round((b.current / totalCapacity) * 10000) / 100 : null;

  return b;
}


function buildBatchUpsertStatus(rows) {
  const cols = [
    'bts_name', 'ip_address', 'up_time', 'down_time',
    'up_time_last_24h', 'down_time_last_24h', 'status', 'countdown',
    'battery_current_capacity', 'battery_soc',
    'battery_up_accum_sec', 'battery_down_accum_sec',
  ];
  const valuesSql = [];
  const params = [];

  rows.forEach((row, i) => {
    const base = i * cols.length;
    const placeholders = cols.map((_, j) => `$${base + j + 1}`);
    valuesSql.push(`(${placeholders.join(',')}, NOW())`);
    cols.forEach(c => params.push(row[c]));
  });

  const sql = `
    INSERT INTO router_status (${cols.join(',')}, updated_at)
    VALUES ${valuesSql.join(',')}
    ON CONFLICT (ip_address) DO UPDATE SET
      bts_name                 = EXCLUDED.bts_name,
      up_time                  = EXCLUDED.up_time,
      down_time                = EXCLUDED.down_time,
      up_time_last_24h         = EXCLUDED.up_time_last_24h,
      down_time_last_24h       = EXCLUDED.down_time_last_24h,
      status                   = EXCLUDED.status,
      countdown                = EXCLUDED.countdown,
      battery_current_capacity = EXCLUDED.battery_current_capacity,
      battery_soc               = EXCLUDED.battery_soc,
      battery_up_accum_sec      = EXCLUDED.battery_up_accum_sec,
      battery_down_accum_sec    = EXCLUDED.battery_down_accum_sec,
      updated_at               = NOW()
  `;
  return { sql, params };
}

// ─── Build one multi-row INSERT for ping_history ─────────────────────────────
function buildBatchInsertHistory(rows, timestamp) {
  const cols = [
    'bts_name', 'ip_address', 'up_time', 'down_time',
    'up_time_last_24h', 'down_time_last_24h', 'status', 'countdown', 'checked_at',
  ];
  const valuesSql = [];
  const params = [];

  rows.forEach((row, i) => {
    const base = i * cols.length;
    const placeholders = cols.map((_, j) => `$${base + j + 1}`);
    valuesSql.push(`(${placeholders.join(',')})`);
    cols.forEach(c => {
      params.push(c === 'checked_at' ? timestamp : row[c]);
    });
  });

  const sql = `INSERT INTO ping_history (${cols.join(',')}) VALUES ${valuesSql.join(',')}`;
  return { sql, params };
}

// ─── Load all routers from DB ────────────────────────────────────────────────
async function loadRouters() {
  const res = await query('SELECT bts_name, ip_address FROM routers ORDER BY id');
  return res.rows;
}

// ─── Main ping cycle ─────────────────────────────────────────────────────────
async function runPingCycle() {
  const cycleStart = Date.now();
  let routers;

  try {
    routers = await loadRouters();
  } catch (err) {
    console.error('[PING ENGINE] Failed to load routers:', err.message);
    return;
  }

  if (routers.length === 0) {
    console.log('[PING ENGINE] No routers found in DB. Waiting...');
    return;
  }

  const cycleTimestamp = new Date();
  console.log(`\n[PING ENGINE] ── Cycle start | ${routers.length} routers | ${cycleTimestamp.toISOString()}`);

  // ── Ping all routers in batches of BATCH_SIZE ──
  const allResults = [];
  for (let i = 0; i < routers.length; i += BATCH_SIZE) {
    const batch = routers.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(routers.length / BATCH_SIZE);
    console.log(`[PING ENGINE] Batch ${batchNum}/${totalBatches} | ${batch.length} routers`);
    const results = await pingBatch(batch);
    allResults.push(...results);
  }

  // ── Get 24h sums for all routers in ONE query (used for every router ──
  // ── EXCEPT ones that just got confirmed Down this exact cycle — those ──
  // ── use getPreGraceSums() instead, fetched further below) ──────────────
  let sums;
  try {
    sums = await get24hSumsForAll();
  } catch (err) {
    console.error('[PING ENGINE] Failed to get 24h sums:', err.message);
    sums = new Map();
  }

  // ── Get battery_latest_data (Total_Battery_Capacity / charge / ──
  // ── discharge ampere per IP) in ONE query, used to step every ────
  // ── router's battery_current_capacity / battery_soc below. ───────
  const batteryMap = await getBatteryLatestMap();

  // ── Pass 1: update in-memory state for every router, note which ──
  // ── ones just crossed the confirmation threshold this cycle ──────
  const updated = allResults.map(r => {
    const state = updateState(r.ip_address, r.alive);
    return { ...r, state };
  });
  const justConfirmedIps = updated.filter(u => u.state.justConfirmed).map(u => u.ip_address);

  // ── Pass 2: for any just-confirmed router, fetch the 24h sums as ──
  // ── they stood BEFORE its grace period began (small extra query, ──
  // ── only runs on the rare cycle a router flips to confirmed Down). ──
  // ── This MUST run before the correction UPDATE below, since it ──────
  // ── relies on the 9 grace rows still being 'Up' at this point. ───────
  const preGraceMap = new Map();
  for (const ip of justConfirmedIps) {
    try {
      preGraceMap.set(ip, await getPreGraceSums(ip));
    } catch (err) {
      console.error(`[PING ENGINE] Failed to get pre-grace sums for ${ip}:`, err.message);
      preGraceMap.set(ip, { up24: 0, down24: 0 });
    }
  }

  // ── Build final row objects for this cycle's batch insert ──
  const rows = updated.map(r => {
    const state = r.state;
    let up24h, down24h;

    if (state.justConfirmed) {
      const base = preGraceMap.get(r.ip_address) || { up24: 0, down24: 0 };
      up24h   = base.up24;                              // no Up growth during a down streak
      down24h = base.down24 + COUNTDOWN_THRESHOLD * 30;  // whole confirmed window counted
    } else {
      const sum = sums.get(r.ip_address) || { up24: 0, down24: 0 };
      up24h   = sum.up24   + (state.status === 'Up'   ? 30 : 0);
      down24h = sum.down24 + (state.status === 'Down' ? 30 : 0);
    }

    const symbol = r.alive ? '✔' : '✘';
    const tag = state.justConfirmed ? ' [CONFIRMED DOWN — correcting grace window]' : '';
    console.log(`[PING] ${symbol} ${r.bts_name} (${r.ip_address}) | status=${state.status} | up=${state.upTime}s | down=${state.downTime}s | countdown=${state.countdown}${tag}`);

    const battInfo = batteryMap.get(r.ip_address);
    const batt = stepBattery(r.ip_address, state.status, battInfo, state.justConfirmed);

    return {
      bts_name:           r.bts_name,
      ip_address:         r.ip_address,
      up_time:            state.upTime,
      down_time:          state.downTime,
      up_time_last_24h:   up24h,
      down_time_last_24h: down24h,
      status:             state.status,
      countdown:          state.countdown,
      battery_current_capacity: batt.current,
      battery_soc:              batt.soc,
      battery_up_accum_sec:     batt.upAccum,
      battery_down_accum_sec:   batt.downAccum,
    };
  });

  // ── ONE batch write to router_status ──
  try {
    const { sql, params } = buildBatchUpsertStatus(rows);
    await query(sql, params);
  } catch (err) {
    console.error('[PING ENGINE] Batch upsert (router_status) failed:', err.message);
  }

  // ── Retroactive correction — MUST run BEFORE this cycle's ping_history ──
  // ── insert below. correctGraceWindow() selects "the last 9 rows for ──────
  // ── this IP" — if the current cycle's new row were already inserted ─────
  // ── first, that new row would occupy one of those 9 slots and push the ──
  // ── oldest real grace row (countdown=1) out of the window, leaving it ────
  // ── incorrectly stuck as 'Up' while rows 2–10 became 'Down'. Running ─────
  // ── this first guarantees exactly rows 1–9 (the true grace window) get ──
  // ── corrected, and the current cycle's own row (inserted next, below) ────
  // ── becomes the 10th Down row. ────────────────────────────────────────────
  for (const ip of justConfirmedIps) {
    try {
      const preGrace = preGraceMap.get(ip) || { up24: 0, down24: 0 };
      await correctGraceWindow(ip, preGrace);
      console.log(`[PING ENGINE] Corrected grace window for ${ip} — rows 1-${COUNTDOWN_THRESHOLD - 1} flipped Up→Down`);
    } catch (err) {
      console.error(`[PING ENGINE] Failed to correct grace window for ${ip}:`, err.message);
    }
  }

  // ── ONE batch write to ping_history (this cycle's row for every router) ──
  try {
    const { sql, params } = buildBatchInsertHistory(rows, cycleTimestamp);
    await query(sql, params);
  } catch (err) {
    console.error('[PING ENGINE] Batch insert (ping_history) failed:', err.message);
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  const extraWrites = justConfirmedIps.length;
  console.log(`[PING ENGINE] ── Cycle done in ${elapsed}s (2 DB writes${extraWrites ? ` + ${extraWrites} correction write(s)` : ''})\n`);
}

// ─── Start the engine ────────────────────────────────────────────────────────
async function start() {
  console.log('[PING ENGINE] Starting...');
  console.log(`  Interval           : ${PING_INTERVAL_MS / 1000}s`);
  console.log(`  Batch size         : ${BATCH_SIZE} routers`);
  console.log(`  Countdown threshold: ${COUNTDOWN_THRESHOLD} cycles (= ${(COUNTDOWN_THRESHOLD * PING_INTERVAL_MS) / 1000}s to confirm Down)`);
  console.log(`  Ping timeout       : ${PING_TIMEOUT_S}s per ping`);
  console.log(`  Retroactive correction: ON — grace window rows get corrected Up→Down when confirmed`);

  await preloadBatteryState();
  await runPingCycle();

  setInterval(async () => {
    try {
      await runPingCycle();
    } catch (err) {
      console.error('[PING ENGINE] Cycle error:', err.message);
    }
  }, PING_INTERVAL_MS);
}

module.exports = { start };

if (require.main === module) {
  const { testConnection } = require('./db');
  testConnection().then(ok => {
    if (!ok) process.exit(1);
    start();
  });
}