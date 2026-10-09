const express = require('express');
const cors = require('cors');
const { pool, initDatabase } = require('./db');
const multer = require('multer');
const XLSX = require('xlsx');
const sql = require('mssql');

const app = express();
app.use(cors());
app.use(express.json());

// Konfigurasi Koneksi SQL Server
const sqlServerConfig = {
  user: 'usergp',
  password: '12Gpuser',
  server: '192.168.0.117',
  database: 'CORPORATE',
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// 1. ENDPOINT LOGIN USER
// ==========================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, username, password, full_name, role FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Username tidak ditemukan!' });
    }

    const user = result.rows[0];
    if (user.password === password) {
      return res.json({
        success: true,
        message: 'Login berhasil!',
        user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role }
      });
    } else {
      return res.status(401).json({ success: false, message: 'Password salah!' });
    }
  } catch (err) {
    console.error('Error Login:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// ==========================================
// 2. ENDPOINT GET & UPDATE LIST SALES ROUTE
// ==========================================
app.get('/api/sales-routes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman FROM list_salesman_route ORDER BY id ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Error Fetch Sales Routes:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data rute salesman: ' + err.message });
  }
});

app.put('/api/sales-routes/:id', async (req, res) => {
  const { id } = req.params;
  const { nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman } = req.body;

  try {
    const result = await pool.query(
      `UPDATE list_salesman_route 
       SET nama_divisi = $1, nama_team = $2, kode_area = $3, nama_area = $4, kode_salesman = $5, nama_salesman = $6 
       WHERE id = $7 RETURNING *`,
      [nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data rute tidak ditemukan' });
    }

    res.json({ success: true, message: 'Data rute berhasil diperbarui', data: result.rows[0] });
  } catch (err) {
    console.error('Error Update Sales Route:', err);
    res.status(500).json({ success: false, message: 'Gagal mengupdate data rute: ' + err.message });
  }
});

// ==========================================
// 3. ENDPOINT SIMPAN DATA TARGET & LOG PERUBAHAN
// ==========================================
app.post('/api/save-target', async (req, res) => {
  const client = await pool.connect();
  try {
    const { divisi, year, totalTarget, monthlyPcts, bjbPct, jjbPct, bjbAreas, jjbAreas } = req.body;
    const targetDivisi = divisi || 'AGPC';

    await client.query('BEGIN');

    // Hapus data lama jika sudah ada (overwrite)
    const existingAnnual = await client.query(
      'SELECT id FROM annual_targets WHERE divisi = $1 AND year = $2',
      [targetDivisi, year]
    );

    if (existingAnnual.rows.length > 0) {
      await client.query('DELETE FROM annual_targets WHERE id = $1', [existingAnnual.rows[0].id]);
    }

    // Insert Header Target Tahunan
    const targetRes = await client.query(
      `INSERT INTO annual_targets (divisi, year, total_target) VALUES ($1, $2, $3) RETURNING id`,
      [targetDivisi, year, totalTarget]
    );
    const annualTargetId = targetRes.rows[0].id;

    // Insert Persentase Target Bulanan (1-12)
    for (let i = 0; i < monthlyPcts.length; i++) {
      await client.query(
        `INSERT INTO monthly_target_percentages (annual_target_id, month, percentage, nominal_value)
         VALUES ($1, $2, $3, $4)`,
        [annualTargetId, i + 1, monthlyPcts[i], totalTarget * (monthlyPcts[i] / 100)]
      );
    }

    // Insert Persentase Divisi BJB & JJB
    await client.query(
      `INSERT INTO division_targets (annual_target_id, division_code, percentage) VALUES ($1, 'BJB', $2), ($1, 'JJB', $3)`,
      [annualTargetId, bjbPct, jjbPct]
    );

    // Process Area & Detail Kunjungan (K01 - K06)
    const processAreaSave = async (divisionCode, areaList) => {
      if (!areaList || !Array.isArray(areaList)) return;
      for (const area of areaList) {
        const areaCode = area.code || area.area_code || '';
        const areaName = area.name || area.area_name || '';
        const areaPct = area.pct || area.percentage || 0;

        // Cek Log Perubahan Nama Area
        const prevAreaRes = await client.query(
          `SELECT at.area_name FROM area_targets at
           JOIN annual_targets ant ON at.annual_target_id = ant.id
           WHERE ant.divisi = $1 AND at.area_code = $2 AND at.annual_target_id != $3 
           ORDER BY at.id DESC LIMIT 1`,
          [targetDivisi, areaCode, annualTargetId]
        );

        if (prevAreaRes.rows.length > 0) {
          const oldName = prevAreaRes.rows[0].area_name;
          if (oldName !== areaName && areaName && areaName.trim() !== "") {
            await client.query(
              `INSERT INTO area_change_logs (divisi, year, division_code, area_code, old_name, new_name) 
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [targetDivisi, year, divisionCode, areaCode, oldName, areaName]
            );
          }
        }

        // Insert Area Target
        const areaRes = await client.query(
          `INSERT INTO area_targets (annual_target_id, division_code, area_code, area_name, percentage)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [annualTargetId, divisionCode, areaCode, areaName, areaPct]
        );
        const areaTargetId = areaRes.rows[0].id;

        // Insert Sales Kunjungan (K01 - K06)
        if (area.kunjunganPcts && Array.isArray(area.kunjunganPcts)) {
          const kCodes = ["K01", "K02", "K03", "K04", "K05", "K06"];
          for (let kIdx = 0; kIdx < area.kunjunganPcts.length; kIdx++) {
            await client.query(
              `INSERT INTO sales_kunjungan_targets (area_target_id, kunjungan_code, percentage)
               VALUES ($1, $2, $3)`,
              [areaTargetId, kCodes[kIdx], area.kunjunganPcts[kIdx] || 0]
            );
          }
        }
      }
    };

    await processAreaSave('BJB', bjbAreas);
    await processAreaSave('JJB', jjbAreas);

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: `Data Target ${targetDivisi} Tahun ${year} berhasil disimpan ke Database!` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error simpan target:', err);
    res.status(500).json({ success: false, message: 'Gagal menyimpan target: ' + err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 4. ENDPOINT GET HISTORY TAHUN REPORT (AGPC & AGPS)
// ==========================================
app.get('/api/history-years', async (req, res) => {
  try {
    const { divisi } = req.query;
    const targetDivisi = divisi || 'AGPC';

    const result = await pool.query(
      'SELECT DISTINCT year, total_target FROM annual_targets WHERE divisi = $1 ORDER BY year DESC',
      [targetDivisi]
    );

    res.json({ success: true, years: result.rows });
  } catch (err) {
    console.error('Error Fetch History Years:', err);
    res.json({ success: true, years: [] });
  }
});

// =========================================================================
// ENDPOINT GET HISTORY TARGET DIVISI AGPC (KHUSUS TARGET-AGPC.HTML)
// =========================================================================
// =========================================================================
// ENDPOINT GET HISTORY AGPC (ANTI-ERROR 42P01 / TABEL TIDAK ADA)
// =========================================================================
// =========================================================================
// ENDPOINT GET HISTORY AGPC (PASTI COCOK KOLOM DIVISI)
// =========================================================================
// =========================================================================
// ENDPOINT GET HISTORY AGPC (PASTI BACA TABEL DETAIL DENGAN BENAR)
// =========================================================================
// =========================================================================
// ENDPOINT GET HISTORY TARGET DIVISI AGPC (SESUAI SKEMA POSTGRESQL ASLI)
// =========================================================================
// =========================================================================
// ENDPOINT GET HISTORY AGPC (MURNI BACA DATABASE - TANPA DIVISION RATA)
// =========================================================================
app.get('/api/get-agpc-target-by-year/:year', async (req, res) => {
  try {
    const { year } = req.params;
    const yearInt = parseInt(year);

    // 1. Ambil Header dari annual_targets
    const headerRes = await pool.query(
      "SELECT * FROM annual_targets WHERE year = $1 AND UPPER(divisi) = $2 ORDER BY id DESC LIMIT 1",
      [yearInt, (req.query.divisi || 'AGPC').toString().toUpperCase()]
    );

    if (headerRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: `Data target ${(req.query.divisi || 'AGPC').toString().toUpperCase()} tahun ${year} tidak ditemukan.` });
    }
    const header = headerRes.rows[0];

    // 2. Ambil Persentase & Nominal Bulanan Asli yang Tersimpan
    const monthlyRes = await pool.query(
      "SELECT * FROM monthly_target_percentages WHERE annual_target_id = $1 ORDER BY month ASC",
      [header.id]
    );

    // 3. Ambil Target Divisi Asli (BJB / JJB)
    const divisionRes = await pool.query(
      "SELECT * FROM division_targets WHERE annual_target_id = $1",
      [header.id]
    );

    // 4. Ambil Target Area Asli
    const areaRes = await pool.query(
      "SELECT * FROM area_targets WHERE annual_target_id = $1 ORDER BY id ASC",
      [header.id]
    );

    // 5. Ambil Target Kunjungan Sales Asli (K01 - K06)
    const areasWithKunjungan = await Promise.all(areaRes.rows.map(async (area) => {
      const kunjunganRes = await pool.query(
        "SELECT * FROM sales_kunjungan_targets WHERE area_target_id = $1 ORDER BY kunjungan_code ASC",
        [area.id]
      );
      return {
        ...area,
        kunjungan: kunjunganRes.rows
      };
    }));

    res.json({
      success: true,
      data: {
        header: header,
        monthly: monthlyRes.rows,
        divisions: divisionRes.rows,
        areas: areasWithKunjungan
      }
    });

  } catch (err) {
    console.error('Error GET AGPC Target:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data AGPC: ' + err.message });
  }
});
// ENDPOINT GET HISTORY TARGET AGPC (DYNAMIC TABLE CHECKING)
// =========================================================================
const handleGetAgpcHistory = async (req, res) => {
  try {
    const { year } = req.params;

    // 1. Deteksi Tabel Header yang Ada di Database
    const tablesCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const existingTables = tablesCheck.rows.map(r => r.table_name);

    let headerRes;
    let headerTable = '';

    if (existingTables.includes('agpc_annual_targets')) {
      headerTable = 'agpc_annual_targets';
      headerRes = await pool.query('SELECT * FROM agpc_annual_targets WHERE year = $1 ORDER BY id DESC LIMIT 1', [parseInt(year)]);
    } else if (existingTables.includes('annual_targets')) {
      headerTable = 'annual_targets';
      headerRes = await pool.query("SELECT * FROM annual_targets WHERE year = $1 AND (UPPER(division) = 'AGPC' OR UPPER(divisi) = 'AGPC') ORDER BY id DESC LIMIT 1", [parseInt(year)]);
    } else if (existingTables.includes('target_headers')) {
      headerTable = 'target_headers';
      headerRes = await pool.query("SELECT * FROM target_headers WHERE year = $1 AND (UPPER(division) = 'AGPC' OR UPPER(divisi) = 'AGPC') ORDER BY id DESC LIMIT 1", [parseInt(year)]);
    } else {
      // Fallback query tabel header
      headerRes = await pool.query("SELECT * FROM target_divisi_headers WHERE year = $1 AND UPPER(divisi) = 'AGPC' ORDER BY id DESC LIMIT 1", [parseInt(year)]);
    }

    if (!headerRes || headerRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: `Data target AGPC tahun ${year} tidak ditemukan.` });
    }
    const header = headerRes.rows[0];

    // 2. Deteksi Tabel Detail
    let detailTable = 'agpc_province_targets';
    if (!existingTables.includes('agpc_province_targets')) {
      if (existingTables.includes('province_targets')) detailTable = 'province_targets';
      else if (existingTables.includes('target_details')) detailTable = 'target_details';
    }

    // 3. Deteksi Kolom FK
    const colCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = $1
    `, [detailTable]);
    const dbColumns = colCheck.rows.map(r => r.column_name);

    let fkCol = 'agpc_annual_target_id';
    if (dbColumns.includes('annual_target_id')) fkCol = 'annual_target_id';
    else if (dbColumns.includes('header_id')) fkCol = 'header_id';
    else if (dbColumns.includes('target_header_id')) fkCol = 'target_header_id';

    // 4. Query Detail Data
    const detailRes = await pool.query(
      `SELECT * FROM ${detailTable} WHERE ${fkCol} = $1 ORDER BY id ASC`,
      [header.id]
    );

    // 5. Format Data
    const formattedDetails = detailRes.rows.map(row => {
      const mArr = [];
      for (let m = 1; m <= 12; m++) {
        const mKey2 = m < 10 ? `m0${m}` : `m${m}`;
        const mKey1 = `m${m}`;
        const valM = row[mKey2] !== undefined ? parseFloat(row[mKey2]) : (row[mKey1] !== undefined ? parseFloat(row[mKey1]) : 0);
        mArr.push(isNaN(valM) ? 0 : valM);
      }

      return {
        ...row,
        annual_target: parseFloat(row.annual_target || row.target || row.nominal || 0),
        monthlyValues: mArr,
        monthly: mArr
      };
    });

    res.json({
      success: true,
      data: {
        header: header,
        details: formattedDetails,
        provinces: formattedDetails
      }
    });

  } catch (err) {
    console.error('Error GET AGPC Target:', err);
    res.status(500).json({ success: false, message: 'Server Internal Error: ' + err.message });
  }
};

app.get('/api/get-agpc-target-by-year/:year', handleGetAgpcHistory);
app.get('/api/agpc-target-by-year/:year', handleGetAgpcHistory);
app.get('/api/get-target-by-year/:year', handleGetAgpcHistory);

// ==========================================
// 6. ENDPOINT LOG PERUBAHAN NAMA AREA
// ==========================================
app.get('/api/change-logs', async (req, res) => {
  try {
    const { divisi } = req.query;
    const targetDivisi = divisi || 'AGPC';

    const result = await pool.query(`
      SELECT year, division_code, area_code, old_name, new_name, 
             TO_CHAR(created_at, 'DD-MM-YYYY HH24:MI') as formatted_date
      FROM area_change_logs 
      WHERE divisi = $1
      ORDER BY id DESC
    `, [targetDivisi]);

    res.json({ success: true, logs: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 7. ENDPOINT GET HISTORY TRANSAKSI
// ==========================================
app.get('/api/history-transaksi', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search.toLowerCase()}%` : null;

    let whereClause = '';
    let queryParams = [limit, offset];

    if (search) {
      whereClause = `
        WHERE LOWER(dhs.nama_salesman) LIKE $3 
           OR LOWER(dhs.nama_customer) LIKE $3 
           OR LOWER(dhs.no_transaksi) LIKE $3 
           OR LOWER(dhs.nama_barang) LIKE $3
      `;
      queryParams.push(search);
    }

    const countRes = await pool.query(`
      SELECT COUNT(*) 
      FROM data_history_sales dhs
      ${whereClause}
    `, search ? [search] : []);
    
    const totalRows = parseInt(countRes.rows[0].count);
    const totalPages = Math.ceil(totalRows / limit);

    const dataRes = await pool.query(`
      SELECT 
        dhs.month,
        dhs.nama_divisi,
        COALESCE(dhs.kode_area, 'KTR') as kode_area,
        COALESCE(dhs.area, 'KANTOR') as area,
        dhs.kode_salesman,
        dhs.nama_salesman,
        dhs.nama_pasar,
        dhs.kode_customer,
        dhs.nama_customer,
        dhs.kode_barang,
        dhs.nama_barang,
        dhs.no_transaksi,
        TO_CHAR(dhs.tanggal, 'DD/MM/YYYY') as tanggal,
        dhs.kode_kunjungan,
        dhs.qty_crt,
        dhs.dpp_rp
      FROM data_history_sales dhs
      ${whereClause}
      ORDER BY dhs.tanggal DESC, dhs.id DESC
      LIMIT $1 OFFSET $2
    `, queryParams);

    res.json({
      success: true,
      data: dataRes.rows,
      pagination: { totalRows, totalPages, currentPage: page, limit }
    });
  } catch (err) {
    console.error('Error Fetch History Transaksi:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data history: ' + err.message });
  }
});

// ==========================================
// ENDPOINT HISTORY TAHUN AGP N
// ==========================================
app.get('/api/agpn-history-years', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT year, 
              COALESCE(total_target, (COALESCE(group_1_target, 0) + COALESCE(group_2_target, 0))) as total_target 
       FROM agpn_annual_targets 
       ORDER BY year DESC`
    );
    res.json({ success: true, years: result.rows });
  } catch (err) {
    console.error('Error History AGP N:', err);
    res.json({ success: true, years: [] });
  }
});


// ==========================================
// 2. ENDPOINT GET DETAIL AGP N (FIXED COLUMN MAPPING)
// ==========================================
app.get('/api/get-agpn-target-by-year/:year', async (req, res) => {
  try {
    const { year } = req.params;

    // Ambil Header Target dari agpn_annual_targets
    const headerRes = await pool.query(
      'SELECT * FROM agpn_annual_targets WHERE year = $1 ORDER BY id DESC LIMIT 1',
      [parseInt(year)]
    );

    if (headerRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data target AGP N tidak ditemukan' });
    }
    const header = headerRes.rows[0];

    // Ambil Detail Provinsi
    const detailRes = await pool.query(
      `SELECT * FROM agpn_province_targets 
       WHERE agpn_annual_target_id = $1 OR annual_target_id = $1 OR header_id = $1 
       ORDER BY id ASC`,
      [header.id]
    );

    const formattedDetails = detailRes.rows.map(row => {
      const mArr = [];
      for (let m = 1; m <= 12; m++) {
        const mKey2 = m < 10 ? `m0${m}` : `m${m}`;
        const mKey1 = `m${m}`;
        // Ambil nilai dari properti DB, fallback ke 0
        const valM = row[mKey2] !== undefined ? parseFloat(row[mKey2]) : (row[mKey1] !== undefined ? parseFloat(row[mKey1]) : 0);
        mArr.push(isNaN(valM) ? 0 : valM);
      }

      return {
        ...row,
        annual_target: parseFloat(row.annual_target || 0),
        group_type: parseInt(row.group_type || row.group_index || row.group_no || 1),
        province_name: (row.province_name || row.area_name || row.name || 'WILAYAH').trim().toUpperCase(),
        monthlyValues: mArr,
        monthly: mArr
      };
    });

    res.json({
      success: true,
      data: {
        header: header,
        details: formattedDetails,
        provinces: formattedDetails
      }
    });

  } catch (err) {
    console.error('Error GET AGP N Target:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data: ' + err.message });
  }
});
// ==========================================
// ENDPOINT SAVE DATA AGP N
// ==========================================
// =========================================================================
// ENDPOINT SIMPAN DATA TARGET AGPC (LENGKAP DENGAN TRANSACTION)
// =========================================================================
app.post('/api/save-agpc-target', async (req, res) => {
  const client = await pool.connect();
  try {
    const { year, divisi, total_target, monthly, divisions, areas } = req.body;
    const yearInt = parseInt(year) || 2026;
    const divStr = (divisi || 'AGPC').toUpperCase();
    const targetNominal = parseFloat(total_target || 0);

    await client.query('BEGIN');

    // 1. Hapus Data Lama untuk Tahun & Divisi Tersebut (Agar Bersih)
    const existingHeader = await client.query(
      "SELECT id FROM annual_targets WHERE year = $1 AND UPPER(divisi) = $2",
      [yearInt, divStr]
    );

    if (existingHeader.rows.length > 0) {
      const oldId = existingHeader.rows[0].id;
      // Hapus detail sales kunjungan
      await client.query(
        "DELETE FROM sales_kunjungan_targets WHERE area_target_id IN (SELECT id FROM area_targets WHERE annual_target_id = $1)",
        [oldId]
      );
      await client.query("DELETE FROM area_targets WHERE annual_target_id = $1", [oldId]);
      await client.query("DELETE FROM division_targets WHERE annual_target_id = $1", [oldId]);
      await client.query("DELETE FROM monthly_target_percentages WHERE annual_target_id = $1", [oldId]);
      await client.query("DELETE FROM annual_targets WHERE id = $1", [oldId]);
    }

    // 2. Insert Header Baru ke annual_targets
    const headerRes = await client.query(
      "INSERT INTO annual_targets (year, total_target, divisi) VALUES ($1, $2, $3) RETURNING id",
      [yearInt, targetNominal, divStr]
    );
    const annualTargetId = headerRes.rows[0].id;

    // 3. Insert Persentase Bulanan (12 Bulan)
    if (monthly && Array.isArray(monthly)) {
      for (const m of monthly) {
        const valPct = parseFloat(m.percentage || 0);
        const nominalVal = targetNominal * (valPct / 100);
        await client.query(
          "INSERT INTO monthly_target_percentages (annual_target_id, month, percentage, nominal_value) VALUES ($1, $2, $3, $4)",
          [annualTargetId, parseInt(m.month), valPct, nominalVal]
        );
      }
    }

    // 4. Insert Division Targets (BJB / JJB)
    if (divisions && Array.isArray(divisions)) {
      for (const d of divisions) {
        await client.query(
          "INSERT INTO division_targets (annual_target_id, division_code, percentage) VALUES ($1, $2, $3)",
          [annualTargetId, d.division_code, parseFloat(d.percentage || 0)]
        );
      }
    }

    // 5. Insert Area Targets & Sales Kunjungan (K01 - K06)
    if (areas && Array.isArray(areas)) {
      for (const a of areas) {
        const areaRes = await client.query(
          "INSERT INTO area_targets (annual_target_id, division_code, area_code, area_name, percentage) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [annualTargetId, divStr, a.area_code, a.area_name || '', parseFloat(a.percentage || 0)]
        );
        const areaTargetId = areaRes.rows[0].id;

        if (a.kunjungan && Array.isArray(a.kunjungan)) {
          for (const k of a.kunjungan) {
            await client.query(
              "INSERT INTO sales_kunjungan_targets (area_target_id, kunjungan_code, percentage) VALUES ($1, $2, $3)",
              [areaTargetId, k.kunjungan_code, parseFloat(k.percentage || 0)]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Data Target AGPC berhasil disimpan ke database!' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error Save AGPC Target:', err);
    res.status(500).json({ success: false, message: 'Gagal menyimpan ke database: ' + err.message });
  } finally {
    client.release();
  }
});






// ==========================================
// 2. ENDPOINT SAVE DATA AGP N (SAFE DYNAMIC INSERT)
// ==========================================
app.post('/api/save-agpn-target', async (req, res) => {
  const client = await pool.connect();
  try {
    const { year, totalTarget, group1Target, group2Target, details, provinces } = req.body;
    const listDetails = details || provinces || [];

    await client.query('BEGIN');

    // Hapus header lama
    const existingHeader = await client.query('SELECT id FROM agpn_annual_targets WHERE year = $1', [year]);
    if (existingHeader.rows.length > 0) {
      await client.query('DELETE FROM agpn_annual_targets WHERE id = $1', [existingHeader.rows[0].id]);
    }

    // Insert Header
    const headerRes = await client.query(
      `INSERT INTO agpn_annual_targets (year, total_target, group_1_target, group_2_target) 
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [year, totalTarget || 0, group1Target || 0, group2Target || 0]
    );
    const headerId = headerRes.rows[0].id;

    // Cek kolom tabel
    const tableInfo = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'agpn_province_targets'
    `);
    const dbColumns = tableInfo.rows.map(r => r.column_name);

    let fkCol = 'agpn_annual_target_id';
    if (dbColumns.includes('annual_target_id')) fkCol = 'annual_target_id';
    else if (dbColumns.includes('header_id')) fkCol = 'header_id';

    for (let i = 0; i < listDetails.length; i++) {
      const item = listDetails[i];
      const gVal = parseInt(item.group_type || item.group_index || 1);

      const insertCols = [fkCol];
      const insertVals = [headerId];

      if (dbColumns.includes('group_index')) { insertCols.push('group_index'); insertVals.push(gVal); }
      if (dbColumns.includes('group_type')) { insertCols.push('group_type'); insertVals.push(gVal); }
      if (dbColumns.includes('province_code')) { insertCols.push('province_code'); insertVals.push(item.province_code || `AGPN-${i+1}`); }
      if (dbColumns.includes('province_name')) { insertCols.push('province_name'); insertVals.push(item.province_name || 'WILAYAH'); }
      if (dbColumns.includes('annual_target')) { insertCols.push('annual_target'); insertVals.push(item.annual_target || 0); }

      // WAJIB: Insert m01 s/d m12 ke Database!
      for (let m = 1; m <= 12; m++) {
        const mKey = m < 10 ? `m0${m}` : `m${m}`;
        if (dbColumns.includes(mKey)) {
          insertCols.push(mKey);
          insertVals.push(item[mKey] || 0);
        }
      }

      const placeholders = insertVals.map((_, idx) => `$${idx + 1}`).join(', ');
      await client.query(`INSERT INTO agpn_province_targets (${insertCols.join(', ')}) VALUES (${placeholders})`, insertVals);
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Target AGP N Tahun ${year} berhasil disimpan ke Database!` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error Save AGP N Target:', err);
    res.status(500).json({ success: false, message: 'Gagal simpan: ' + err.message });
  } finally {
    client.release();
  }
});
// ==========================================
// 3. ENDPOINT SIMPAN TARGET AGP N (DYNAMIC SAVE)
// ==========================================
// ==========================================
// ENDPOINT SIMPAN TARGET AGP N (AMANO / SAFE INSERT)
// ==========================================
// ==========================================
// ENDPOINT SIMPAN TARGET AGP N (DYNAMIC COLUMN MATCHING)
// ==========================================
// ==========================================
// ENDPOINT SIMPAN TARGET AGP N (SAFE NOT-NULL GROUP_INDEX)
// ==========================================
app.post('/api/save-agpn-target', async (req, res) => {
  const client = await pool.connect();
  try {
    const { year, totalTarget, group1Target, group2Target, details, provinces } = req.body;
    const listDetails = details || provinces || [];

    await client.query('BEGIN');

    // 1. Hapus data lama untuk tahun yang sama jika ada
    const existingHeader = await client.query('SELECT id FROM agpn_annual_targets WHERE year = $1', [year]);
    if (existingHeader.rows.length > 0) {
      await client.query('DELETE FROM agpn_annual_targets WHERE id = $1', [existingHeader.rows[0].id]);
    }

    // 2. Insert Header ke agpn_annual_targets
    const headerRes = await client.query(
      `INSERT INTO agpn_annual_targets (year, total_target, group_1_target, group_2_target) 
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [year, totalTarget || 0, group1Target || 0, group2Target || 0]
    );
    const headerId = headerRes.rows[0].id;

    // 3. Inspeksi Daftar Kolom di Tabel agpn_province_targets
    const tableInfo = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'agpn_province_targets'
    `);
    const dbColumns = tableInfo.rows.map(r => r.column_name);

    // Tentukan Nama Kolom FK
    let fkCol = 'agpn_annual_target_id';
    if (dbColumns.includes('annual_target_id')) fkCol = 'annual_target_id';
    else if (dbColumns.includes('target_agpn_header_id')) fkCol = 'target_agpn_header_id';
    else if (dbColumns.includes('agpn_target_id')) fkCol = 'agpn_target_id';
    else if (dbColumns.includes('header_id')) fkCol = 'header_id';

    // Tentukan Nama Kolom Kode (Code Column)
    let codeCol = null;
    if (dbColumns.includes('province_code')) codeCol = 'province_code';
    else if (dbColumns.includes('area_code')) codeCol = 'area_code';
    else if (dbColumns.includes('code')) codeCol = 'code';

    // Tentukan Nama Kolom Nama Provinsi/Area (Name Column)
    let nameCol = null;
    if (dbColumns.includes('province_name')) nameCol = 'province_name';
    else if (dbColumns.includes('area_name')) nameCol = 'area_name';
    else if (dbColumns.includes('name')) nameCol = 'name';

    // Cek Keberadaan Kolom Grup
    const hasGroupIndex = dbColumns.includes('group_index');
    const hasGroupType  = dbColumns.includes('group_type');
    const hasGroupNo    = dbColumns.includes('group_no');
    const hasAnnualTarget = dbColumns.includes('annual_target');

    // 4. Loop Insert Detail dengan Pengisian Angka Grup Wajib
    for (let i = 0; i < listDetails.length; i++) {
      const item = listDetails[i];
      const gValue = parseInt(item.group_type || item.groupType || item.group_index || 1);

      const insertCols = [fkCol];
      const insertVals = [headerId];

      if (hasGroupIndex) {
        insertCols.push('group_index');
        insertVals.push(gValue);
      }

      if (hasGroupType) {
        insertCols.push('group_type');
        insertVals.push(gValue);
      }

      if (hasGroupNo) {
        insertCols.push('group_no');
        insertVals.push(gValue);
      }

      if (codeCol) {
        insertCols.push(codeCol);
        insertVals.push(item.province_code || item.area_code || item.code || `AGPN-${i + 1}`);
      }

      if (nameCol) {
        insertCols.push(nameCol);
        insertVals.push(item.province_name || item.area_name || item.name || 'WILAYAH');
      }

      if (hasAnnualTarget) {
        insertCols.push('annual_target');
        insertVals.push(item.annual_target || item.annualTarget || 0);
      }

      // Masukkan Kolom Bulanan m01 s/d m12 jika ada di tabel DB
      for (let m = 1; m <= 12; m++) {
        const mKey = m < 10 ? `m0${m}` : `m${m}`;
        if (dbColumns.includes(mKey)) {
          insertCols.push(mKey);
          insertVals.push(item[mKey] || 0);
        }
      }

      const placeholders = insertVals.map((_, idx) => `$${idx + 1}`).join(', ');
      const queryText = `INSERT INTO agpn_province_targets (${insertCols.join(', ')}) VALUES (${placeholders})`;

      await client.query(queryText, insertVals);
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Target AGP N Tahun ${year} berhasil disimpan ke Database!` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error Save AGP N Target:', err);
    res.status(500).json({ success: false, message: 'Gagal menyimpan target AGP N: ' + err.message });
  } finally {
    client.release();
  }
});


// ==========================================
// 8. ENDPOINT UPLOAD MASTER SALES
// ==========================================
app.post('/api/upload-omset-excel', upload.array('excelFiles', 3), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: 'Tidak ada file yang diunggah!' });
  }

  const client = await pool.connect();

  try {
    const mode = req.body.mode || 'overwrite';

    const routeRes = await client.query('SELECT kode_salesman, kode_area, nama_area FROM list_salesman_route');
    const routeMap = {};
    routeRes.rows.forEach(r => {
      if (r.kode_salesman) {
        routeMap[r.kode_salesman.trim().toLowerCase()] = {
          kode_area: r.kode_area,
          area: r.nama_area
        };
      }
    });

    const cleanRows = [];

    const parseExcelDate = (val) => {
      if (!val) return null;
      if (val instanceof Date && !isNaN(val.getTime())) {
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const d = String(val.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }

      const strVal = String(val).trim();
      if (strVal.length > 20 || strVal.toLowerCase().includes('total')) return null;

      const monthMap = {
        jan: '01', feb: '02', mar: '03', apr: '04', mei: '05', may: '05',
        jun: '06', jul: '07', ags: '08', aug: '08', sep: '09', okt: '10',
        oct: '10', nov: '11', des: '12', dec: '12'
      };

      if (strVal.includes('/') || strVal.includes('-')) {
        const parts = strVal.split(/[\/\-]/);
        if (parts.length === 3) {
          let p0 = parts[0].trim();
          let p1 = parts[1].trim().toLowerCase();
          let p2 = parts[2].trim();

          if (monthMap[p1.substring(0, 3)]) {
            p1 = monthMap[p1.substring(0, 3)];
          } else {
            p1 = p1.padStart(2, '0');
          }

          if (/^\d+$/.test(p0) && /^\d+$/.test(p1) && /^\d+$/.test(p2)) {
            if (p0.length === 4) return `${p0}-${p1}-${p2.padStart(2, '0')}`;
            if (p2.length === 4) return `${p2}-${p1}-${p0.padStart(2, '0')}`;
            if (p2.length === 2) return `20${p2}-${p1}-${p0.padStart(2, '0')}`;
          }
        }
      }

      const numVal = Number(val);
      if (!isNaN(numVal) && numVal > 30000 && numVal < 60000) {
        const parsedDate = new Date((numVal - (25567 + 2)) * 86400 * 1000);
        if (!isNaN(parsedDate.getTime())) {
          const y = parsedDate.getFullYear();
          const m = String(parsedDate.getMonth() + 1).padStart(2, '0');
          const d = String(parsedDate.getDate()).padStart(2, '0');
          return `${y}-${m}-${d}`;
        }
      }
      return null;
    };

    // Parser angka: mendukung nilai MINUS (retur), contoh: -1.500.000 | (1.500.000) | 1.500.000- | -1500000,50
    const parseAmount = (item) => {
      if (item === "" || item === null || item === undefined) return null;
      if (typeof item === 'number') return isNaN(item) ? null : item;

      let s = String(item).trim();
      if (!s) return null;
      if (s.includes('/')) return null;                          // tanggal
      if (/^\d{1,4}-\d{1,2}-\d{1,4}$/.test(s)) return null;     // tanggal format 05-10-2026

      let neg = false;
      if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }   // format akuntansi (1.000)
      if (/^[-\u2212\u2013]/.test(s)) { neg = true; s = s.slice(1).trim(); } // minus di depan
      if (/[-\u2212\u2013]$/.test(s)) { neg = true; s = s.slice(0, -1).trim(); } // minus di belakang
      if (s.includes('-')) return null;                          // teks lain, mis. no transaksi RJ-I260011.GP

      s = s.replace(/\s/g, '');
      if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
      else if (s.includes(',')) s = s.replace(',', '.');
      if (s === '') return null;

      const n = Number(s);
      if (isNaN(n)) return null;
      return neg ? -n : n;
    };

    for (const fileObj of req.files) {
      const workbook = XLSX.read(fileObj.buffer, { type: 'buffer', cellDates: true, raw: false });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      let idxKodeSales = -1, idxNamaSales = -1, idxNamaPasar = -1, idxKodeCust = -1, idxNamaCust = -1, idxKodeBrg = -1, idxNamaBrg = -1, idxNoTrx = -1;

      for (let r = 0; r < Math.min(rawData.length, 10); r++) {
        const row = rawData[r];
        if (!row) continue;
        row.forEach((cell, idx) => {
          const text = String(cell).trim().toLowerCase();
          if (text === 'kode salesman' || text === 'kodesalesman') idxKodeSales = idx;
          if (text === 'nama salesman' || text === 'namasalesman') idxNamaSales = idx;
          if (text === 'nama pasar' || text === 'namapasar') idxNamaPasar = idx;
          if (text === 'kode customer' || text === 'kodecust') idxKodeCust = idx;
          if (text === 'nama customer' || text === 'namacust') idxNamaCust = idx;
          if (text === 'kode barang' || text === 'kodebarang') idxKodeBrg = idx;
          if (text === 'nama barang' || text === 'namabarang') idxNamaBrg = idx;
          if (text === 'no transaksi' || text === 'notransaksi' || text === 'no. transaksi') idxNoTrx = idx;
        });
      }

      if (idxKodeSales === -1) idxKodeSales = 4;
      if (idxNamaSales === -1) idxNamaSales = 8;
      if (idxNamaPasar === -1) idxNamaPasar = 12;
      if (idxKodeCust === -1)  idxKodeCust  = 16;
      if (idxNamaCust === -1)  idxNamaCust  = 20;
      if (idxKodeBrg === -1)   idxKodeBrg   = 24;
      if (idxNamaBrg === -1)   idxNamaBrg   = 28;
      if (idxNoTrx === -1)     idxNoTrx     = 36;

      let currentDivisi = "AGPC", currentKodeSales = "", currentNamaSales = "", currentNamaPasar = "", currentKodeCust = "", currentNamaCust = "", currentKodeBarang = "", currentNamaBarang = "";

      for (let i = 7; i < rawData.length; i++) {
        const row = rawData[i];
        if (!row || row.length === 0) continue;

        const fullRowText = row.join(' ').toLowerCase();
        if (fullRowText.includes('total') || fullRowText.includes('jenis transaksi') || fullRowText.includes('nama barang')) {
          if (fullRowText.includes('total')) { currentKodeBarang = ""; currentNamaBarang = ""; }
          continue;
        }

        const rawDivisi    = row[0] ? String(row[0]).trim() : (row[1] ? String(row[1]).trim() : "");
        const rawKodeSales = row[idxKodeSales] ? String(row[idxKodeSales]).trim() : "";
        const rawNamaSales = row[idxNamaSales] ? String(row[idxNamaSales]).trim() : "";
        const rawNamaPasar = row[idxNamaPasar] ? String(row[idxNamaPasar]).trim() : "";
        const rawKodeCust  = row[idxKodeCust]  ? String(row[idxKodeCust]).trim()  : "";
        const rawNamaCust  = row[idxNamaCust]  ? String(row[idxNamaCust]).trim()  : "";
        const rawKodeBrg   = row[idxKodeBrg]   ? String(row[idxKodeBrg]).trim()   : "";
        const rawNamaBrg   = row[idxNamaBrg]   ? String(row[idxNamaBrg]).trim()   : "";
        const rawNoTrx     = row[idxNoTrx]     ? String(row[idxNoTrx]).trim()     : "";

        if (rawDivisi)    currentDivisi     = rawDivisi;
        if (rawKodeSales) currentKodeSales  = rawKodeSales;
        if (rawNamaSales) currentNamaSales  = rawNamaSales;
        if (rawNamaPasar) currentNamaPasar  = rawNamaPasar;
        if (rawKodeCust)  currentKodeCust   = rawKodeCust;
        if (rawNamaCust)  currentNamaCust   = rawNamaCust;
        if (rawKodeBrg)   currentKodeBarang = rawKodeBrg;
        if (rawNamaBrg && !parseExcelDate(rawNamaBrg)) currentNamaBarang = rawNamaBrg;

        let formattedDate = null, rawKunjungan = "";
        for (let c = 25; c < row.length; c++) {
          if (row[c]) {
            const checkDate = parseExcelDate(row[c]);
            if (checkDate) {
              formattedDate = checkDate;
              if (row[c + 4]) rawKunjungan = String(row[c + 4]).trim();
              else if (row[c + 1] && String(row[c + 1]).startsWith('K')) rawKunjungan = String(row[c + 1]).trim();
              break;
            }
          }
        }

        if (!formattedDate) continue;

        const numValues = [];
        for (let c = row.length - 1; c >= 30; c--) {
          const parsedNum = parseAmount(row[c]);
          if (parsedNum !== null) numValues.push(parsedNum);
        }

        let valDpp = numValues.length >= 1 ? numValues[0] : 0;
        let valQty = numValues.length >= 2 ? Math.round(numValues[1]) : 0;

        // Retur (No Transaksi diawali RJ): DPP harus minus (mengurangi omset)
        if (/^RJ/i.test(rawNoTrx || '') && valDpp > 0) valDpp = -valDpp;

        let finalKodeArea = 'KTR', finalArea = 'KANTOR';
        if (currentKodeSales && routeMap[currentKodeSales.toLowerCase()]) {
          finalKodeArea = routeMap[currentKodeSales.toLowerCase()].kode_area || 'KTR';
          finalArea = routeMap[currentKodeSales.toLowerCase()].area || 'KANTOR';
        }

        cleanRows.push({
          nama_divisi: currentDivisi,
          kode_salesman: currentKodeSales,
          nama_salesman: currentNamaSales,
          nama_pasar: currentNamaPasar,
          kode_customer: currentKodeCust,
          nama_customer: currentNamaCust,
          kode_barang: currentKodeBarang || "-",
          nama_barang: currentNamaBarang || "-",
          no_transaksi: rawNoTrx || "-",
          tanggal: formattedDate,
          kode_kunjungan: rawKunjungan || "-",
          qty_crt: valQty,
          dpp_rp: valDpp,
          kode_area: finalKodeArea,
          area: finalArea
        });
      }
    }

    if (cleanRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada baris transaksi valid pada file Excel!' });
    }

    await client.query('BEGIN');

    const uploadDateObj = new Date(cleanRows[0].tanggal);
    const targetYear = uploadDateObj.getFullYear();
    const targetMonth = uploadDateObj.getMonth() + 1;

    if (mode === 'overwrite') {
      await client.query(
        `DELETE FROM data_master_sales 
         WHERE EXTRACT(YEAR FROM tanggal) = $1 
           AND EXTRACT(MONTH FROM tanggal) = $2`,
        [targetYear, targetMonth]
      );
    }

    for (const d of cleanRows) {
      await client.query(
        `INSERT INTO data_master_sales 
        (nama_divisi, kode_salesman, nama_salesman, nama_pasar, kode_customer, nama_customer, kode_barang, nama_barang, no_transaksi, tanggal, kode_kunjungan, qty_crt, dpp_rp, kode_area, area)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [d.nama_divisi, d.kode_salesman, d.nama_salesman, d.nama_pasar, d.kode_customer, d.nama_customer, d.kode_barang, d.nama_barang, d.no_transaksi, d.tanggal, d.kode_kunjungan, d.qty_crt, d.dpp_rp, d.kode_area, d.area]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Berhasil menyimpan ${cleanRows.length} baris data ke data_master_sales!` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error Parsing Excel:', err);
    res.status(500).json({ success: false, message: 'Gagal memproses file Excel: ' + err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 9. ENDPOINT GET DATA FAKTUR TOLAKAN & BATAL
// ==========================================
app.get('/api/faktur-tolakan', async (req, res) => {
  try {
    const month = parseInt(req.query.month) || 9;
    const year = parseInt(req.query.year) || 2026;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    let poolSql = await sql.connect(sqlServerConfig);

    let countResult = await poolSql.request()
      .input('Tahun', sql.Int, year)
      .input('Bulan', sql.Int, month)
      .query(`
        SELECT COUNT(*) AS total 
        FROM rprekaptolakanall WITH (NOLOCK)
        WHERE tanggal >= DATEFROMPARTS(@Tahun, @Bulan, 1)
          AND tanggal < DATEADD(month, 1, DATEFROMPARTS(@Tahun, @Bulan, 1))
      `);

    const totalRows = countResult.recordset[0].total;
    const totalPages = Math.ceil(totalRows / limit);

    let dataResult = await poolSql.request()
      .input('Tahun', sql.Int, year)
      .input('Bulan', sql.Int, month)
      .input('Offset', sql.Int, offset)
      .input('Limit', sql.Int, limit)
      .query(`
        SELECT 
          Kd_faktur,
          Kd_tolakan,
          Kd_Customer,
          Kd_Salesman,
          NamaSalesman,
          NamaCustomer,
          NamaBarang,
          qtytolakan AS Qty
        FROM rprekaptolakanall WITH (NOLOCK)
        WHERE tanggal >= DATEFROMPARTS(@Tahun, @Bulan, 1)
          AND tanggal < DATEADD(month, 1, DATEFROMPARTS(@Tahun, @Bulan, 1))
        ORDER BY NamaCustomer, NamaSalesman
        OFFSET @Offset ROWS
        FETCH NEXT @Limit ROWS ONLY
      `);

    res.json({
      success: true,
      data: dataResult.recordset,
      pagination: { totalRows, totalPages, currentPage: page, limit }
    });
  } catch (err) {
    console.error('Error SQL Server Faktur Tolakan:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data Faktur Tolakan: ' + err.message });
  }
});

app.get('/api/faktur-batal', async (req, res) => {
  try {
    const month = parseInt(req.query.month) || 9;
    const year = parseInt(req.query.year) || 2026;

    let poolSql = await sql.connect(sqlServerConfig);
    let result = await poolSql.request()
      .input('Tahun', sql.Int, year)
      .input('Bulan', sql.Int, month)
      .query(`
        SELECT 
            FORMAT(a.Tanggal, 'yyyy-MM-dd') as tanggals,
            a.KD_Faktur as faktur,
            c.Nama AS namasalesman, 
            d.Perusahaan AS namacustomer,  
            g.Nama_Barang,
            SUM(f.qty / NULLIF(g.isi4 * g.isi3 * g.isi2, 0)) AS qtykrt,
            SUM(f.jumlah) AS jumlah
        FROM Fakturb_Header a WITH (NOLOCK)
        INNER JOIN Faktur_Header b WITH (NOLOCK) ON a.KD_Faktur = b.kd_faktur  	
        INNER JOIN MS_Salesman c WITH (NOLOCK)   ON a.kd_salesman = c.kd_salesman           
        INNER JOIN MS_Customer d WITH (NOLOCK)   ON a.kd_customer = d.kd_customer      
        INNER JOIN Ms_Lingkungan e WITH (NOLOCK) ON d.KD_Lingkungan = e.Kd_Lingkungan    
        INNER JOIN FakturB_Detail f WITH (NOLOCK) ON a.KD_Transaksi = f.kd_transaksi     	
        INNER JOIN MS_Barang g WITH (NOLOCK)     ON f.KD_Barang = g.kd_barang  
        WHERE a.tanggal >= DATEFROMPARTS(@Tahun, @Bulan, 1)
          AND a.tanggal < DATEADD(month, 1, DATEFROMPARTS(@Tahun, @Bulan, 1))
        GROUP BY c.Nama, d.Perusahaan, g.Nama_Barang, a.KD_Faktur, a.Tanggal
        ORDER BY namacustomer, namasalesman
      `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error SQL Server Faktur Batal:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data Faktur Batal: ' + err.message });
  }
});

// ==========================================
// 10. ENDPOINT PREVIEW DATA UPLOAD HARI INI
// ==========================================
app.get('/api/today-uploaded-sales', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const countRes = await pool.query(`
      SELECT COUNT(*) FROM data_master_sales WHERE DATE(created_at) = CURRENT_DATE
    `);
    const totalRows = parseInt(countRes.rows[0].count);
    const totalPages = Math.ceil(totalRows / limit);

    const dataRes = await pool.query(`
      SELECT 
        TO_CHAR(dms.tanggal, 'Mon-YY') as month,
        dms.nama_divisi,
        COALESCE(dms.kode_area, 'KTR') as kode_area,
        COALESCE(dms.area, 'KANTOR') as area,
        dms.kode_salesman,
        dms.nama_salesman,
        dms.nama_pasar,
        dms.kode_customer,
        dms.nama_customer,
        dms.kode_barang,
        dms.nama_barang,
        dms.no_transaksi,
        TO_CHAR(dms.tanggal, 'DD/MM/YYYY') as tanggal,
        dms.kode_kunjungan,
        dms.qty_crt,
        dms.dpp_rp
      FROM data_master_sales dms
      WHERE DATE(dms.created_at) = CURRENT_DATE
      ORDER BY dms.id ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json({
      success: true,
      data: dataRes.rows,
      pagination: { totalRows, totalPages, currentPage: page, limit }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 11. LAPORAN HARIAN SALES (GENERATE TABEL AGPC & AGPS)
// ==========================================
const DAILY_KUNJUNGAN = ['K01', 'K02', 'K03', 'K04', 'K05', 'K06'];
const DAILY_MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MEI', 'JUN', 'JUL', 'AGS', 'SEP', 'OKT', 'NOV', 'DES'];
const DAILY_Q_FACTOR = 0.9; // Target Q = total target 100% x 90%

const dailyPad = (n) => String(n).padStart(2, '0');
const dailyNormKode = (v) => String(v || '').trim().toLowerCase();
const dailyNormText = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dailyNormKunj = (v) => {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^K0*(\d+)$/);
  return m ? 'K' + dailyPad(parseInt(m[1], 10)) : s;
};

async function loadDailyTargets(divisi, year, month) {
  const h = await pool.query(
    'SELECT id, total_target FROM annual_targets WHERE year = $1 AND UPPER(divisi) = $2 ORDER BY id DESC LIMIT 1',
    [year, divisi]
  );
  if (h.rows.length === 0) return null;

  const hid = h.rows[0].id;
  const total = parseFloat(h.rows[0].total_target) || 0;

  const mp = await pool.query(
    'SELECT percentage FROM monthly_target_percentages WHERE annual_target_id = $1 AND month = $2',
    [hid, month]
  );
  const monthPct = mp.rows.length ? parseFloat(mp.rows[0].percentage) || 0 : 0;

  const dts = await pool.query('SELECT division_code, percentage FROM division_targets WHERE annual_target_id = $1', [hid]);
  const divPct = { BJB: 0, JJB: 0 };
  dts.rows.forEach(r => {
    const c = String(r.division_code || '').toUpperCase();
    if (c.includes('BJB')) divPct.BJB = parseFloat(r.percentage) || 0;
    else if (c.includes('JJB')) divPct.JJB = parseFloat(r.percentage) || 0;
  });

  const ar = await pool.query(
    'SELECT id, division_code, area_code, area_name, percentage FROM area_targets WHERE annual_target_id = $1 ORDER BY id ASC',
    [hid]
  );
  const ids = ar.rows.map(r => r.id);
  const kr = ids.length
    ? await pool.query('SELECT area_target_id, kunjungan_code, percentage FROM sales_kunjungan_targets WHERE area_target_id = ANY($1::bigint[])', [ids])
    : { rows: [] };

  const areas = ar.rows.map(a => {
    const code = String(a.area_code || '').toUpperCase();
    const dc = String(a.division_code || '').toUpperCase();
    const team = code.includes('BJB') ? 'BJB' : code.includes('JJB') ? 'JJB' : dc.includes('BJB') ? 'BJB' : dc.includes('JJB') ? 'JJB' : '';
    const kPct = {};
    kr.rows.filter(k => String(k.area_target_id) === String(a.id)).forEach(k => {
      kPct[dailyNormKunj(k.kunjungan_code)] = parseFloat(k.percentage) || 0;
    });
    return { team, codeNorm: dailyNormText(a.area_code), nameNorm: dailyNormText(a.area_name), pct: parseFloat(a.percentage) || 0, kPct };
  });

  return { total, monthPct, divPct, areas };
}

app.get('/api/generate-daily-report', async (req, res) => {
  try {
    const now = new Date();
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date
      : `${now.getFullYear()}-${dailyPad(now.getMonth() + 1)}-${dailyPad(now.getDate())}`;
    const [year, month, day] = dateStr.split('-').map(Number);

    const daysInMonth = new Date(year, month, 0).getDate();
    const elapsedPct = (day / daysInMonth) * 100;
    const quarter = Math.ceil(month / 3);
    const monthStart = `${year}-${dailyPad(month)}-01`;

    // OA: 2 bulan sebelum bulan berjalan (contoh bulan 9 -> bulan 7 & 8)
    const prev2 = new Date(year, month - 3, 1);
    const oaStart = `${prev2.getFullYear()}-${dailyPad(prev2.getMonth() + 1)}-01`;

    const warnings = [];

    // 1. Daftar route (hanya AGPC & AGPS)
    const routeRes = await pool.query(
      'SELECT id, nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman FROM list_salesman_route ORDER BY id ASC'
    );
    const routes = [];
    const seen = new Set();
    routeRes.rows.forEach(r => {
      const up = `${r.nama_divisi || ''} ${r.nama_team || ''}`.toUpperCase();
      const divisi = up.includes('AGPC') ? 'AGPC' : up.includes('AGPS') ? 'AGPS' : null;
      if (!divisi) return;
      const tUp = `${r.nama_team || ''} ${r.nama_divisi || ''} ${r.kode_area || ''}`.toUpperCase();
      const team = tUp.includes('BJB') ? 'BJB' : tUp.includes('JJB') ? 'JJB' : '';
      const key = `${divisi}|${dailyNormKode(r.kode_salesman) || dailyNormText(r.nama_salesman)}`;
      if (seen.has(key)) return;
      seen.add(key);
      routes.push({ ...r, divisi, team });
    });

    // 2. Omset & Cust bulan berjalan (tanggal 1 s/d tanggal proses) dari data upload master
    const masterRes = await pool.query(
      `SELECT LOWER(TRIM(kode_salesman)) AS ks,
              UPPER(REGEXP_REPLACE(COALESCE(kode_kunjungan, ''), '[^A-Za-z0-9]', '', 'g')) AS kunj,
              COALESCE(SUM(dpp_rp), 0)::float8 AS omset,
              COUNT(DISTINCT NULLIF(TRIM(kode_customer), '')) AS cust
       FROM data_master_sales
       WHERE tanggal >= $1::date AND tanggal <= $2::date
       GROUP BY 1, 2`,
      [monthStart, dateStr]
    );
    const masterMap = new Map();
    masterRes.rows.forEach(r => {
      const key = `${r.ks}|${dailyNormKunj(r.kunj)}`;
      const cur = masterMap.get(key) || { omset: 0, cust: 0 };
      cur.omset += parseFloat(r.omset) || 0;
      cur.cust += parseInt(r.cust) || 0;
      masterMap.set(key, cur);
    });
    if (masterRes.rows.length === 0) {
      warnings.push(`Belum ada data Upload Master untuk tanggal 1 s/d ${day} bulan ini.`);
    }

    // 3. OA: distinct kode_customer dari History Transaksi 2 bulan terakhir
    const oaRes = await pool.query(
      `SELECT LOWER(TRIM(kode_salesman)) AS ks,
              UPPER(REGEXP_REPLACE(COALESCE(kode_kunjungan, ''), '[^A-Za-z0-9]', '', 'g')) AS kunj,
              COUNT(DISTINCT NULLIF(TRIM(kode_customer), '')) AS oa
       FROM data_history_sales
       WHERE tanggal >= $1::date AND tanggal < $2::date
       GROUP BY 1, 2`,
      [oaStart, monthStart]
    );
    const oaMap = new Map();
    oaRes.rows.forEach(r => {
      const key = `${r.ks}|${dailyNormKunj(r.kunj)}`;
      oaMap.set(key, (oaMap.get(key) || 0) + (parseInt(r.oa) || 0));
    });

    // 4. Target tahunan AGPC & AGPS
    const targets = {
      AGPC: await loadDailyTargets('AGPC', year, month),
      AGPS: await loadDailyTargets('AGPS', year, month)
    };
    ['AGPC', 'AGPS'].forEach(dv => {
      if (!targets[dv]) warnings.push(`Target Tahunan ${dv} ${year} belum tersimpan di database (Target = 0).`);
    });

    // 5. Susun tabel per salesman
    const unmatched = [];
    const blocks = routes.map(rt => {
      const t = targets[rt.divisi];
      let area = null;
      if (t) {
        const kc = dailyNormText(rt.kode_area);
        const nn = dailyNormText(rt.nama_area);
        const okTeam = a => !rt.team || !a.team || a.team === rt.team;
        area = t.areas.find(a => kc && a.codeNorm === kc && okTeam(a))
            || t.areas.find(a => nn && a.nameNorm === nn && okTeam(a))
            || null;
        if (!area) unmatched.push(`${rt.divisi} - ${rt.nama_salesman} (${rt.nama_area || rt.kode_area || '-'})`);
      }

      const ks = dailyNormKode(rt.kode_salesman);
      const teamKey = rt.team || (area && area.team) || '';
      const rows = DAILY_KUNJUNGAN.map((k, i) => {
        let target = 0;
        if (t && area && teamKey) {
          target = t.total * (t.monthPct / 100) * ((t.divPct[teamKey] || 0) / 100) * (area.pct / 100) * ((area.kPct[k] || 0) / 100);
        }
        const m = masterMap.get(`${ks}|${k}`) || { omset: 0, cust: 0 };
        const oa = oaMap.get(`${ks}|${k}`) || 0;
        const sisa = m.omset - target;
        const pct = target > 0 ? (m.omset / target) * 100 : 0;
        return { kunjungan: `K-${dailyPad(i + 1)}`, target, oa, cust: m.cust, omset: m.omset, sisa, pct };
      });

      const sum = (f) => rows.reduce((a, r) => a + r[f], 0);
      const total = { target: sum('target'), oa: sum('oa'), cust: sum('cust'), omset: sum('omset') };
      total.sisa = total.omset - total.target;
      total.pct = total.target > 0 ? (total.omset / total.target) * 100 : 0;

      const qTarget = total.target * DAILY_Q_FACTOR;
      const q = {
        label: `TARGET Q${quarter}`,
        target: qTarget,
        omset: total.omset,
        sisa: total.omset - qTarget,
        pct: qTarget > 0 ? (total.omset / qTarget) * 100 : 0
      };

      return {
        divisi: rt.divisi,
        team: teamKey,
        kode_salesman: rt.kode_salesman,
        nama_salesman: rt.nama_salesman,
        kode_area: rt.kode_area,
        nama_area: rt.nama_area,
        target_matched: !!area,
        rows, total, q
      };
    });

    if (unmatched.length > 0) {
      warnings.push(`${unmatched.length} route belum cocok dengan Target Tahunan (cek Kode Area / Nama Area): ${unmatched.slice(0, 8).join('; ')}${unmatched.length > 8 ? ' ...' : ''}`);
    }
    if (blocks.length === 0) {
      warnings.push('Tidak ada data route divisi AGPC / AGPS di menu List Sales Route.');
    }

    res.json({
      success: true,
      meta: {
        date: dateStr,
        dateLabel: `${dailyPad(day)}/${dailyPad(month)}/${year}`,
        day, daysInMonth, elapsedPct, quarter,
        monthAbbr: DAILY_MONTH_ABBR[month - 1],
        omsetLabel: `OMSET ${DAILY_MONTH_ABBR[month - 1]} (1-${day})`
      },
      warnings,
      blocks
    });
  } catch (err) {
    console.error('Error Generate Daily Report:', err);
    res.status(500).json({ success: false, message: 'Gagal generate laporan harian: ' + err.message });
  }
});

app.post('/api/save-daily-report', async (req, res) => {
  const client = await pool.connect();
  try {
    const { report_date, blocks } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(report_date || '') || !Array.isArray(blocks) || blocks.length === 0) {
      return res.status(400).json({ success: false, message: 'Data laporan tidak valid / kosong.' });
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_sales_reports (
        id SERIAL PRIMARY KEY,
        report_date DATE NOT NULL,
        divisi VARCHAR(20),
        team VARCHAR(20),
        kode_salesman VARCHAR(100),
        nama_salesman VARCHAR(200),
        nama_area VARCHAR(200),
        quarter VARCHAR(10),
        report_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query('BEGIN');
    await client.query('DELETE FROM daily_sales_reports WHERE report_date = $1::date', [report_date]);

    for (const b of blocks) {
      await client.query(
        `INSERT INTO daily_sales_reports (report_date, divisi, team, kode_salesman, nama_salesman, nama_area, quarter, report_data)
         VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [report_date, b.divisi, b.team, b.kode_salesman, b.nama_salesman, b.nama_area, b.q ? b.q.label : null, JSON.stringify(b)]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Laporan harian ${report_date} (${blocks.length} tabel) berhasil disimpan ke database!` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error Save Daily Report:', err);
    res.status(500).json({ success: false, message: 'Gagal menyimpan laporan harian: ' + err.message });
  } finally {
    client.release();
  }
});


app.listen(3000, async () => {
  console.log('🚀 Server Backend berjalan pada port 3000');
  await initDatabase();
});