// src/routes/batteryLatestData.js
//
// battery_latest_data — ONE FIXED ROW PER IP ADDRESS.
// Upload the monthly "Link3 BTS Details" Excel file (any date,
// any month) and every row is matched to a DB row by ip_address:
//   - IP found     -> row is UPDATED (every column overwritten,
//                      including turning it to NULL if that cell
//                      is empty in the new file)
//   - IP not found -> a new row is INSERTED
//
// Excel columns (in this order):
//   SL # | BTS Name | Total Battery Capacity | Total Charging
//   Ampere | Total Discharging Ampere | Load (Watt) | Ip

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const { query } = require('../db');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({
          success: false,
          error: `Form field name must be exactly "file" (got a mismatched field). In Postman, set the Key column to "file", not the filename.`,
        });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'File is too large (max 20MB).' });
      }
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    }
    next();
  });
}

function serverError(res, err) {
  console.error('[BATTERY_LATEST_DATA]', err.message);
  return res.status(500).json({ success: false, error: err.message });
}
function notFound(res, ip) {
  return res.status(404).json({ success: false, error: `No battery_latest_data found for IP '${ip}'` });
}

// ── Column order in the Excel sheet → database column names ──
// Column 1 (SL#) is skipped — it's just row order, not stored.
const COLUMN_MAP = [
  null, // SL #
  'bts_name',
  'total_battery_capacity',
  'total_charging_ampere',
  'total_discharging_ampere',
  'load_watt',
  'ip_address',
];

// All stored data columns except ip_address (the key) — used for
// building the INSERT column list and the UPDATE SET list.
const DATA_COLUMNS = COLUMN_MAP.filter(c => c && c !== 'ip_address');

// Columns that must be stored as NUMERIC(10,2) — everything
// else (currently just bts_name) stays plain text.
const NUMERIC_COLUMNS = new Set([
  'total_battery_capacity',
  'total_charging_ampere',
  'total_discharging_ampere',
  'load_watt',
]);

function cellToText(val) {
  if (val === null || val === undefined || val === '') return null;
  return String(val).trim() || null;
}

// Parses a cell into a number rounded to 2 decimal places.
// Empty/missing/non-numeric cells become null (never guessed).
function cellToNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).trim().replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

function cellToColumn(col, val) {
  return NUMERIC_COLUMNS.has(col) ? cellToNumber(val) : cellToText(val);
}

// ══════════════════════════════════════════════════════════
//  POST /api/battery-latest/upload
//  Upload the monthly Excel file (multipart/form-data, field
//  name "file"). Upserts every row by ip_address — updates
//  existing IPs in place, inserts rows for new IPs. Any cell
//  that's empty/missing in the file is stored as NULL.
// ══════════════════════════════════════════════════════════
router.post('/battery-latest/upload', handleUpload, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded. Field name must be "file".' });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return res.status(400).json({ success: false, error: 'Excel file has no worksheet' });
    }
    const ws = workbook.Sheets[sheetName];

    // header: 1 → array-of-arrays, one array per row, in column order.
    // defval: null → empty cells become null instead of being omitted.
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    const MAX_ROWS = 5000;
    const dataRows = rows.slice(1, MAX_ROWS + 1); // skip header row (row 1)

    const records = [];
    for (const rowArr of dataRows) {
      if (!rowArr || rowArr.every(v => v === null || v === '')) continue; // skip fully empty rows

      const record = {};
      COLUMN_MAP.forEach((col, i) => {
        if (!col) return; // skip SL#
        record[col] = cellToColumn(col, rowArr[i]);
      });

      if (!record.ip_address) continue; // skip rows with no IP at all
      records.push(record);
    }

    if (records.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid rows found (no Ip values detected)' });
    }

    // ── Upsert every record by ip_address in one batch query ──
    const cols = ['ip_address', ...DATA_COLUMNS];
    const valuesSql = [];
    const params = [];

    records.forEach((rec, i) => {
      const base = i * cols.length;
      const placeholders = cols.map((_, j) => `$${base + j + 1}`);
      valuesSql.push(`(${placeholders.join(',')})`);
      cols.forEach(c => {
        if (c === 'ip_address') params.push(rec.ip_address);
        else params.push(rec[c] ?? null);
      });
    });

    const updateSet = DATA_COLUMNS.map(c => `${c} = EXCLUDED.${c}`).join(',\n        ');

    const upsertSQL = `
      INSERT INTO battery_latest_data (${cols.join(',')})
      VALUES ${valuesSql.join(',')}
      ON CONFLICT (ip_address) DO UPDATE SET
        ${updateSet},
        updated_at = NOW()
    `;
    await query(upsertSQL, params);

    res.json({
      success: true,
      rows_processed: records.length,
      message: `Uploaded battery latest data for ${records.length} IP(s)`,
    });

  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/battery-latest
