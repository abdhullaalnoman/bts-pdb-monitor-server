// src/routes/routerUpdate.js
//
// router_update — a FIXED table (never grows, one row per router).
// An external system pushes ip_address + status (0 or 1) here.
// Each push OVERWRITES the previous status for that router —
// old status is simply replaced, not kept as history.

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

function serverError(res, err) {
  console.error('[ROUTER_UPDATE]', err.message);
  return res.status(500).json({ success: false, error: err.message });
}

// ══════════════════════════════════════════════════════════
//  POST /api/router-update
//  External system pushes a status update for one router.
//  Body: { "ip_address": "10.200.205.2", "status": 1 }
//
//  status must be exactly 0 or 1.
//  If a row for this ip_address already exists, it's OVERWRITTEN
//  (old status replaced, updated_at set to now). Since this table
//  is FIXED SIZE, this never inserts a new row — only updates the
//  one row that already exists for this router (created
//  automatically when the router was added to `routers`).
// ══════════════════════════════════════════════════════════
router.post('/router-update', async (req, res) => {
  const { ip_address, status } = req.body;

  if (!ip_address) {
    return res.status(400).json({ success: false, error: 'ip_address is required' });
  }
  if (status !== 0 && status !== 1) {
    return res.status(400).json({ success: false, error: 'status must be exactly 0 or 1' });
  }

  try {
    // Confirm this IP belongs to a known router first — gives a
    // clean, friendly error instead of a raw foreign-key violation
    // if an unknown IP gets pushed.
    const check = await query('SELECT ip_address FROM routers WHERE ip_address = $1', [ip_address]);
    if (check.rowCount === 0) {
      return res.status(404).json({ success: false, error: `No router found with ip_address '${ip_address}'` });
    }

    const sql = `
      INSERT INTO router_update (ip_address, status, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (ip_address) DO UPDATE SET
        status     = EXCLUDED.status,
        updated_at = NOW()
      RETURNING ip_address, status, updated_at
    `;
    const result = await query(sql, [ip_address, status]);

    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/router-update
//  List the current pushed status for every router.
// ══════════════════════════════════════════════════════════
router.get('/router-update', async (req, res) => {
  try {
    const sql = `
      SELECT ru.ip_address, r.bts_name, ru.status, ru.updated_at
      FROM router_update ru
      JOIN routers r ON r.ip_address = ru.ip_address
      ORDER BY r.bts_name
    `;
    const result = await query(sql);
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/router-update/:ip
//  Current pushed status for one specific router.
// ══════════════════════════════════════════════════════════
router.get('/router-update/:ip', async (req, res) => {
  const ip = req.params.ip;
  try {
    const sql = `
      SELECT ru.ip_address, r.bts_name, ru.status, ru.updated_at
      FROM router_update ru
      JOIN routers r ON r.ip_address = ru.ip_address
      WHERE ru.ip_address = $1
    `;
    const result = await query(sql, [ip]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: `No router found with ip_address '${ip}'` });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

module.exports = router;