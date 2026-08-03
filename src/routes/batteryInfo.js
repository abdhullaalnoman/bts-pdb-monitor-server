// src/routes/batteryInfo.js
//
// battery_info — one row per BTS per uploaded month. Uploading
// the same month again overwrites that month's row for each BTS
// (via ON CONFLICT upsert) — never duplicates. Different months
// are kept side by side, so history stays fully searchable.

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx'); // used ONLY for reading uploaded files —
                                  // much faster/more resilient than ExcelJS
                                  // for files with heavy formatting on
                                  // unused rows/columns (a common Excel quirk)
const { query } = require('../db');

// Accept the uploaded file in memory (not saved to disk) — we
// parse it directly from the buffer.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
});

// Wraps multer's middleware so field-name mismatches, oversized
// files, or wrong file types return a CLEAR, specific message
// instead of falling through to a generic 500 crash.
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
  console.error('[BATTERY_INFO]', err.message);
  return res.status(500).json({ success: false, error: err.message });
}
function notFound(res, name) {
  return res.status(404).json({ success: false, error: `No battery_info found for BTS '${name}'` });
}

// ── Column order in the Excel sheet → database column names ──
// Column 1 (SL#) is skipped — it's just row order, not stored.
const COLUMN_MAP = [
  null, // SL#
  'camera_ip',
  'zone',
  'support_office',
  'bts_name',
  'address',
  'latitude',
  'longitude',
  'ups_a',
  'ups_a_system_voltage',
  'ups_a_brand_name',
  'ups_b',
  'ups_b_system_voltage',
  'ups_b_brand_name',
  'battery_type_a',
  'battery_capacity_ah_a',
  'battery_quantity_a',
  'battery_brand_name_a',
  'battery_type_b',
  'battery_capacity_ah_b',
  'battery_quantity_b',
  'battery_brand_name_b',
  'battery_type_c',
  'battery_capacity_ah_c',
  'battery_quantity_c',
  'battery_brand_name_c',
  'ups_a_charging_ampere',
  'ups_b_charging_ampere',
  'ups_a_discharge_ampere',
  'ups_b_discharge_ampere',
  'load_watt',
  'power_backup_hour',
  'generator_type',
  'generator_capacity_kva',
  'cooling_a',
  'cooling_a_capacity',
  'cooling_b',
  'cooling_b_capacity',
  'contact_person',
  'pdb_office',
  'pdb_contact_number',
  'link3_own_transformer',
  'single_phase_isolation_transformer',
  'isolation_transformer_qty',
  'radio_isolation_transformer',
  'mov',
  'infinibox_installation',
  'infinibox_sim_no',
  'sms',
  'inquiry_time',
];

// All stored columns except id/bts_name/report_month/uploaded_at —
// used for building the INSERT column list and the UPDATE SET list.
const DATA_COLUMNS = COLUMN_MAP.filter(c => c && c !== 'bts_name');

function cellToText(val) {
  if (val === null || val === undefined || val === '') return null;
  return String(val).trim() || null;
}

// ══════════════════════════════════════════════════════════
//  POST /api/battery-info/upload?month=YYYY-MM
//  Upload the monthly Excel file (multipart/form-data, field
//  name "file"). If ?month= isn't given, defaults to the
//  current calendar month at upload time.
// ══════════════════════════════════════════════════════════
router.post('/battery-info/upload', handleUpload, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded. Field name must be "file".' });
  }

  let reportMonth = req.query.month;
  if (!reportMonth) {
    reportMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  }
  if (!/^\d{4}-\d{2}$/.test(reportMonth)) {
    return res.status(400).json({ success: false, error: 'month must be in YYYY-MM format' });
  }

  try {
    // Parse with xlsx (SheetJS) — much faster and unaffected by
    // Excel files that have formatting applied across a huge
    // range beyond the actual data (a common real-world quirk
    // that made ExcelJS hang for minutes on files like this).
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return res.status(400).json({ success: false, error: 'Excel file has no worksheet' });
    }
    const ws = workbook.Sheets[sheetName];

    // header: 1 → array-of-arrays, one array per row, in column order.
    // defval: null → empty cells become null instead of being omitted.
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    // Hard safety cap — even with xlsx being fast, this guarantees
    // an unusually huge/corrupt file can never hang the server.
    const MAX_ROWS = 5000;
    const dataRows = rows.slice(1, MAX_ROWS + 1); // skip header row (row 1)

    const records = [];
    for (const rowArr of dataRows) {
      if (!rowArr || rowArr.every(v => v === null || v === '')) continue; // skip fully empty rows

      const record = {};
      COLUMN_MAP.forEach((col, i) => {
        if (!col) return; // skip SL#
        record[col] = cellToText(rowArr[i]);
      });

      if (!record.bts_name) continue; // skip rows with no BTS name at all
      records.push(record);
    }

    if (records.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid rows found (no BTS Name values detected)' });
    }

    // ── Upsert every record for this month in one batch query ──
    const cols = ['bts_name', 'report_month', ...DATA_COLUMNS];
    const valuesSql = [];
    const params = [];

    records.forEach((rec, i) => {
      const base = i * cols.length;
      const placeholders = cols.map((_, j) => `$${base + j + 1}`);
      valuesSql.push(`(${placeholders.join(',')})`);
      cols.forEach(c => {
        if (c === 'bts_name')      params.push(rec.bts_name);
        else if (c === 'report_month') params.push(reportMonth);
        else params.push(rec[c] ?? null);
      });
    });

    const updateSet = DATA_COLUMNS.map(c => `${c} = EXCLUDED.${c}`).join(',\n        ');

    const upsertSQL = `
      INSERT INTO battery_info (${cols.join(',')})
      VALUES ${valuesSql.join(',')}
      ON CONFLICT (bts_name, report_month) DO UPDATE SET
        ${updateSet},
        uploaded_at = NOW()
    `;
    await query(upsertSQL, params);

    res.json({
      success: true,
      report_month: reportMonth,
      rows_processed: records.length,
      message: `Uploaded battery info for ${records.length} BTS for ${reportMonth}`,
    });

  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/battery-info?month=YYYY-MM