//  All BTS battery latest data.
// ══════════════════════════════════════════════════════════
router.get('/battery-latest', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM battery_latest_data ORDER BY bts_name`);
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/battery-latest/:ip
//  Single BTS battery latest data, looked up by IP.
// ══════════════════════════════════════════════════════════
router.get('/battery-latest/:ip', async (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  try {
    const result = await query(`SELECT * FROM battery_latest_data WHERE ip_address = $1`, [ip]);
    if (result.rowCount === 0) return notFound(res, ip);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/battery-latest/search/by-name/:bts_name
//  Look up by BTS name instead of IP (partial, case-insensitive).
// ══════════════════════════════════════════════════════════
router.get('/battery-latest/search/by-name/:bts_name', async (req, res) => {
  const name = decodeURIComponent(req.params.bts_name);
  try {
    const result = await query(
      `SELECT * FROM battery_latest_data WHERE bts_name ILIKE $1 ORDER BY bts_name`,
      [`%${name}%`]
    );
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  PUT /api/battery-latest/:ip
//  Manually update specific fields for one IP.
//  Body: any subset of { bts_name, total_battery_capacity,
//    total_charging_ampere, total_discharging_ampere, load_watt }
//  If the IP doesn't exist yet, it's created (upsert).
// ══════════════════════════════════════════════════════════
router.put('/battery-latest/:ip', async (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  const updates = req.body || {};

  const fieldsToUpdate = Object.keys(updates).filter(k => DATA_COLUMNS.includes(k));
  if (fieldsToUpdate.length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to update were provided' });
  }

  // Round any numeric fields to 2 decimals, same as the upload path.
  const cleanValue = (f, v) => (NUMERIC_COLUMNS.has(f) ? cellToNumber(v) : v);

  try {
    const existing = await query(`SELECT ip_address FROM battery_latest_data WHERE ip_address = $1`, [ip]);

    if (existing.rowCount === 0) {
      // Upsert-create: insert a new row with just the given fields.
      const cols = ['ip_address', ...fieldsToUpdate];
      const params = [ip, ...fieldsToUpdate.map(f => cleanValue(f, updates[f]))];
      const placeholders = cols.map((_, i) => `$${i + 1}`);
      const result = await query(
        `INSERT INTO battery_latest_data (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`,
        params
      );
      return res.json({ success: true, created: true, data: result.rows[0] });
    }

    const setClauses = fieldsToUpdate.map((f, i) => `${f} = $${i + 1}`);
    const params = fieldsToUpdate.map(f => cleanValue(f, updates[f]));
    params.push(ip);

    const sql = `
      UPDATE battery_latest_data
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE ip_address = $${params.length}
      RETURNING *
    `;
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/battery-latest/:ip
//  Remove one IP's row entirely.
// ══════════════════════════════════════════════════════════
router.delete('/battery-latest/:ip', async (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  try {
    const result = await query(
      `DELETE FROM battery_latest_data WHERE ip_address = $1 RETURNING ip_address`,
      [ip]
    );
    if (result.rowCount === 0) return notFound(res, ip);
    res.json({ success: true, message: `Deleted battery latest data for ${ip}` });
  } catch (err) { serverError(res, err); }
});

module.exports = router;