//  All BTS battery info. If ?month= is omitted, returns each
//  BTS's MOST RECENT uploaded month (latest snapshot).
// ══════════════════════════════════════════════════════════
router.get('/battery-info', async (req, res) => {
  const month = req.query.month;
  try {
    let sql, params;
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, error: 'month must be in YYYY-MM format' });
      }
      sql = `SELECT * FROM battery_info WHERE report_month = $1 ORDER BY bts_name`;
      params = [month];
    } else {
      sql = `
        SELECT DISTINCT ON (bts_name) *
        FROM battery_info
        ORDER BY bts_name, report_month DESC
      `;
      params = [];
    }
    const result = await query(sql, params);
    res.json({ success: true, month: month || 'latest', count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/battery-info/months
//  List every month that has data (for a month picker).
// ══════════════════════════════════════════════════════════
router.get('/battery-info/months', async (req, res) => {
  try {
    const result = await query(`
      SELECT report_month, COUNT(*) AS bts_count, MAX(uploaded_at) AS uploaded_at
      FROM battery_info
      GROUP BY report_month
      ORDER BY report_month DESC
    `);
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/battery-info/:bts_name?month=YYYY-MM
//  Single BTS info. If ?month= omitted, returns the latest
//  uploaded snapshot for that BTS.
// ══════════════════════════════════════════════════════════
router.get('/battery-info/:bts_name', async (req, res) => {
  const btsName = decodeURIComponent(req.params.bts_name);
  const month   = req.query.month;
  try {
    let sql, params;
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, error: 'month must be in YYYY-MM format' });
      }
      sql = `SELECT * FROM battery_info WHERE bts_name = $1 AND report_month = $2`;
      params = [btsName, month];
    } else {
      sql = `
        SELECT * FROM battery_info
        WHERE bts_name = $1
        ORDER BY report_month DESC
        LIMIT 1
      `;
      params = [btsName];
    }
    const result = await query(sql, params);
    if (result.rowCount === 0) return notFound(res, btsName);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/battery-info/:bts_name/history
//  Every month's data for one BTS, oldest to newest.
// ══════════════════════════════════════════════════════════
router.get('/battery-info/:bts_name/history', async (req, res) => {
  const btsName = decodeURIComponent(req.params.bts_name);
  try {
    const result = await query(
      `SELECT * FROM battery_info WHERE bts_name = $1 ORDER BY report_month ASC`,
      [btsName]
    );
    if (result.rowCount === 0) return notFound(res, btsName);
    res.json({ success: true, bts_name: btsName, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  PUT /api/battery-info/:bts_name?month=YYYY-MM
//  Manually update specific fields for one BTS/month.
//  Body: any subset of the data columns, e.g.
//    { "battery_type_a": "Lithium", "battery_quantity_a": "24" }
//  If ?month= omitted, updates that BTS's LATEST record.
// ══════════════════════════════════════════════════════════
router.put('/battery-info/:bts_name', async (req, res) => {
  const btsName = decodeURIComponent(req.params.bts_name);
  const month   = req.query.month;
  const updates = req.body || {};

  const fieldsToUpdate = Object.keys(updates).filter(k => DATA_COLUMNS.includes(k));
  if (fieldsToUpdate.length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to update were provided' });
  }

  try {
    // Find the target row (specific month, or latest)
    let targetSql, targetParams;
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, error: 'month must be in YYYY-MM format' });
      }
      targetSql = `SELECT id FROM battery_info WHERE bts_name = $1 AND report_month = $2`;
      targetParams = [btsName, month];
    } else {
      targetSql = `SELECT id FROM battery_info WHERE bts_name = $1 ORDER BY report_month DESC LIMIT 1`;
      targetParams = [btsName];
    }
    const targetRes = await query(targetSql, targetParams);
    if (targetRes.rowCount === 0) return notFound(res, btsName);
    const id = targetRes.rows[0].id;

    const setClauses = fieldsToUpdate.map((f, i) => `${f} = $${i + 1}`);
    const params = fieldsToUpdate.map(f => updates[f]);
    params.push(id);

    const sql = `
      UPDATE battery_info
      SET ${setClauses.join(', ')}, uploaded_at = NOW()
      WHERE id = $${params.length}
      RETURNING *
    `;
    const result = await query(sql, params);

    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/battery-info/:bts_name?month=YYYY-MM
//  Remove one BTS's data for a specific month.
// ══════════════════════════════════════════════════════════
router.delete('/battery-info/:bts_name', async (req, res) => {
  const btsName = decodeURIComponent(req.params.bts_name);
  const month   = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, error: 'month query param (YYYY-MM) is required for delete' });
  }
  try {
    const result = await query(
      `DELETE FROM battery_info WHERE bts_name = $1 AND report_month = $2 RETURNING id`,
      [btsName, month]
    );
    if (result.rowCount === 0) return notFound(res, btsName);
    res.json({ success: true, message: `Deleted ${btsName}'s data for ${month}` });
  } catch (err) { serverError(res, err); }
});

module.exports = router;