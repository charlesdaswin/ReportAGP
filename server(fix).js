const express = require('express');
const cors = require('cors');
const { pool, initDatabase } = require('./db');
const multer = require('multer');
const XLSX = require('xlsx');
const sql = require('mssql');
const os = require('os');
const path = require('path');

const app = express();
app.use(cors());
// Batas dinaikkan karena Target Product bisa mengirim ribuan baris sekaligus
app.use(express.json({ limit: '50mb' }));

// =========================================================================
// MELAYANI HALAMAN WEB (supaya bisa dibuka dari komputer lain satu jaringan)
// Komputer lain cukup membuka http://<IP-server>:3000
// File sumber (server.js, db.js, konfigurasi) TIDAK ikut dibagikan.
// =========================================================================
const FILE_TERLARANG = [
  'server.js', 'db.js', 'package.json', 'package-lock.json',
  'update-history-from-excel.js', 'set-api-url.js'
];
const EKSTENSI_TERLARANG = ['.env', '.bak', '.log', '.sql', '.md', '.zip', '.rar', '.7z'];

app.use((req, res, next) => {
  // Biarkan semua endpoint API lewat apa adanya
  if (req.path.startsWith('/api/')) return next();

  // URL bisa berisi % yang tidak sah -> jangan sampai membuat server error
  let bersih;
  try {
    bersih = decodeURIComponent(req.path);
  } catch (e) {
    return res.status(400).send('400 - Alamat tidak sah.');
  }
  bersih = bersih.replace(/\\/g, '/').toLowerCase();
  const namaFile = bersih.split('/').filter(Boolean).pop() || '';

  if (bersih.includes('..') ||
      bersih.includes('/node_modules') ||
      bersih.split('/').some(bagian => bagian.startsWith('.')) ||
      FILE_TERLARANG.includes(namaFile) ||
      EKSTENSI_TERLARANG.some(e => namaFile.endsWith(e))) {
    return res.status(403).send('403 - File ini tidak dibagikan.');
  }
  next();
});

app.use(express.static(path.join(__dirname), { index: 'index.html', extensions: ['html'] }));

// Tanggal hari ini menurut jam komputer (WIB), bukan UTC.
// Kalau memakai toISOString(), jam 00:00-07:00 WIB akan terbaca sebagai
// tanggal kemarin, sehingga periode berlaku bisa meleset satu hari.
function tglHariIni() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

// Label bulan Bahasa Indonesia untuk kolom "Month" (contoh: Ags-26, Sep-26)
const sqlLabelBulan = (kolomTanggal) => `(
  CASE EXTRACT(MONTH FROM ${kolomTanggal})::int
    WHEN 1 THEN 'Jan' WHEN 2 THEN 'Feb' WHEN 3 THEN 'Mar' WHEN 4 THEN 'Apr'
    WHEN 5 THEN 'Mei' WHEN 6 THEN 'Jun' WHEN 7 THEN 'Jul' WHEN 8 THEN 'Ags'
    WHEN 9 THEN 'Sep' WHEN 10 THEN 'Okt' WHEN 11 THEN 'Nov' ELSE 'Des'
  END || '-' || TO_CHAR(${kolomTanggal}, 'YY')
)`;

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
      `SELECT id, nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman,
              TO_CHAR(berlaku_mulai, 'YYYY-MM-DD') AS berlaku_mulai,
              TO_CHAR(berlaku_sampai, 'YYYY-MM-DD') AS berlaku_sampai,
              COALESCE(aktif, TRUE) AS aktif
       FROM list_salesman_route
       ORDER BY kode_area ASC, berlaku_mulai DESC NULLS LAST, id ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Error Fetch Sales Routes:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data rute salesman: ' + err.message });
  }
});

app.put('/api/sales-routes/:id', async (req, res) => {
  const { id } = req.params;
  const {
    nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman,
    berlaku_mulai, berlaku_sampai, aktif
  } = req.body;

  try {
    const tgl = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
    // Kalau ditandai nonaktif tapi tanggal selesai belum diisi, tutup per hari ini
    // supaya laporan periode sebelumnya tetap memakai salesman ini.
    let sampai = tgl(berlaku_sampai);
    if (aktif === false && !sampai) sampai = tglHariIni();

    const result = await pool.query(
      `UPDATE list_salesman_route
       SET nama_divisi = $1, nama_team = $2, kode_area = $3, nama_area = $4,
           kode_salesman = $5, nama_salesman = $6,
           berlaku_mulai = $7::date, berlaku_sampai = $8::date, aktif = $9
       WHERE id = $10 RETURNING *`,
      [nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman,
       tgl(berlaku_mulai), sampai, aktif !== false, id]
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

// Ganti salesman pada sebuah route: penugasan lama ditutup, penugasan baru dibuat.
// Riwayat tetap utuh sehingga laporan bulan lalu tidak berubah.
// =========================================================================
// PERBAIKI URUTAN ID (SEQUENCE)
// -------------------------------------------------------------------------
// Kolom id memakai SERIAL, nomornya diambil dari sebuah "sequence".
// Kalau ada baris yang di-INSERT manual dengan id ditentukan sendiri
// (misal lewat pgAdmin), sequence-nya TIDAK ikut maju. Akibatnya insert
// berikutnya memakai nomor yang sudah dipakai dan muncul error:
//     duplicate key value violates unique constraint "..._pkey"
// Fungsi ini menyetel ulang sequence ke id terbesar yang ada.
// =========================================================================
async function perbaikiSequence(client, tabel) {
  // Nama tabel selalu berasal dari daftar internal, tapi tetap diperiksa
  // karena ikut disisipkan langsung ke dalam query.
  if (!/^[a-z0-9_]+$/i.test(String(tabel || ''))) return false;
  try {
    // Ambil nama sequence-nya dulu secara terpisah. Kalau pg_get_serial_sequence
    // dipakai di dalam WHERE, PostgreSQL bisa menjalankannya lebih dulu untuk
    // tabel yang seharusnya sudah tersaring, lalu error.
    const q = await client.query(`SELECT pg_get_serial_sequence($1, 'id') AS seq`, [tabel]);
    const seq = q.rows[0] && q.rows[0].seq;
    if (!seq) return false;   // kolom id tabel ini bukan SERIAL

    await client.query(
      `SELECT setval($1,
         COALESCE((SELECT MAX(id) FROM ${tabel}), 1),
         (SELECT MAX(id) IS NOT NULL FROM ${tabel}))`,
      [seq]
    );
    return true;
  } catch (e) {
    console.error(`[SEQUENCE] Gagal memperbaiki ${tabel}:`, e.message);
    return false;
  }
}

// Daftar tabel milik aplikasi yang kolom id-nya SERIAL.
// Dicari lewat pg_depend (sequence yang dimiliki sebuah kolom), bukan
// information_schema, supaya tabel sistem tidak pernah ikut tersentuh.
async function daftarTabelSerial(client) {
  const r = await client.query(
    `SELECT t.relname AS tabel
     FROM pg_depend d
     JOIN pg_class s     ON s.oid = d.objid     AND s.relkind = 'S'
     JOIN pg_class t     ON t.oid = d.refobjid  AND t.relkind = 'r'
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
     WHERE d.classid = 'pg_class'::regclass
       AND d.refclassid = 'pg_class'::regclass
       AND d.deptype IN ('a', 'i')
       AND n.nspname = 'public'
       AND a.attname = 'id'
     ORDER BY t.relname`
  );
  return r.rows.map(x => x.tabel);
}

// Dijalankan sekali saat server start, untuk semua tabel yang punya kolom id
async function perbaikiSemuaSequence() {
  const client = await pool.connect();
  try {
    const tabel = await daftarTabelSerial(client);

    let diperbaiki = 0;
    for (const nama of tabel) {
      if (await perbaikiSequence(client, nama)) diperbaiki++;
    }
    console.log(`🔢 Urutan id (sequence) diperiksa: ${diperbaiki} tabel.`);
  } catch (err) {
    console.error('⚠️  Gagal memeriksa sequence:', err.message);
  } finally {
    client.release();
  }
}

// Bisa dijalankan kapan saja dari browser kalau muncul error "duplicate key"
app.post('/api/perbaiki-sequence', async (req, res) => {
  const client = await pool.connect();
  try {
    const tabel = String(req.query.tabel || req.body?.tabel || '').trim();
    if (tabel) {
      if (!/^[a-z0-9_]+$/i.test(tabel)) {
        return res.status(400).json({ success: false, message: 'Nama tabel tidak valid.' });
      }
      const ok = await perbaikiSequence(client, tabel);
      return res.json({
        success: ok,
        message: ok ? `Urutan id tabel ${tabel} sudah diperbaiki.` : `Gagal memperbaiki ${tabel}.`
      });
    }

    const semua = await daftarTabelSerial(client);
    const hasil = [];
    for (const nama of semua) {
      if (await perbaikiSequence(client, nama)) hasil.push(nama);
    }
    res.json({ success: true, message: `Urutan id diperbaiki untuk ${hasil.length} tabel.`, tabel: hasil });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// =========================================================================
// PINDAH RUTE: satu salesman pindah, dua rute berubah sekaligus
// -------------------------------------------------------------------------
// Contoh: ALI AKBAR (2P02-0034) di AGPS : BEKASI pindah ke AGPS : TSEL-SUB.
//   - Di BEKASI    -> ditutup, lalu diisi salesman pengganti (diketik user,
//                     karena hanya user yang tahu kode salesman lamanya)
//   - Di TSEL-SUB  -> penghuni lama (kalau ada) ditutup, lalu diisi ALI AKBAR
//                     dengan kode salesman yang sama, 2P02-0034
// Semuanya dalam satu transaksi dan memakai tanggal yang sama, supaya tidak
// ada hari yang bolong atau dobel. Baris lama tidak dihapus, hanya ditutup,
// jadi laporan bulan-bulan sebelumnya tidak ikut berubah.
// =========================================================================
app.post('/api/sales-routes/:id/pindah-rute', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      kode_area_tujuan,
      kode_pengganti, nama_pengganti,
      kosongkan_rute_asal,
      mulai_tanggal
    } = req.body || {};

    if (!/^\d{4}-\d{2}-\d{2}$/.test(mulai_tanggal || '')) {
      return res.status(400).json({ success: false, message: 'Tanggal mulai (YYYY-MM-DD) wajib diisi.' });
    }
    if (!String(kode_area_tujuan || '').trim()) {
      return res.status(400).json({ success: false, message: 'Rute tujuan wajib dipilih.' });
    }
    const kosongkan = kosongkan_rute_asal === true;
    if (!kosongkan && !String(nama_pengganti || '').trim()) {
      return res.status(400).json({
        success: false,
        message: 'Nama salesman pengganti untuk rute asal wajib diisi. ' +
                 'Kalau memang belum ada penggantinya, centang "kosongkan dulu".'
      });
    }
    if (!kosongkan && !String(kode_pengganti || '').trim()) {
      return res.status(400).json({
        success: false,
        message: 'Kode salesman pengganti wajib diisi. Pada Pindah Rute, kode salesman ikut pindah ' +
                 'bersama orangnya, jadi rute asal harus diisi kode salesman yang berbeda.'
      });
    }

    const asalQ = await client.query('SELECT * FROM list_salesman_route WHERE id = $1', [id]);
    if (asalQ.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data route asal tidak ditemukan.' });
    }
    const asal = asalQ.rows[0];

    const kodeGanti = String(kode_pengganti || '').trim();
    const areaTujuan = String(kode_area_tujuan).trim();
    if (dailyNormText(asal.kode_area) === dailyNormText(areaTujuan)) {
      return res.status(400).json({ success: false, message: 'Rute tujuan sama dengan rute asal.' });
    }

    // Kode salesman ikut pindah bersama orangnya. Kalau rute asal diisi kode
    // yang sama, satu kode akan aktif di dua area sekaligus dan Laporan
    // Harian Sales jadi bingung menentukan areanya.
    if (!kosongkan && kodeGanti.toUpperCase() === String(asal.kode_salesman || '').trim().toUpperCase()) {
      return res.status(400).json({
        success: false,
        message: `Kode pengganti tidak boleh sama dengan ${asal.kode_salesman} ` +
                 `(kode ${asal.nama_salesman} yang sedang pindah). Kode itu ikut pindah ke ${areaTujuan}, ` +
                 `jadi rute asal harus diisi kode salesman lain.`
      });
    }

    // Kalau kode pengganti ternyata sedang aktif di rute lain, itu hanya
    // DIBERITAHUKAN, bukan ditolak. Sebagian kode memang sengaja menangani
    // lebih dari satu rute (AGP N, KTR, TELE).
    const peringatan = [];
    if (!kosongkan) {
      const dipakai = await client.query(
        `SELECT kode_area, nama_area, nama_salesman FROM list_salesman_route
         WHERE UPPER(TRIM(COALESCE(kode_salesman, ''))) = UPPER($1)
           AND berlaku_sampai IS NULL AND aktif IS NOT FALSE
           AND UPPER(TRIM(kode_area)) <> UPPER(TRIM($2))`,
        [kodeGanti, asal.kode_area]
      );
      if (dipakai.rows.length > 0) {
        peringatan.push(
          `Kode ${kodeGanti} juga masih aktif di ` +
          dipakai.rows.map(d => `${d.nama_area || d.kode_area}`).join(', ') +
          `. Pastikan itu memang disengaja.`
        );
      }
    }

    // Keterangan rute tujuan diambil dari baris terbaru area tersebut
    const tujuanQ = await client.query(
      `SELECT * FROM list_salesman_route
       WHERE UPPER(TRIM(kode_area)) = UPPER(TRIM($1))
       ORDER BY berlaku_mulai DESC NULLS LAST, id DESC`,
      [areaTujuan]
    );
    if (tujuanQ.rows.length === 0) {
      return res.status(404).json({ success: false, message: `Rute tujuan "${areaTujuan}" tidak ada di List Sales Route.` });
    }
    const tujuan = tujuanQ.rows[0];

    // Penghuni rute tujuan yang masih berlaku pada tanggal pindah
    const penghuni = tujuanQ.rows.filter(r =>
      (!r.berlaku_sampai || String(r.berlaku_sampai).slice(0, 10) >= mulai_tanggal) && r.aktif !== false);

    // Rapikan urutan id dulu, supaya tidak bentrok dengan baris yang pernah
    // di-INSERT manual lewat pgAdmin
    await perbaikiSequence(client, 'list_salesman_route');

    await client.query('BEGIN');

    const tutup = (idRow) => client.query(
      `UPDATE list_salesman_route
       SET berlaku_sampai = ($1::date - INTERVAL '1 day')::date, aktif = FALSE
       WHERE id = $2`,
      [mulai_tanggal, idRow]
    );

    const buka = (contoh, kodeSales, namaSales) => client.query(
      `INSERT INTO list_salesman_route
         (nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman, berlaku_mulai, aktif)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, TRUE) RETURNING *`,
      [contoh.nama_divisi, contoh.nama_team, contoh.kode_area, contoh.nama_area,
       kodeSales, namaSales, mulai_tanggal]
    );

    const langkah = [];

    // 1. Rute ASAL: tutup penugasan salesman yang pindah
    await tutup(asal.id);
    langkah.push(`${asal.nama_salesman} (${asal.kode_salesman}) ditutup dari ${asal.nama_area || asal.kode_area}`);

    // 2. Rute ASAL: isi pengganti, kecuali diminta dikosongkan
    let barisPengganti = null;
    if (!kosongkan) {
      barisPengganti = (await buka(asal, kodeGanti, String(nama_pengganti).trim())).rows[0];
      langkah.push(`${asal.nama_area || asal.kode_area} diisi ${barisPengganti.nama_salesman} (${barisPengganti.kode_salesman})`);
    } else {
      langkah.push(`${asal.nama_area || asal.kode_area} dibiarkan kosong`);
    }

    // 3. Rute TUJUAN: tutup penghuni lama kalau ada
    for (const p of penghuni) {
      await tutup(p.id);
      langkah.push(`${p.nama_salesman} (${p.kode_salesman}) ditutup dari ${p.nama_area || p.kode_area}`);
    }

    // 4. Rute TUJUAN: isi salesman yang pindah, kode salesman ikut pindah
    const barisPindah = (await buka(tujuan, asal.kode_salesman, asal.nama_salesman)).rows[0];
    langkah.push(`${tujuan.nama_area || tujuan.kode_area} diisi ${asal.nama_salesman} (${asal.kode_salesman})`);

    // Pengaman: setelah pindah, satu area tidak boleh punya 2 penugasan aktif
    const bentrok = await client.query(
      `SELECT UPPER(TRIM(kode_area)) AS area, COUNT(*)::int AS n
       FROM list_salesman_route
       WHERE berlaku_sampai IS NULL AND aktif IS NOT FALSE
         AND UPPER(TRIM(kode_area)) IN (UPPER(TRIM($1)), UPPER(TRIM($2)))
       GROUP BY 1 HAVING COUNT(*) > 1`,
      [asal.kode_area, tujuan.kode_area]
    );
    // Hanya memeriksa kode salesman YANG PINDAH. Kalau kodenya sampai aktif
    // di dua rute, berarti pemindahannya salah. Kode lain di tabel tidak
    // ikut diperiksa, karena ada kode yang memang menangani banyak rute.
    const kodePindahGanda = await client.query(
      `SELECT COUNT(DISTINCT UPPER(TRIM(kode_area)))::int AS n,
              STRING_AGG(DISTINCT kode_area, ', ') AS area
       FROM list_salesman_route
       WHERE berlaku_sampai IS NULL AND aktif IS NOT FALSE
         AND UPPER(TRIM(COALESCE(kode_salesman, ''))) = UPPER(TRIM($1))`,
      [asal.kode_salesman || '']
    );
    if ((kodePindahGanda.rows[0] || {}).n > 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Dibatalkan: setelah pindah, kode ${asal.kode_salesman} akan aktif di ` +
                 `${kodePindahGanda.rows[0].n} rute (${kodePindahGanda.rows[0].area}). ` +
                 `Kode salesman yang pindah hanya boleh aktif di rute tujuan.`
      });
    }

    if (bentrok.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'Dibatalkan: setelah pindah, area ' +
                 bentrok.rows.map(b => `${b.area} punya ${b.n} penugasan aktif`).join(', ') +
                 '. Rapikan dulu penugasan ganda di area tersebut lewat tombol Edit.'
      });
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Pindah rute berhasil, berlaku mulai ${mulai_tanggal}. ` + langkah.join('; ') + '.' +
               (peringatan.length ? ' CATATAN: ' + peringatan.join(' ') : ''),
      langkah,
      peringatan,
      mulai_tanggal,
      rute_asal: { kode_area: asal.kode_area, nama_area: asal.nama_area, pengganti: barisPengganti },
      rute_tujuan: { kode_area: tujuan.kode_area, nama_area: tujuan.nama_area, baris: barisPindah },
      penghuni_lama_ditutup: penghuni.map(p => `${p.nama_salesman} (${p.kode_salesman})`)
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error Pindah Rute:', err);
    res.status(500).json({ success: false, message: 'Gagal memindahkan rute: ' + err.message });
  } finally {
    client.release();
  }
});

// Daftar area untuk pilihan rute tujuan, lengkap dengan penghuni saat ini
app.get('/api/sales-routes-area', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT ON (UPPER(TRIM(kode_area)))
              kode_area, nama_area, nama_divisi, nama_team,
              kode_salesman, nama_salesman,
              TO_CHAR(berlaku_mulai, 'YYYY-MM-DD') AS berlaku_mulai,
              TO_CHAR(berlaku_sampai, 'YYYY-MM-DD') AS berlaku_sampai,
              (berlaku_sampai IS NULL AND aktif IS NOT FALSE) AS terisi
       FROM list_salesman_route
       WHERE kode_area IS NOT NULL AND TRIM(kode_area) <> ''
       ORDER BY UPPER(TRIM(kode_area)),
                (berlaku_sampai IS NULL AND aktif IS NOT FALSE) DESC,
                berlaku_mulai DESC NULLS LAST, id DESC`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/sales-routes/:id/ganti-salesman', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { kode_salesman_baru, nama_salesman_baru, mulai_tanggal } = req.body || {};

    if (!nama_salesman_baru || !/^\d{4}-\d{2}-\d{2}$/.test(mulai_tanggal || '')) {
      return res.status(400).json({ success: false, message: 'Nama salesman baru dan tanggal mulai (YYYY-MM-DD) wajib diisi.' });
    }

    const lama = await client.query('SELECT * FROM list_salesman_route WHERE id = $1', [id]);
    if (lama.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data route tidak ditemukan.' });
    }
    const r = lama.rows[0];

    await perbaikiSequence(client, 'list_salesman_route');

    await client.query('BEGIN');

    // Tutup penugasan lama sehari sebelum penugasan baru dimulai
    await client.query(
      `UPDATE list_salesman_route
       SET berlaku_sampai = ($1::date - INTERVAL '1 day')::date, aktif = FALSE
       WHERE id = $2`,
      [mulai_tanggal, id]
    );

    const baru = await client.query(
      `INSERT INTO list_salesman_route
         (nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman, berlaku_mulai, aktif)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, TRUE) RETURNING *`,
      [r.nama_divisi, r.nama_team, r.kode_area, r.nama_area,
       kode_salesman_baru || r.kode_salesman, nama_salesman_baru, mulai_tanggal]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Route ${r.nama_area || r.kode_area}: ${r.nama_salesman} berlaku sampai sehari sebelum ${mulai_tanggal}, ` +
               `dilanjutkan oleh ${nama_salesman_baru} mulai ${mulai_tanggal}.`,
      data: baru.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error Ganti Salesman:', err);
    res.status(500).json({ success: false, message: 'Gagal mengganti salesman: ' + err.message });
  } finally {
    client.release();
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
// Kolom yang bisa dicari pada History Transaksi
const KOLOM_CARI_HISTORY = {
  kode_salesman:  'dhs.kode_salesman',
  nama_salesman:  'dhs.nama_salesman',
  kode_customer:  'dhs.kode_customer',
  nama_customer:  'dhs.nama_customer',
  kode_barang:    'dhs.kode_barang',
  nama_barang:    'dhs.nama_barang',
  no_transaksi:   'dhs.no_transaksi',
  kode_area:      'dhs.kode_area',
  area:           'dhs.area',
  nama_pasar:     'dhs.nama_pasar',
  nama_divisi:    'dhs.nama_divisi',
  kode_kunjungan: 'dhs.kode_kunjungan'
};

app.get('/api/history-transaksi', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    const kataKunci = String(req.query.search || '').trim();
    const kolomDipilih = String(req.query.field || 'all');
    const dari = String(req.query.dari || '');
    const sampai = String(req.query.sampai || '');

    // Kalau user memilih satu kolom, cari di kolom itu saja. Kalau 'all', cari di semua kolom.
    const kolomCari = (kolomDipilih !== 'all' && KOLOM_CARI_HISTORY[kolomDipilih])
      ? [KOLOM_CARI_HISTORY[kolomDipilih]]
      : Object.values(KOLOM_CARI_HISTORY);

    const params = [];
    const kondisi = [];

    // Setiap kata dipisah spasi harus cocok (AND), tapi boleh di kolom mana pun (OR).
    // Contoh: "bobby bogor" -> baris yang mengandung bobby DAN bogor.
    if (kataKunci) {
      kataKunci.split(/\s+/).filter(Boolean).forEach(kata => {
        params.push(`%${kata}%`);
        const i = params.length;
        kondisi.push('(' + kolomCari.map(k => `COALESCE(${k}, '') ILIKE $${i}`).join(' OR ') + ')');
      });
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(dari)) { params.push(dari); kondisi.push(`dhs.tanggal >= $${params.length}::date`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(sampai)) { params.push(sampai); kondisi.push(`dhs.tanggal <= $${params.length}::date`); }

    const whereClause = kondisi.length ? 'WHERE ' + kondisi.join(' AND ') : '';

    // Hitung total memakai parameter yang SAMA dengan query data (ini yang dulu salah)
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(dhs.dpp_rp), 0)::float8 AS total_dpp
       FROM data_history_sales dhs ${whereClause}`,
      params
    );
    const totalRows = countRes.rows[0].total;
    const totalDpp = countRes.rows[0].total_dpp;
    const totalPages = Math.max(1, Math.ceil(totalRows / limit));

    const dataRes = await pool.query(
      `SELECT
        COALESCE(NULLIF(TRIM(dhs.month), ''), ${sqlLabelBulan('dhs.tanggal')}) AS month,
        dhs.nama_divisi,
        COALESCE(dhs.kode_area, 'KTR') AS kode_area,
        COALESCE(dhs.area, 'KANTOR') AS area,
        dhs.kode_salesman,
        dhs.nama_salesman,
        dhs.nama_pasar,
        dhs.kode_customer,
        dhs.nama_customer,
        dhs.kode_barang,
        dhs.nama_barang,
        dhs.no_transaksi,
        TO_CHAR(dhs.tanggal, 'DD/MM/YYYY') AS tanggal,
        dhs.kode_kunjungan,
        dhs.qty_crt,
        dhs.dpp_rp
      FROM data_history_sales dhs
      ${whereClause}
      ORDER BY dhs.tanggal DESC, dhs.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: dataRes.rows,
      totalDpp,
      filter: { search: kataKunci, field: kolomDipilih, dari, sampai },
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
// Cari nama kolom relasi (foreign key) di agpn_province_targets secara otomatis,
// karena penamaannya bisa berbeda antar database.
async function detectAgpnProvinceColumns(db) {
  const info = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agpn_province_targets'
    ORDER BY ordinal_position
  `);
  const cols = info.rows.map(r => r.column_name);

  if (cols.length === 0) {
    throw new Error('Tabel agpn_province_targets tidak ditemukan pada schema public. Cek nama tabel di database.');
  }

  const kandidat = [
    'agpn_annual_target_id', 'annual_target_id', 'agpn_target_id',
    'target_agpn_header_id', 'agpn_header_id', 'header_id', 'target_id'
  ];
  let fk = kandidat.find(c => cols.includes(c));
  if (!fk) fk = cols.find(c => c !== 'id' && c.toLowerCase().endsWith('_id'));

  if (!fk) {
    throw new Error('Tidak ada kolom relasi (berakhiran _id) di agpn_province_targets. Kolom yang tersedia: ' + cols.join(', '));
  }

  return { fk, cols, monthCols: detectAgpnMonthColumns(cols) };
}

// Cari nama kolom Januari..Desember di agpn_province_targets.
// Mendukung m01..m12, m1..m12, bulan_01, month_1, januari.., jan.., january..
const BULAN_PANJANG_ID = ['januari','februari','maret','april','mei','juni','juli','agustus','september','oktober','november','desember'];
const BULAN_PENDEK_ID  = ['jan','feb','mar','apr','mei','jun','jul','ags','sep','okt','nov','des'];
const BULAN_PANJANG_EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function detectAgpnMonthColumns(cols) {
  const peta = new Map(cols.map(c => [c.toLowerCase(), c]));
  const hasil = [];
  for (let m = 1; m <= 12; m++) {
    const p2 = String(m).padStart(2, '0');
    const kandidat = [
      `m${p2}`, `m${m}`,
      `bulan_${p2}`, `bulan${p2}`, `bulan_${m}`, `bulan${m}`,
      `month_${p2}`, `month${p2}`, `month_${m}`, `month${m}`,
      `target_${p2}`, `target_m${p2}`, `target_bulan_${p2}`,
      BULAN_PANJANG_ID[m - 1], BULAN_PENDEK_ID[m - 1], BULAN_PANJANG_EN[m - 1],
      `agu`, // alternatif Agustus
    ];
    let ketemu = null;
    for (const k of kandidat) {
      if (m === 8 && k === 'agu' && !peta.has('agu')) continue;
      if (k !== 'agu' || m === 8) {
        const c = peta.get(k);
        if (c) { ketemu = c; break; }
      }
    }
    hasil.push(ketemu || null);
  }
  return hasil;
}

// Diagnosa: lihat kolom asli tabel AGP N
app.get('/api/debug-agpn-columns', async (req, res) => {
  try {
    const info = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('agpn_annual_targets', 'agpn_province_targets')
      ORDER BY table_name, ordinal_position
    `);
    let fk = null, bulan = null, pesan = null;
    try {
      const d = await detectAgpnProvinceColumns(pool);
      fk = d.fk; bulan = d.monthCols;
    } catch (e) { pesan = e.message; }
    res.json({
      success: true,
      kolom_relasi_terdeteksi: fk,
      kolom_bulanan_terdeteksi: bulan,
      catatan: pesan,
      kolom: info.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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

    // Ambil Detail Provinsi (nama kolom relasi & bulanan dideteksi otomatis)
    const { fk: fkProvinsi, monthCols: monthColsGet } = await detectAgpnProvinceColumns(pool);
    const detailRes = await pool.query(
      `SELECT * FROM agpn_province_targets WHERE "${fkProvinsi}" = $1 ORDER BY id ASC`,
      [header.id]
    );

    const formattedDetails = detailRes.rows.map(row => {
      const mArr = [];
      for (let m = 1; m <= 12; m++) {
        const kolom = monthColsGet[m - 1];
        const mKey2 = `m${String(m).padStart(2, '0')}`;
        let raw = 0;
        if (kolom && row[kolom] !== undefined && row[kolom] !== null) raw = row[kolom];
        else if (row[mKey2] !== undefined && row[mKey2] !== null) raw = row[mKey2];
        else if (row[`m${m}`] !== undefined && row[`m${m}`] !== null) raw = row[`m${m}`];
        const valM = parseFloat(raw);
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

    // Deteksi kolom tabel: nama kolom relasi + nama kolom bulanan
    const { fk: fkCol, cols: dbColumns, monthCols } = await detectAgpnProvinceColumns(client);
    console.log(`[AGPN] Kolom relasi: ${fkCol} | Kolom bulanan: ${monthCols.filter(Boolean).join(', ') || '(tidak ada)'}`);

    if (monthCols.every(c => !c)) {
      throw new Error(
        'Tabel agpn_province_targets tidak punya kolom bulanan (m01..m12 atau sejenisnya), ' +
        'jadi nilai per bulan tidak bisa disimpan. Kolom yang tersedia: ' + dbColumns.join(', ')
      );
    }

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

      // Kolom lama monthly_nominal (kalau ada) diisi rata-rata per bulan,
      // supaya tidak melanggar constraint NOT NULL dan tetap punya arti.
      if (dbColumns.includes('monthly_nominal') && !insertCols.includes('monthly_nominal')) {
        insertCols.push('monthly_nominal');
        insertVals.push(Math.round((parseFloat(item.annual_target) || 0) / 12));
      }

      // Nilai per bulan: nama kolom di DB diambil dari hasil deteksi
      monthCols.forEach((kolom, idx) => {
        if (!kolom) return;
        const mKey = `m${String(idx + 1).padStart(2, '0')}`;
        const nilai = item[mKey] !== undefined ? item[mKey] : (item[`m${idx + 1}`] || 0);
        insertCols.push(kolom);
        insertVals.push(parseFloat(nilai) || 0);
      });

      const placeholders = insertVals.map((_, idx) => `$${idx + 1}`).join(', ');
      const kolomQuoted = insertCols.map(c => `"${c}"`).join(', ');
      await client.query(`INSERT INTO agpn_province_targets (${kolomQuoted}) VALUES (${placeholders})`, insertVals);
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
// Parser file Excel Master Sales (dipakai endpoint upload dan endpoint update kode kunjungan)
async function parseMasterExcelFiles(files, routeMap) {
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

    // --- Bentuk A: file tabel rapi berheader (Nama Divisi | Kode Salesman | ... | DPP (Rp)) ---
    const ALIAS_KOLOM = {
      namadivisi: 'nama_divisi',       divisi: 'nama_divisi',
      kodesalesman: 'kode_salesman',   kodesales: 'kode_salesman',
      namasalesman: 'nama_salesman',   namasales: 'nama_salesman',
      namapasar: 'nama_pasar',         pasar: 'nama_pasar',
      kodecustomer: 'kode_customer',   kodecust: 'kode_customer',
      namacustomer: 'nama_customer',   namacust: 'nama_customer',
      kodebarang: 'kode_barang',
      namabarang: 'nama_barang',
      notransaksi: 'no_transaksi',     nofaktur: 'no_transaksi', notrx: 'no_transaksi',
      tanggal: 'tanggal',              tgl: 'tanggal',
      kodekunjungan: 'kode_kunjungan', kunjungan: 'kode_kunjungan',
      qtycrt: 'qty_crt',               qty: 'qty_crt',
      dpprp: 'dpp_rp',                 dpp: 'dpp_rp'
    };
    const bersihkanLabel = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const parseBerheader = (rawData) => {
      let barisHeader = -1, petaKolom = null;
      for (let i = 0; i < Math.min(rawData.length, 20); i++) {
        const row = rawData[i];
        if (!row || row.length === 0) continue;
        const peta = {};
        row.forEach((cell, idx) => {
          const nama = ALIAS_KOLOM[bersihkanLabel(cell)];
          if (nama && peta[nama] === undefined) peta[nama] = idx;
        });
        if (peta.no_transaksi !== undefined && peta.tanggal !== undefined && peta.dpp_rp !== undefined) {
          barisHeader = i; petaKolom = peta; break;
        }
      }
      if (barisHeader === -1) return null;

      const hasil = [];
      for (let i = barisHeader + 1; i < rawData.length; i++) {
        const row = rawData[i];
        if (!row || row.length === 0) continue;

        const ambil = (k) => (petaKolom[k] === undefined ? '' : String(row[petaKolom[k]] == null ? '' : row[petaKolom[k]]).trim());
        const tanggal = parseExcelDate(row[petaKolom.tanggal]);
        const noTrx = ambil('no_transaksi');
        if (!tanggal || !noTrx) continue;
        if (row.join(' ').toLowerCase().includes('grand total')) continue;

        let dpp = parseAmount(row[petaKolom.dpp_rp]) || 0;
        const qty = petaKolom.qty_crt !== undefined ? Math.round(parseAmount(row[petaKolom.qty_crt]) || 0) : 0;
        if (/^RJ/i.test(noTrx) && dpp > 0) dpp = -dpp;

        const kodeSales = ambil('kode_salesman');
        let finalKodeArea = 'KTR', finalArea = 'KANTOR';
        if (kodeSales && routeMap[kodeSales.toLowerCase()]) {
          finalKodeArea = routeMap[kodeSales.toLowerCase()].kode_area || 'KTR';
          finalArea = routeMap[kodeSales.toLowerCase()].area || 'KANTOR';
        }

        hasil.push({
          nama_divisi: ambil('nama_divisi'),
          kode_salesman: kodeSales,
          nama_salesman: ambil('nama_salesman'),
          nama_pasar: ambil('nama_pasar'),
          kode_customer: ambil('kode_customer'),
          nama_customer: ambil('nama_customer'),
          kode_barang: ambil('kode_barang') || '-',
          nama_barang: ambil('nama_barang') || '-',
          no_transaksi: noTrx,
          tanggal: tanggal,
          kode_kunjungan: ambil('kode_kunjungan') || '-',
          qty_crt: qty,
          dpp_rp: dpp,
          kode_area: finalKodeArea,
          area: finalArea
        });
      }
      return hasil;
    };

    for (const fileObj of files) {
      const workbook = XLSX.read(fileObj.buffer, { type: 'buffer', cellDates: true, raw: false });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      // Coba bentuk tabel berheader dulu; kalau tidak cocok, pakai parser format lama di bawah.
      const hasilHeader = parseBerheader(rawData);
      if (hasilHeader && hasilHeader.length > 0) {
        console.log(`[UPLOAD] Format tabel berheader terdeteksi: ${hasilHeader.length} baris.`);
        cleanRows.push(...hasilHeader);
        continue;
      }

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

    return cleanRows;
}

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

    const cleanRows = await parseMasterExcelFiles(req.files, routeMap);

    if (cleanRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada baris transaksi valid pada file Excel!' });
    }

    await client.query('BEGIN');

    // LAPIS 1: perbarui master kunjungan dari file, lalu isi baris yang kunjungannya '-'
    const statMaster = await perbaruiMasterKunjungan(client, cleanRows);
    const jmlTerisi = await isiKunjunganDariMaster(client, cleanRows);
    const sisaKosong = cleanRows.filter(r => !KUNJUNGAN_VALID(r.kode_kunjungan)).length;
    console.log(`[UPLOAD] Master kunjungan: ${statMaster.total_customer} customer dibaca, ` +
                `${statMaster.customer_baru} baru, ${statMaster.kunjungan_berubah} berubah. ` +
                `Kunjungan kosong terisi dari master: ${jmlTerisi}. Sisa kosong: ${sisaKosong}.`);

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
    res.json({
      success: true,
      message: `Berhasil menyimpan ${cleanRows.length} baris data ke data_master_sales!` +
               (jmlTerisi > 0 ? ` ${jmlTerisi} baris yang kode kunjungannya kosong otomatis diisi dari Master Kunjungan Customer.` : '') +
               (sisaKosong > 0 ? ` ${sisaKosong} baris masih tanpa kode kunjungan (customer belum pernah punya kode kunjungan).` : ''),
      detail_kunjungan: { ...statMaster, terisi_dari_master: jmlTerisi, masih_kosong: sisaKosong }
    });

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

// =========================================================================
// UPDATE KODE KUNJUNGAN DARI FILE EXCEL (tanpa hapus / insert ulang data)
// Mencocokkan berdasarkan No Transaksi. Memperbarui data_master_sales
// dan data_history_sales sekaligus.
// =========================================================================
app.post('/api/update-kunjungan-excel', upload.array('excelFiles', 3), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: 'Tidak ada file yang diunggah!' });
  }

  const client = await pool.connect();
  try {
    const timpaSemua = String(req.body.overwrite || '') === 'true';

    const routeRes = await client.query('SELECT kode_salesman, kode_area, nama_area FROM list_salesman_route');
    const routeMap = {};
    routeRes.rows.forEach(r => {
      if (r.kode_salesman) {
        routeMap[r.kode_salesman.trim().toLowerCase()] = { kode_area: r.kode_area, area: r.nama_area };
      }
    });

    const rows = await parseMasterExcelFiles(req.files, routeMap);
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada baris transaksi valid pada file Excel!' });
    }

    // Kolom yang boleh diisi dari Excel.
    // Hanya kolom yang nilainya SAMA untuk seluruh baris dalam satu No Transaksi,
    // supaya aman dicocokkan lewat No Transaksi saja.
    // Kode Barang / Nama Barang / Qty / DPP TIDAK disentuh karena berbeda tiap baris.
    const KOLOM_ISI = [
      'kode_kunjungan', 'nama_divisi', 'kode_salesman', 'nama_salesman',
      'nama_pasar', 'kode_customer', 'nama_customer', 'kode_area', 'area'
    ];
    const kosong = (v) => {
      const t = String(v == null ? '' : v).trim();
      return t === '' || t === '-';
    };

    // Kumpulkan nilai per No Transaksi per kolom
    const perTrx = new Map();
    let tanpaKunjungan = 0;
    rows.forEach(r => {
      const noTrx = String(r.no_transaksi || '').trim().toUpperCase();
      if (!noTrx || noTrx === '-') return;

      if (!perTrx.has(noTrx)) perTrx.set(noTrx, {});
      const bucketTrx = perTrx.get(noTrx);

      KOLOM_ISI.forEach(kol => {
        let nilai = r[kol];
        if (kol === 'kode_kunjungan') {
          const k = dailyNormKunj(nilai);
          if (!/^K0[1-6]$/.test(k)) { nilai = null; } else { nilai = k; }
        }
        if (nilai == null || kosong(nilai)) return;
        const teks = String(nilai).trim();
        if (!bucketTrx[kol]) bucketTrx[kol] = new Set();
        bucketTrx[kol].add(teks);
      });

      if (!/^K0[1-6]$/.test(dailyNormKunj(r.kode_kunjungan))) tanpaKunjungan++;
    });

    if (perTrx.size === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada No Transaksi yang terbaca dari file Excel.' });
    }

    await client.query('BEGIN');

    const ringkasan = {};
    let adaPerubahan = false;

    for (const kol of KOLOM_ISI) {
      const daftarTrx = [];
      const daftarNilai = [];
      let bentrokNilai = 0;

      perTrx.forEach((bucketTrx, noTrx) => {
        const set = bucketTrx[kol];
        if (!set) return;
        if (set.size > 1) { bentrokNilai++; return; }  // nilai tidak konsisten -> lewati
        daftarTrx.push(noTrx);
        daftarNilai.push(Array.from(set)[0]);
      });

      if (daftarTrx.length === 0) {
        ringkasan[kol] = { master: 0, history: 0, nilai_tidak_konsisten: bentrokNilai };
        continue;
      }

      // kode_kunjungan ikut mode pilihan user; kolom lain selalu hanya mengisi yang kosong / '-'
      const bolehTimpa = (kol === 'kode_kunjungan') && timpaSemua;
      const syarat = bolehTimpa
        ? ''
        : `AND (t.${kol} IS NULL OR TRIM(t.${kol}) IN ('', '-'))`;

      const hasil = {};
      for (const tabel of ['data_master_sales', 'data_history_sales']) {
        const r = await client.query(
          `UPDATE ${tabel} t
           SET ${kol} = v.nilai
           FROM (SELECT UNNEST($1::text[]) AS notrx, UNNEST($2::text[]) AS nilai) v
           WHERE UPPER(TRIM(t.no_transaksi)) = v.notrx
             AND COALESCE(TRIM(t.${kol}), '') IS DISTINCT FROM v.nilai
             ${syarat}`,
          [daftarTrx, daftarNilai]
        );
        hasil[tabel === 'data_master_sales' ? 'master' : 'history'] = r.rowCount;
        if (r.rowCount > 0) adaPerubahan = true;
      }
      hasil.nilai_tidak_konsisten = bentrokNilai;
      ringkasan[kol] = hasil;
    }

    await client.query('COMMIT');

    const totalMaster = Object.values(ringkasan).reduce((a, v) => a + (v.master || 0), 0);
    const totalHistory = Object.values(ringkasan).reduce((a, v) => a + (v.history || 0), 0);
    const kunj = ringkasan.kode_kunjungan || { master: 0, history: 0 };

    return res.json({
      success: true,
      message: `Selesai. Kode Kunjungan diperbarui: ${kunj.master} baris di data_master_sales, ${kunj.history} baris di data_history_sales. ` +
               `Total seluruh kolom: ${totalMaster} + ${totalHistory} baris. ` +
               `(${perTrx.size} no transaksi dibaca dari Excel` +
               `${tanpaKunjungan > 0 ? `, ${tanpaKunjungan} baris Excel tanpa kode kunjungan` : ''})` +
               `${adaPerubahan ? '' : ' Tidak ada data yang berubah.'}`,
      detail: {
        no_transaksi_dibaca: perTrx.size,
        baris_excel_tanpa_kunjungan: tanpaKunjungan,
        mode_kode_kunjungan: timpaSemua ? 'timpa semua' : 'hanya yang kosong / -',
        mode_kolom_lain: 'hanya yang kosong / -',
        per_kolom: ringkasan
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error Update Kode Kunjungan:', err);
    res.status(500).json({ success: false, message: 'Gagal memperbarui kode kunjungan: ' + err.message });
  } finally {
    client.release();
  }
});


// ==========================================
// 10. ENDPOINT PREVIEW DATA UPLOAD HARI INI
// ==========================================
// =========================================================================
// FILTER PER KOLOM GAYA EXCEL untuk Preview Data Upload
// -------------------------------------------------------------------------
// Setiap kolom bisa disaring dengan mencentang nilai-nilainya, seperti
// AutoFilter di Excel. Penyaringan dikerjakan di server supaya tetap benar
// walaupun datanya ribuan baris dan dibagi per halaman.
//
// Nilai kosong / NULL ditampilkan sebagai "(Kosong)".
// =========================================================================

const MS_KOSONG = '(Kosong)';

// Nama kolom -> ekspresi SQL yang dipakai saat menampilkan.
// Harus sama persis dengan yang ada di SELECT, supaya nilai yang dicentang
// user benar-benar cocok dengan yang terlihat di tabel.
const MS_KOLOM = {
  month:          sqlLabelBulan('dms.tanggal'),
  nama_divisi:    `dms.nama_divisi`,
  kode_area:      `COALESCE(dms.kode_area, 'KTR')`,
  area:           `COALESCE(dms.area, 'KANTOR')`,
  kode_salesman:  `dms.kode_salesman`,
  nama_salesman:  `dms.nama_salesman`,
  nama_pasar:     `dms.nama_pasar`,
  kode_customer:  `dms.kode_customer`,
  nama_customer:  `dms.nama_customer`,
  kode_barang:    `dms.kode_barang`,
  nama_barang:    `dms.nama_barang`,
  no_transaksi:   `dms.no_transaksi`,
  tanggal:        `TO_CHAR(dms.tanggal, 'DD/MM/YYYY')`,
  kode_kunjungan: `dms.kode_kunjungan`,
  qty_crt:        `dms.qty_crt::text`,
  dpp_rp:         `dms.dpp_rp::text`
};

// Nilai kosong diseragamkan jadi "(Kosong)"
const msNilai = (ekspresi) => `COALESCE(NULLIF(TRIM(${ekspresi}::text), ''), '${MS_KOSONG}')`;

// Menyusun WHERE dari: filter bulan/tahun/tanggal + filter centang per kolom.
// kecualikan = nama kolom yang filternya diabaikan (dipakai saat mengambil
// daftar pilihan kolom itu sendiri, persis seperti Excel).
function msBangunFilter(query, kecualikan) {
  const conds = [];
  const params = [];
  let filtered = false;

  // --- Filter periode (bulan / tahun / tanggal) ---
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.date || '')) {
    params.push(query.date);
    conds.push(`dms.tanggal = $${params.length}::date`);
    filtered = true;
  } else {
    const yr = parseInt(query.year);
    const mo = parseInt(query.month);
    if (yr) {
      params.push(yr);
      conds.push(`EXTRACT(YEAR FROM dms.tanggal) = $${params.length}`);
      filtered = true;
    }
    if (mo >= 1 && mo <= 12) {
      params.push(mo);
      conds.push(`EXTRACT(MONTH FROM dms.tanggal) = $${params.length}`);
      filtered = true;
    }
  }

  // --- Filter centang per kolom: ?f_kode_kunjungan=K01||K02 ---
  const kolomTersaring = [];
  Object.keys(MS_KOLOM).forEach(kolom => {
    if (kecualikan === kolom) return;
    const mentah = query['f_' + kolom];
    if (mentah === undefined || mentah === null || mentah === '') return;

    const nilai = String(mentah).split('||').map(v => v.trim()).filter(v => v !== '');
    if (nilai.length === 0) return;

    params.push(nilai);
    conds.push(`${msNilai(MS_KOLOM[kolom])} = ANY($${params.length}::text[])`);
    kolomTersaring.push(kolom);
    filtered = true;
  });

  // Tanpa filter apa pun -> tampilkan data yang di-upload hari ini
  if (!filtered) conds.push('DATE(dms.created_at) = CURRENT_DATE');

  return {
    where: 'WHERE ' + conds.join(' AND '),
    params,
    filtered,
    kolomTersaring
  };
}

// Daftar nilai unik sebuah kolom, untuk isi panel centang.
// Filter kolom lain tetap berlaku, tapi filter kolom ini sendiri diabaikan,
// supaya pilihan yang sudah dicentang tidak ikut hilang dari daftar.
app.get('/api/master-sales-distinct', async (req, res) => {
  try {
    const kolom = String(req.query.kolom || '').trim();
    if (!MS_KOLOM[kolom]) {
      return res.status(400).json({
        success: false,
        message: `Kolom "${kolom}" tidak dikenali.`,
        kolom_tersedia: Object.keys(MS_KOLOM)
      });
    }

    const BATAS = Math.min(2000, Math.max(50, parseInt(req.query.batas) || 500));
    const cari = String(req.query.cari || '').trim();

    const f = msBangunFilter(req.query, kolom);
    const params = [...f.params];
    let where = f.where;

    if (cari) {
      params.push('%' + cari + '%');
      where += ` AND ${msNilai(MS_KOLOM[kolom])} ILIKE $${params.length}`;
    }

    const ekspresi = msNilai(MS_KOLOM[kolom]);

    // Jumlah seluruh nilai unik, untuk tahu apakah daftarnya terpotong
    const jml = await pool.query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT DISTINCT ${ekspresi} AS v FROM data_master_sales dms ${where}
       ) x`,
      params
    );

    params.push(BATAS);
    const r = await pool.query(
      `SELECT ${ekspresi} AS nilai, COUNT(*)::int AS jumlah
       FROM data_master_sales dms
       ${where}
       GROUP BY 1
       ORDER BY 1
       LIMIT $${params.length}`,
      params
    );

    res.json({
      success: true,
      kolom,
      total_unik: jml.rows[0].n,
      terpotong: jml.rows[0].n > r.rows.length,
      batas: BATAS,
      values: r.rows.map(x => ({ v: x.nilai, n: x.jumlah }))
    });
  } catch (err) {
    console.error('Error Distinct Master Sales:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/today-uploaded-sales', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Filter periode (?month=9&year=2026&date=2026-09-25) digabung dengan
    // filter centang per kolom (?f_kode_kunjungan=K01||K02), gaya Excel.
    // Tanpa filter apa pun -> data yang di-upload hari ini (created_at).
    const f = msBangunFilter(req.query, null);
    const whereClause = f.where;
    const params = f.params;
    const filtered = f.filtered;

    const countRes = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(dms.dpp_rp), 0)::float8 AS total_dpp
       FROM data_master_sales dms ${whereClause}`,
      params
    );
    const totalRows = parseInt(countRes.rows[0].total);
    const totalDpp = parseFloat(countRes.rows[0].total_dpp) || 0;
    const totalPages = Math.ceil(totalRows / limit);

    const dataRes = await pool.query(`
      SELECT 
        ${sqlLabelBulan('dms.tanggal')} AS month,
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
      ${whereClause}
      ORDER BY ${filtered ? 'dms.tanggal ASC, dms.id ASC' : 'dms.id ASC'}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({
      success: true,
      data: dataRes.rows,
      filtered,
      kolom_tersaring: f.kolomTersaring,
      totalDpp,
      pagination: { totalRows, totalPages, currentPage: page, limit }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Daftar tahun yang tersedia di data master (untuk dropdown filter)
app.get('/api/master-sales-years', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT EXTRACT(YEAR FROM tanggal)::int AS year FROM data_master_sales WHERE tanggal IS NOT NULL ORDER BY year DESC'
    );
    res.json({ success: true, years: result.rows.map(r => r.year) });
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
// Route yang sama SELALU digabung (datanya memang milik satu area).
// Yang dibedakan hanya NAMA SALESMAN yang ditampilkan:
//  - mulai tanggal ini : pakai nama salesman asli (nama placeholder spt "AGPC : BOGOR" dibuang)
//  - sebelum tanggal ini: pakai nama apa adanya dari List Sales Route (spt laporan September)
const DAILY_REAL_NAME_FROM = '2026-10-01';

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

// =========================================================================
// TARGET PRODUCT AGPC & AGPS (per produk, per area, 3 bulan + AVE + TGT)
// =========================================================================
async function siapkanTabelTargetProduct() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS target_product (
        id SERIAL PRIMARY KEY,
        divisi VARCHAR(10) NOT NULL,
        team VARCHAR(10) NOT NULL,
        tahun INT,
        periode VARCHAR(50) NOT NULL,
        bulan_1 VARCHAR(20), bulan_2 VARCHAR(20), bulan_3 VARCHAR(20),
        nama_produk VARCHAR(255) NOT NULL,
        nama_area VARCHAR(255) NOT NULL,
        urut_area INT DEFAULT 0,
        m1 NUMERIC DEFAULT 0, m2 NUMERIC DEFAULT 0, m3 NUMERIC DEFAULT 0,
        ave NUMERIC DEFAULT 0, tgt NUMERIC DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Kolom tambahan (aman diulang)
    await client.query(`ALTER TABLE target_product ADD COLUMN IF NOT EXISTS kode_barang VARCHAR(100)`);
    await client.query(`ALTER TABLE target_product ADD COLUMN IF NOT EXISTS m_kini NUMERIC DEFAULT 0`);
    await client.query(`ALTER TABLE target_product ADD COLUMN IF NOT EXISTS bulan_kini VARCHAR(20)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tp_konteks
      ON target_product (divisi, team, periode)
    `);
    console.log('✅ Tabel target_product siap.');
  } catch (err) {
    console.error('⚠️  Gagal menyiapkan tabel target_product:', err.message);
  } finally {
    client.release();
  }
}

// Ambil data satu konteks (divisi + team + periode)
app.get('/api/target-product', async (req, res) => {
  try {
    const { divisi, team, periode } = req.query;
    if (!divisi || !team || !periode) {
      return res.status(400).json({ success: false, message: 'Parameter divisi, team dan periode wajib diisi.' });
    }

    const r = await pool.query(
      `SELECT nama_produk, kode_barang, nama_area, urut_area,
              m1::float8 AS m1, m2::float8 AS m2, m3::float8 AS m3,
              ave::float8 AS ave, tgt::float8 AS tgt,
              COALESCE(m_kini, 0)::float8 AS m_kini,
              bulan_1, bulan_2, bulan_3, bulan_kini, tahun
       FROM target_product
       WHERE UPPER(divisi) = UPPER($1) AND UPPER(team) = UPPER($2) AND periode = $3
       ORDER BY nama_produk ASC, urut_area ASC, nama_area ASC`,
      [divisi, team, periode]
    );

    const areas = [];
    r.rows.forEach(x => { if (!areas.includes(x.nama_area)) areas.push(x.nama_area); });
    const h = r.rows[0] || {};

    res.json({
      success: true,
      divisi, team, periode,
      tahun: h.tahun || null,
      bulan_1: h.bulan_1 || null, bulan_2: h.bulan_2 || null, bulan_3: h.bulan_3 || null,
      bulan_kini: h.bulan_kini || null,
      areas,
      items: r.rows
    });
  } catch (err) {
    console.error('Error Get Target Product:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data target product: ' + err.message });
  }
});

// Simpan satu konteks. Data periode yang sama ditimpa.
app.post('/api/target-product', async (req, res) => {
  const client = await pool.connect();
  try {
    const { divisi, team, tahun, periode, bulan_1, bulan_2, bulan_3, bulan_kini, areas, items } = req.body || {};

    if (!divisi || !team || !periode || !Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Data tidak lengkap (divisi, team, periode, items wajib ada).' });
    }
    if (items.length === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada baris yang dikirim.' });
    }

    const urutArea = {};
    (areas || []).forEach((a, i) => { urutArea[a] = i; });

    await client.query('BEGIN');
    await client.query(
      `DELETE FROM target_product
       WHERE UPPER(divisi) = UPPER($1) AND UPPER(team) = UPPER($2) AND periode = $3`,
      [divisi, team, periode]
    );

    // Kirim per 500 baris supaya query tidak terlalu panjang
    const UKURAN = 500;
    let tersimpan = 0;

    for (let i = 0; i < items.length; i += UKURAN) {
      const bagian = items.slice(i, i + UKURAN);
      const nilai = [];
      const params = [];
      let n = 1;

      bagian.forEach(it => {
        nilai.push(`($${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++})`);
        params.push(
          String(divisi).toUpperCase(), String(team).toUpperCase(),
          parseInt(tahun) || null, periode,
          bulan_1 || null, bulan_2 || null, bulan_3 || null,
          String(it.nama_produk || '').trim(), String(it.nama_area || '').trim(),
          urutArea[it.nama_area] !== undefined ? urutArea[it.nama_area] : 0,
          parseFloat(it.m1) || 0, parseFloat(it.m2) || 0, parseFloat(it.m3) || 0,
          parseFloat(it.tgt) || 0,
          String(it.kode_barang || '').trim() || null,
          parseFloat(it.m_kini) || 0,
          bulan_kini || null
        );
      });

      await client.query(
        `INSERT INTO target_product
          (divisi, team, tahun, periode, bulan_1, bulan_2, bulan_3,
           nama_produk, nama_area, urut_area, m1, m2, m3, tgt,
           kode_barang, m_kini, bulan_kini)
         VALUES ${nilai.join(', ')}`,
        params
      );
      tersimpan += bagian.length;
    }

    // AVE dihitung di server supaya pasti konsisten
    await client.query(
      `UPDATE target_product
       SET ave = ROUND((m1 + m2 + m3) / 3.0, 4)
       WHERE UPPER(divisi) = UPPER($1) AND UPPER(team) = UPPER($2) AND periode = $3`,
      [divisi, team, periode]
    );

    await client.query('COMMIT');

    const jmlProduk = new Set(items.map(it => it.nama_produk)).size;
    res.json({
      success: true,
      message: `Target Product ${String(divisi).toUpperCase()} ${String(team).toUpperCase()} periode ${periode} tersimpan: ` +
               `${jmlProduk} produk, ${tersimpan} baris.`,
      tersimpan, produk: jmlProduk
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error Save Target Product:', err);
    res.status(500).json({ success: false, message: 'Gagal menyimpan target product: ' + err.message });
  } finally {
    client.release();
  }
});

// Daftar periode yang sudah tersimpan
app.get('/api/target-product-periode', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT divisi, team, periode, tahun, COUNT(DISTINCT nama_produk)::int AS jml_produk,
              COUNT(*)::int AS jml_baris, MAX(created_at) AS terakhir
       FROM target_product
       GROUP BY divisi, team, periode, tahun
       ORDER BY tahun DESC NULLS LAST, periode DESC, divisi, team`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// =========================================================================
// TARGET PRODUCT - SUMBER DATA OTOMATIS
// 1) Daftar produk diambil dari SQL Server [CORPORATE].[dbo].[MS_Barang]
// 2) Realisasi bulan 1/2/3 dihitung dari data_history_sales
// 3) Realisasi bulan berjalan dihitung dari data_master_sales
// 4) Kode barang berawalan Z (retur) dan Q (bonus / pesanan khusus)
//    digabungkan ke produk aslinya berdasarkan nama barang
// =========================================================================

// Normalisasi teks untuk pencocokan: huruf besar, buang semua tanda baca/spasi.
// Dipakai supaya "*CUP INJEC - SUMO 500 ML" == "CUP INJEC - SUMO 500 ML".
const tpNorm = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
const TP_NORM_SQL = (kolom) => `UPPER(REGEXP_REPLACE(COALESCE(${kolom}, ''), '[^A-Za-z0-9]', '', 'g'))`;

// Kode barang yang harus digabung ke produk asli
const tpPrefixGabung = (kode) => {
  const k = String(kode || '').trim().toUpperCase();
  if (k.startsWith('Z')) return 'Z';   // barang retur
  if (k.startsWith('Q')) return 'Q';   // barang bonus / pesanan khusus
  return null;
};

const TP_BULAN_MAP = {
  JAN: 1, JANUARI: 1, JANUARY: 1,
  FEB: 2, PEB: 2, FEBRUARI: 2, FEBRUARY: 2,
  MAR: 3, MARET: 3, MARCH: 3,
  APR: 4, APRIL: 4,
  MEI: 5, MAY: 5,
  JUN: 6, JUNI: 6, JUNE: 6,
  JUL: 7, JULI: 7, JULY: 7,
  AGU: 8, AGS: 8, AGT: 8, AGUS: 8, AGUST: 8, AGUSTUS: 8, AUG: 8, AUGUST: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OKT: 10, OCT: 10, OKTOBER: 10, OCTOBER: 10,
  NOP: 11, NOV: 11, NOVEMBER: 11,
  DES: 12, DEC: 12, DESEMBER: 12, DECEMBER: 12
};

const TP_NAMA_BULAN = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
                       'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// Mengubah apa yang ditulis user ("JUL", "Agust", "Sept-25", "09/2026")
// menjadi { bulan, tahun }.
function tpParseBulan(label, tahunDefault) {
  const raw = String(label == null ? '' : label).trim();
  if (!raw) return null;
  const tahunDef = parseInt(tahunDefault) || new Date().getFullYear();

  const huruf = raw.toUpperCase().replace(/[^A-Z]/g, '');
  let bulan = null;
  if (huruf) {
    if (TP_BULAN_MAP[huruf] !== undefined) {
      bulan = TP_BULAN_MAP[huruf];
    } else {
      let terbaik = null;
      for (const k of Object.keys(TP_BULAN_MAP)) {
        if (huruf.startsWith(k) || k.startsWith(huruf)) {
          if (!terbaik || k.length > terbaik.length) terbaik = k;
        }
      }
      if (terbaik) bulan = TP_BULAN_MAP[terbaik];
    }
  }

  const angka = (raw.match(/\d+/g) || []).map(x => ({ t: x, n: parseInt(x, 10) }));
  let tahun = null;
  for (const a of angka) {
    if (a.t.length === 4) tahun = a.n;
    else if (a.t.length <= 2 && bulan && a.n <= 99) tahun = 2000 + a.n;
  }
  if (!bulan) {
    const kand = angka.find(a => a.t.length <= 2 && a.n >= 1 && a.n <= 12);
    if (kand) bulan = kand.n;
  }
  if (!bulan) return null;

  return { bulan, tahun: tahun || tahunDef, label: raw, nama: TP_NAMA_BULAN[bulan] };
}

// =========================================================================
// DAFTAR PRODUK DARI SQL SERVER (MS_Barang)
// =========================================================================
app.get('/api/master-produk', async (req, res) => {
  try {
    const divisi = String(req.query.divisi || '').trim().toUpperCase();

    const poolSql = await sql.connect(sqlServerConfig);
    const hasil = await poolSql.request().query(`
      SELECT KD_Barang,
             Nama_Barang,
             CASE kd_divisi WHEN 'NP' THEN 'AGPC' WHEN 'PL' THEN 'AGPS' END AS Nama_Divisi,
             CASE Non_Aktif  WHEN 'F' THEN 'Aktif' WHEN 'T' THEN 'Non Aktif' END AS Status
      FROM [CORPORATE].[dbo].[MS_Barang] WITH (NOLOCK)
      WHERE KD_Barang NOT LIKE '%ATK%'
        AND Non_Aktif = 'F'
        AND kd_divisi IN ('NP', 'PL')
      ORDER BY KD_Barang
    `);

    let baris = hasil.recordset.map(r => ({
      kode_barang: String(r.KD_Barang || '').trim(),
      nama_barang: String(r.Nama_Barang || '').trim(),
      nama_divisi: String(r.Nama_Divisi || '').trim(),
      status: String(r.Status || '').trim()
    }));

    if (divisi === 'AGPC' || divisi === 'AGPS') {
      baris = baris.filter(b => b.nama_divisi === divisi);
    }

    res.json({ success: true, divisi: divisi || 'SEMUA', total: baris.length, data: baris });
  } catch (err) {
    console.error('Error Master Produk (SQL Server):', err);
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil daftar produk dari SQL Server: ' + err.message
    });
  }
});

// Peta area: menerjemahkan apa pun yang tertulis di kolom kode_area / area /
// kode_salesman menjadi salah satu nama area yang diminta halaman.
// Di database nilainya bisa bermacam-macam untuk area yang sama, contoh:
//   kode_area = 'AGPC-BJB-01'       (kode route)
//   area      = 'AGPC : BANTEN-BKS' (ada awalan divisi)
//   diminta   = 'BANTEN-BKS'
async function tpPetaArea(client, areaMinta) {
  const mintaNorm = areaMinta.map(a => ({ a, n: tpNorm(a) })).filter(x => x.n);
  const peta = new Map();        // kunci ternormalisasi -> nama area
  const petaSales = new Map();   // kode salesman (huruf kecil) -> nama area

  const tambah = (teks, area) => {
    const k = tpNorm(teks);
    if (k && !peta.has(k)) peta.set(k, area);
  };

  // Bentuk langsung + yang berawalan nama divisi
  mintaNorm.forEach(({ a, n }) => {
    tambah(n, a);
    tambah('AGPC' + n, a);
    tambah('AGPS' + n, a);
  });

  // Cocokkan juga lewat List Sales Route, supaya kode route seperti
  // 'AGPC-BJB-01' ikut dikenali sebagai area 'BANTEN-BKS'.
  const cocokkan = (teks) => {
    const t = tpNorm(teks);
    if (!t) return null;
    for (const { a, n } of mintaNorm) if (t === n || t.endsWith(n)) return a;
    return null;
  };

  let rute = { rows: [] };
  try {
    rute = await client.query(
      `SELECT kode_area, nama_area, kode_salesman FROM list_salesman_route`);
  } catch (e) {
    console.error('[TARGET PRODUCT] List Sales Route tidak terbaca:', e.message);
  }

  rute.rows.forEach(rt => {
    const area = cocokkan(rt.nama_area) || cocokkan(rt.kode_area);
    if (!area) return;
    tambah(rt.kode_area, area);
    tambah(rt.nama_area, area);
    const ks = String(rt.kode_salesman || '').trim().toLowerCase();
    if (ks && !petaSales.has(ks)) petaSales.set(ks, area);
  });

  return {
    kunci: [...peta.keys()], nilaiArea: [...peta.values()],
    salesKunci: [...petaSales.keys()], salesArea: [...petaSales.values()],
    jml: peta.size, jmlSales: petaSales.size
  };
}

// Ambil total qty per (divisi, nama produk, area) untuk satu bulan.
async function tpRealisasiBulan(client, tabel, bulan, tahun, pa) {
  const r = await client.query(
    `WITH peta AS (
       SELECT * FROM UNNEST($3::text[], $4::text[]) AS t(kunci, area)
     ),
     peta_sales AS (
       SELECT * FROM UNNEST($5::text[], $6::text[]) AS t(ks, area)
     ),
     baris AS (
       SELECT
         UPPER(TRIM(COALESCE(d.nama_divisi, ''))) AS divisi,
         UPPER(TRIM(COALESCE(d.kode_barang, ''))) AS kode_barang,
         TRIM(COALESCE(d.nama_barang, ''))        AS nama_barang,
         ${TP_NORM_SQL('d.nama_barang')}          AS nama_norm,
         COALESCE(pk.area, pa2.area, ps.area)     AS area_pakai,
         TRIM(COALESCE(d.kode_area, ''))          AS kode_area_asli,
         TRIM(COALESCE(d.area, ''))               AS area_asli,
         COALESCE(d.qty_crt, 0)::numeric          AS qty
       FROM ${tabel} d
       LEFT JOIN peta       pk  ON pk.kunci  = ${TP_NORM_SQL('d.kode_area')}
       LEFT JOIN peta       pa2 ON pa2.kunci = ${TP_NORM_SQL('d.area')}
       LEFT JOIN peta_sales ps  ON ps.ks     = LOWER(TRIM(COALESCE(d.kode_salesman, '')))
       WHERE d.tanggal >= make_date($1::int, $2::int, 1)
         AND d.tanggal <  (make_date($1::int, $2::int, 1) + INTERVAL '1 month')
     )
     SELECT divisi, nama_norm, area_pakai,
            CASE WHEN area_pakai IS NULL THEN kode_area_asli ELSE '' END AS ka_contoh,
            CASE WHEN area_pakai IS NULL THEN area_asli      ELSE '' END AS ar_contoh,
            SUM(qty)::float8 AS qty,
            COUNT(*)::int    AS baris,
            MIN(kode_barang) AS kode_contoh,
            MIN(nama_barang) AS nama_contoh
     FROM baris
     WHERE nama_norm <> ''
     GROUP BY divisi, nama_norm, area_pakai,
              CASE WHEN area_pakai IS NULL THEN kode_area_asli ELSE '' END,
              CASE WHEN area_pakai IS NULL THEN area_asli      ELSE '' END`,
    [tahun, bulan, pa.kunci, pa.nilaiArea, pa.salesKunci, pa.salesArea]
  );
  return r.rows;
}

// Hitung realisasi 3 bulan + bulan berjalan, lalu gabungkan dengan daftar
// produk dari SQL Server.
app.get('/api/target-product-realisasi', async (req, res) => {
  const client = await pool.connect();
  try {
    const divisi = String(req.query.divisi || '').trim().toUpperCase();
    const team   = String(req.query.team || '').trim().toUpperCase();
    const tahun  = parseInt(req.query.tahun) || new Date().getFullYear();
    const areaMinta = String(req.query.areas || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (divisi !== 'AGPC' && divisi !== 'AGPS') {
      return res.status(400).json({ success: false, message: 'Parameter divisi harus AGPC atau AGPS.' });
    }
    if (areaMinta.length === 0) {
      return res.status(400).json({ success: false, message: 'Parameter areas wajib diisi (dipisah koma).' });
    }

    const per = [
      tpParseBulan(req.query.b1, tahun),
      tpParseBulan(req.query.b2, tahun),
      tpParseBulan(req.query.b3, tahun)
    ];
    const gagal = ['b1', 'b2', 'b3'].filter((k, i) => !per[i] && String(req.query[k] || '').trim() !== '');
    if (gagal.length) {
      return res.status(400).json({
        success: false,
        message: `Label bulan tidak dikenali: ${gagal.map(k => req.query[k]).join(', ')}. ` +
                 `Pakai contoh: JUL, Agust, Sept, Okt, atau 09/2026.`
      });
    }

    // Bulan berjalan = bulan hari ini
    const skr = new Date();
    const bulanKini = {
      bulan: skr.getMonth() + 1,
      tahun: skr.getFullYear(),
      nama: TP_NAMA_BULAN[skr.getMonth() + 1]
    };
    bulanKini.label = `${bulanKini.nama.slice(0, 3).toUpperCase()}-${String(bulanKini.tahun).slice(2)}`;

    const pa = await tpPetaArea(client, areaMinta);

    // --- Daftar produk dari SQL Server ---
    let masterProduk = [];
    let peringatanSql = null;
    try {
      const poolSql = await sql.connect(sqlServerConfig);
      const hs = await poolSql.request().query(`
        SELECT KD_Barang,
               Nama_Barang,
               CASE kd_divisi WHEN 'NP' THEN 'AGPC' WHEN 'PL' THEN 'AGPS' END AS Nama_Divisi
        FROM [CORPORATE].[dbo].[MS_Barang] WITH (NOLOCK)
        WHERE KD_Barang NOT LIKE '%ATK%'
          AND Non_Aktif = 'F'
          AND kd_divisi IN ('NP', 'PL')
        ORDER BY KD_Barang
      `);
      masterProduk = hs.recordset
        .map(r => ({
          kode_barang: String(r.KD_Barang || '').trim(),
          nama_barang: String(r.Nama_Barang || '').trim(),
          nama_divisi: String(r.Nama_Divisi || '').trim()
        }))
        .filter(b => b.nama_divisi === divisi && b.nama_barang);
    } catch (e) {
      peringatanSql = 'Daftar produk dari SQL Server tidak dapat dibaca (' + e.message +
                      '). Produk diambil dari data penjualan saja.';
      console.error('Error MS_Barang pada realisasi:', e.message);
    }

    // Satu produk = satu nama (sudah dinormalkan). Kode Z / Q dibuang bila
    // nama yang sama sudah punya kode asli.
    const perNama = new Map();   // nama_norm -> { kode_barang, nama_barang, gabung: [] }
    masterProduk.forEach(b => {
      const kunci = tpNorm(b.nama_barang);
      if (!kunci) return;
      const pfx = tpPrefixGabung(b.kode_barang);
      const ada = perNama.get(kunci);
      if (!ada) {
        perNama.set(kunci, {
          kode_barang: b.kode_barang,
          nama_barang: b.nama_barang.replace(/^\*+/, '').trim(),
          asli: !pfx,
          gabung: pfx ? [b.kode_barang] : []
        });
        return;
      }
      if (!pfx && !ada.asli) {
        // kode asli ditemukan setelah kode Z / Q -> pakai yang asli
        if (!ada.gabung.includes(ada.kode_barang)) ada.gabung.push(ada.kode_barang);
        ada.kode_barang = b.kode_barang;
        ada.nama_barang = b.nama_barang.replace(/^\*+/, '').trim();
        ada.asli = true;
      } else if (pfx) {
        ada.gabung.push(b.kode_barang);
      }
    });

    // --- Ambil realisasi tiap periode ---
    const nilai = new Map();     // nama_norm -> { area -> {m1,m2,m3,kini} }
    const diag = [];

    const ambilSlot = async (namaSlot, p, tabelUtama, tabelCadangan) => {
      if (!p) { diag.push({ slot: namaSlot, status: 'dilewati (label bulan kosong)' }); return; }

      let tabel = tabelUtama;
      let baris = await tpRealisasiBulan(client, tabel, p.bulan, p.tahun, pa);
      if (baris.length === 0 && tabelCadangan) {
        tabel = tabelCadangan;
        baris = await tpRealisasiBulan(client, tabel, p.bulan, p.tahun, pa);
      }

      let cocokDivisi = baris.filter(x => x.divisi === divisi);
      let catatanDivisi = null;
      if (cocokDivisi.length === 0 && baris.length > 0) {
        cocokDivisi = baris.filter(x => x.divisi.includes(divisi));
        if (cocokDivisi.length === 0) {
          catatanDivisi = `Kolom nama_divisi tidak ada yang bernilai ${divisi} ` +
                          `(yang ada: ${[...new Set(baris.map(x => x.divisi || '(kosong)'))].slice(0, 6).join(', ')}). ` +
                          `Semua baris dipakai.`;
          cocokDivisi = baris;
        }
      }

      let masuk = 0, luarArea = 0, produkBaru = 0;
      const contohLuar = new Map();

      cocokDivisi.forEach(x => {
        const area = x.area_pakai;
        if (!area) {
          luarArea += x.baris;
          const c = `kode_area="${x.ka_contoh || '(kosong)'}" / area="${x.ar_contoh || '(kosong)'}"`;
          contohLuar.set(c, (contohLuar.get(c) || 0) + x.baris);
          return;
        }

        let info = perNama.get(x.nama_norm);
        if (!info) {
          // Produk ada di penjualan tapi tidak ada di MS_Barang aktif.
          // Tetap ditampilkan supaya angkanya tidak hilang.
          info = {
            kode_barang: x.kode_contoh || '',
            nama_barang: String(x.nama_contoh || '').replace(/^\*+/, '').trim(),
            asli: !tpPrefixGabung(x.kode_contoh),
            gabung: [],
            dariPenjualan: true
          };
          perNama.set(x.nama_norm, info);
          produkBaru++;
        }

        if (!nilai.has(x.nama_norm)) nilai.set(x.nama_norm, {});
        const perArea = nilai.get(x.nama_norm);
        if (!perArea[area]) perArea[area] = { m1: 0, m2: 0, m3: 0, kini: 0 };
        perArea[area][namaSlot] += x.qty;
        masuk += x.baris;
      });

      diag.push({
        slot: namaSlot,
        label: p.label, bulan: p.bulan, tahun: p.tahun, nama_bulan: p.nama,
        tabel, kelompok: baris.length,
        baris_terpakai: masuk, baris_luar_area: luarArea,
        contoh_area_tidak_cocok: [...contohLuar.entries()]
          .sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([teks, n]) => `${teks} (${n} baris)`),
        produk_tidak_ada_di_ms_barang: produkBaru,
        catatan: catatanDivisi
      });
    };

    await ambilSlot('m1', per[0], 'data_history_sales', 'data_master_sales');
    await ambilSlot('m2', per[1], 'data_history_sales', 'data_master_sales');
    await ambilSlot('m3', per[2], 'data_history_sales', 'data_master_sales');
    await ambilSlot('kini', bulanKini, 'data_master_sales', 'data_history_sales');

    // --- Susun hasil ---
    const items = [];
    for (const [kunci, info] of perNama.entries()) {
      const perArea = nilai.get(kunci) || {};
      const isi = {};
      let adaAngka = false;
      areaMinta.forEach(a => {
        const v = perArea[a];
        if (!v) return;
        const m1 = v.m1, m2 = v.m2, m3 = v.m3, kini = v.kini;
        if (!m1 && !m2 && !m3 && !kini) return;
        isi[a] = {
          m1: +m1.toFixed(4), m2: +m2.toFixed(4), m3: +m3.toFixed(4),
          kini: +kini.toFixed(4),
          ave: +(((m1 + m2 + m3) / 3)).toFixed(4)
        };
        adaAngka = true;
      });
      items.push({
        kode_barang: info.kode_barang,
        nama_produk: info.nama_barang,
        kode_gabung: info.gabung,
        dari_penjualan: !!info.dariPenjualan,
        ada_angka: adaAngka,
        nilai: isi
      });
    }
    items.sort((a, b) => String(a.kode_barang).localeCompare(String(b.kode_barang)));

    const jmlGabung = items.reduce((n, it) => n + (it.kode_gabung ? it.kode_gabung.length : 0), 0);

    res.json({
      success: true,
      divisi, team, tahun,
      areas: areaMinta,
      periode: { m1: per[0], m2: per[1], m3: per[2], kini: bulanKini },
      peta_area: { kunci_dikenali: pa.jml, salesman_dikenali: pa.jmlSales },
      total_produk: items.length,
      produk_ada_angka: items.filter(i => i.ada_angka).length,
      kode_digabung: jmlGabung,
      peringatan: peringatanSql,
      diagnostik: diag,
      items
    });
  } catch (err) {
    console.error('Error Target Product Realisasi:', err);
    res.status(500).json({ success: false, message: 'Gagal menghitung realisasi: ' + err.message });
  } finally {
    client.release();
  }
});

// Alat bantu: lihat nilai kode_area / area apa saja yang ada di database
// untuk satu bulan, dan apakah sudah cocok dengan daftar area halaman.
app.get('/api/debug-area-produk', async (req, res) => {
  const client = await pool.connect();
  try {
    const tabel = req.query.tabel === 'master' ? 'data_master_sales' : 'data_history_sales';
    const areaMinta = String(req.query.areas || '').split(',').map(s => s.trim()).filter(Boolean);
    const p = tpParseBulan(req.query.bulan, req.query.tahun);
    if (!p) return res.status(400).json({ success: false, message: 'Parameter bulan wajib diisi, contoh: ?bulan=Sept&tahun=2026' });

    const pa = await tpPetaArea(client, areaMinta);
    const r = await client.query(
      `SELECT UPPER(TRIM(COALESCE(nama_divisi,''))) AS divisi,
              TRIM(COALESCE(kode_area,'')) AS kode_area,
              TRIM(COALESCE(area,''))      AS area,
              COUNT(*)::int AS baris,
              SUM(COALESCE(qty_crt,0))::float8 AS qty
       FROM ${tabel}
       WHERE tanggal >= make_date($1::int, $2::int, 1)
         AND tanggal <  (make_date($1::int, $2::int, 1) + INTERVAL '1 month')
       GROUP BY 1,2,3 ORDER BY baris DESC`,
      [p.tahun, p.bulan]
    );

    const petaObj = {};
    pa.kunci.forEach((k, i) => { petaObj[k] = pa.nilaiArea[i]; });

    res.json({
      success: true,
      tabel, bulan: p.bulan, tahun: p.tahun, nama_bulan: p.nama,
      area_diminta: areaMinta,
      kunci_dikenali: petaObj,
      salesman_dikenali: pa.jmlSales,
      data: r.rows.map(x => ({
        ...x,
        cocok_ke: petaObj[tpNorm(x.kode_area)] || petaObj[tpNorm(x.area)] || null
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// =========================================================================
// LAPIS 1 & 2: Master Kunjungan Customer + Periode Berlaku Penugasan Sales
// =========================================================================

// Dijalankan sekali saat server start. Aman diulang (IF NOT EXISTS).
async function siapkanStrukturRouteDanKunjungan() {
  const client = await pool.connect();
  try {
    // LAPIS 1: master kode kunjungan milik CUSTOMER (bukan milik salesman)
    await client.query(`
      CREATE TABLE IF NOT EXISTS master_kunjungan_customer (
        id SERIAL PRIMARY KEY,
        kode_customer VARCHAR(100) NOT NULL,
        kode_kunjungan VARCHAR(20) NOT NULL,
        kode_area VARCHAR(100),
        kode_salesman VARCHAR(100),
        nama_customer VARCHAR(255),
        berlaku_mulai DATE NOT NULL,
        berlaku_sampai DATE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mkc_customer
      ON master_kunjungan_customer (LOWER(TRIM(kode_customer)), berlaku_mulai DESC)
    `);

    // LAPIS 2: periode berlaku penugasan salesman pada sebuah route
    await client.query(`
      ALTER TABLE list_salesman_route
        ADD COLUMN IF NOT EXISTS berlaku_mulai DATE,
        ADD COLUMN IF NOT EXISTS berlaku_sampai DATE,
        ADD COLUMN IF NOT EXISTS aktif BOOLEAN DEFAULT TRUE
    `);

    console.log('✅ Struktur Master Kunjungan & Periode Route siap.');
  } catch (err) {
    console.error('⚠️  Gagal menyiapkan struktur route/kunjungan:', err.message);
  } finally {
    client.release();
  }
}

const KUNJUNGAN_VALID = (v) => /^K0[1-6]$/.test(dailyNormKunj(v));

// Perbarui master dari baris hasil baca Excel.
// Kalau kode kunjungan seorang customer berubah, baris lama ditutup dan dibuat baris baru.
async function perbaruiMasterKunjungan(client, rows) {
  const perCustomer = new Map();
  rows.forEach(r => {
    const cust = String(r.kode_customer || '').trim();
    if (!cust || !KUNJUNGAN_VALID(r.kode_kunjungan)) return;
    if (!perCustomer.has(cust)) {
      perCustomer.set(cust, {
        kode_kunjungan: dailyNormKunj(r.kode_kunjungan),
        kode_area: r.kode_area || null,
        kode_salesman: r.kode_salesman || null,
        nama_customer: r.nama_customer || null,
        tanggalAwal: r.tanggal
      });
    } else {
      const c = perCustomer.get(cust);
      if (r.tanggal && r.tanggal < c.tanggalAwal) c.tanggalAwal = r.tanggal;
    }
  });

  let baru = 0, berubah = 0;
  for (const [cust, info] of perCustomer) {
    const cek = await client.query(
      `SELECT id, kode_kunjungan, berlaku_mulai
       FROM master_kunjungan_customer
       WHERE LOWER(TRIM(kode_customer)) = LOWER(TRIM($1)) AND berlaku_sampai IS NULL
       ORDER BY berlaku_mulai DESC LIMIT 1`,
      [cust]
    );

    if (cek.rows.length === 0) {
      await client.query(
        `INSERT INTO master_kunjungan_customer
           (kode_customer, kode_kunjungan, kode_area, kode_salesman, nama_customer, berlaku_mulai)
         VALUES ($1, $2, $3, $4, $5, $6::date)`,
        [cust, info.kode_kunjungan, info.kode_area, info.kode_salesman, info.nama_customer, info.tanggalAwal]
      );
      baru++;
      continue;
    }

    const lama = cek.rows[0];
    if (dailyNormKunj(lama.kode_kunjungan) === info.kode_kunjungan) continue;

    // Kode kunjungan berubah: tutup yang lama, buka yang baru
    await client.query(
      `UPDATE master_kunjungan_customer
       SET berlaku_sampai = ($1::date - INTERVAL '1 day')::date
       WHERE id = $2`,
      [info.tanggalAwal, lama.id]
    );
    await client.query(
      `INSERT INTO master_kunjungan_customer
         (kode_customer, kode_kunjungan, kode_area, kode_salesman, nama_customer, berlaku_mulai)
       VALUES ($1, $2, $3, $4, $5, $6::date)`,
      [cust, info.kode_kunjungan, info.kode_area, info.kode_salesman, info.nama_customer, info.tanggalAwal]
    );
    berubah++;
  }

  return { customer_baru: baru, kunjungan_berubah: berubah, total_customer: perCustomer.size };
}

// Isi kode kunjungan yang masih '-' pada array hasil baca Excel, memakai master.
async function isiKunjunganDariMaster(client, rows) {
  const perluIsi = rows.filter(r => !KUNJUNGAN_VALID(r.kode_kunjungan) && String(r.kode_customer || '').trim());
  if (perluIsi.length === 0) return 0;

  const master = await client.query(
    `SELECT LOWER(TRIM(kode_customer)) AS cust, kode_kunjungan,
            TO_CHAR(berlaku_mulai,  'YYYY-MM-DD') AS berlaku_mulai,
            TO_CHAR(berlaku_sampai, 'YYYY-MM-DD') AS berlaku_sampai
     FROM master_kunjungan_customer ORDER BY berlaku_mulai ASC`
  );

  const peta = new Map();
  master.rows.forEach(m => {
    if (!peta.has(m.cust)) peta.set(m.cust, []);
    peta.get(m.cust).push(m);
  });

  let terisi = 0;
  perluIsi.forEach(r => {
    const daftar = peta.get(String(r.kode_customer).trim().toLowerCase());
    if (!daftar) return;

    const tgl = r.tanggal;
    let cocok = daftar.find(m => {
      // Sudah berupa teks YYYY-MM-DD dari SQL, jadi tidak ada pergeseran zona waktu
      const mulai = m.berlaku_mulai || '0000-01-01';
      const sampai = m.berlaku_sampai || '9999-12-31';
      return tgl >= mulai && tgl <= sampai;
    });
    if (!cocok) cocok = daftar[daftar.length - 1];   // pakai yang terakhir diketahui

    if (cocok) { r.kode_kunjungan = dailyNormKunj(cocok.kode_kunjungan); terisi++; }
  });

  return terisi;
}

// =========================================================================
// SINKRON KODE KUNJUNGAN DARI SQL SERVER (MS_Terms + MS_Salesman)
// -------------------------------------------------------------------------
// Di aplikasi SQL Server, setiap customer punya kode kunjungan. Kalau sales
// ganti atau pindah rute, kode kunjungan di data omset ikut kosong. Daftar
// dari SQL Server ini dipakai untuk mengisi kembali yang kosong itu.
//
// Catatan penting:
//  - Hanya kolom kd_kunjungan (yang pertama) yang dipakai untuk mengisi.
//    kd_kunjungan2 dan kd_kunjungan3 hanya disimpan sebagai informasi.
//  - Tabel list_salesman_route TIDAK disentuh. Pemetaan area tetap manual,
//    karena query SQL Server tidak punya kolom area.
//  - Perubahan selalu ditampilkan dulu (preview), baru diterapkan.
// =========================================================================

const SQL_DAFTAR_KUNJUNGAN = `
  SELECT DISTINCT
       t.[KD_Customer]
      ,c.[Perusahaan] AS Nama_Customer
      ,t.[KD_Salesman]
      ,s.[Nama]
      ,s.[Posisi]
      ,CASE
          WHEN LTRIM(RTRIM(t.[KD_Salesman])) IN ('1G01-0001', '1G01-0004')
              THEN 'KTR'
          WHEN LTRIM(RTRIM(t.[KD_Salesman])) IN ('1G01-0003', '1G01-0006', '1G01-0007', '1G01-007')
              THEN 'TELE'
          WHEN LTRIM(RTRIM(t.[KD_Salesman])) IN ('1G01-0002', '1G01-0005', '1G01-0008')
              THEN 'AGP N'
          WHEN t.[KD_Salesman] LIKE '1G%' THEN 'AGP N'
          WHEN t.[kd_divisi] = 'NP'       THEN 'AGPC'
          WHEN t.[kd_divisi] = 'PL'       THEN 'AGPS'
          ELSE ''
       END AS Divisi
      ,t.[kd_kunjungan]
      ,t.[kd_kunjungan2]
      ,t.[kd_kunjungan3]
  FROM [CORPORATE].[dbo].[MS_Terms] t WITH (NOLOCK)
  INNER JOIN [CORPORATE].[dbo].[MS_Salesman] s WITH (NOLOCK)
      ON s.[KD_Salesman] = t.[KD_Salesman]
  LEFT JOIN [CORPORATE].[dbo].[MS_Customer] c WITH (NOLOCK)
      ON c.[KD_Customer] = t.[KD_Customer]
  WHERE t.[KD_Salesman] <> '-'
    AND s.[Non_Aktif] = 'F'
    AND s.[Nama] NOT LIKE '%(SPV)%'
    AND (
          t.[kd_divisi] IN ('NP', 'PL')
       OR t.[KD_Salesman] LIKE '1G%'
    )
  ORDER BY t.[KD_Customer]
`;

// Kolom tambahan pada master_kunjungan_customer (aman diulang)
async function siapkanKolomSyncKunjungan() {
  const client = await pool.connect();
  try {
    const tambah = [
      "ADD COLUMN IF NOT EXISTS kode_kunjungan2 VARCHAR(20)",
      "ADD COLUMN IF NOT EXISTS kode_kunjungan3 VARCHAR(20)",
      "ADD COLUMN IF NOT EXISTS nama_salesman VARCHAR(255)",
      "ADD COLUMN IF NOT EXISTS posisi VARCHAR(100)",
      "ADD COLUMN IF NOT EXISTS divisi VARCHAR(20)",
      "ADD COLUMN IF NOT EXISTS sumber VARCHAR(30)"
    ];
    for (const t of tambah) {
      await client.query(`ALTER TABLE master_kunjungan_customer ${t}`);
    }
    console.log('✅ Kolom sinkron kunjungan siap.');
  } catch (err) {
    console.error('⚠️  Gagal menyiapkan kolom sinkron kunjungan:', err.message);
  } finally {
    client.release();
  }
}

// Baca daftar dari SQL Server lalu rapikan jadi satu baris per customer.
async function ambilKunjunganSqlServer() {
  const poolSql = await sql.connect(sqlServerConfig);
  const hasil = await poolSql.request().query(SQL_DAFTAR_KUNJUNGAN);

  const perCustomer = new Map();   // kode customer (huruf kecil) -> data
  const bentrok = [];              // customer dengan kode kunjungan berbeda

  hasil.recordset.forEach(r => {
    const kodeCust = String(r.KD_Customer || '').trim();
    if (!kodeCust) return;

    const kunci = kodeCust.toLowerCase();
    const baris = {
      kode_customer: kodeCust,
      nama_customer: String(r.Nama_Customer || '').trim(),
      kode_salesman: String(r.KD_Salesman || '').trim(),
      nama_salesman: String(r.Nama || '').trim(),
      posisi: String(r.Posisi || '').trim(),
      divisi: String(r.Divisi || '').trim(),
      k1: dailyNormKunj(r.kd_kunjungan),
      k2: dailyNormKunj(r.kd_kunjungan2),
      k3: dailyNormKunj(r.kd_kunjungan3)
    };

    const ada = perCustomer.get(kunci);
    if (!ada) { perCustomer.set(kunci, baris); return; }

    // Customer muncul lebih dari sekali (dilayani lebih dari satu salesman).
    // Selama kode kunjungannya sama, tidak masalah - cukup digabung.
    if (ada.k1 === baris.k1) {
      if (!ada.salesman_lain) ada.salesman_lain = [];
      if (!ada.salesman_lain.includes(baris.kode_salesman)) ada.salesman_lain.push(baris.kode_salesman);
      return;
    }

    // Kode kunjungannya beda -> tidak bisa ditentukan sendiri oleh sistem.
    const sudahDicatat = bentrok.find(b => b.kode_customer.toLowerCase() === kunci);
    if (sudahDicatat) {
      if (!sudahDicatat.pilihan.some(p => p.kode_kunjungan === baris.k1)) {
        sudahDicatat.pilihan.push({ kode_kunjungan: baris.k1, kode_salesman: baris.kode_salesman });
      }
    } else {
      bentrok.push({
        kode_customer: kodeCust,
        pilihan: [
          { kode_kunjungan: ada.k1, kode_salesman: ada.kode_salesman },
          { kode_kunjungan: baris.k1, kode_salesman: baris.kode_salesman }
        ]
      });
    }
  });

  // Customer yang bentrok tidak ikut diproses otomatis
  bentrok.forEach(b => perCustomer.delete(b.kode_customer.toLowerCase()));

  return { perCustomer, bentrok, totalBaris: hasil.recordset.length };
}

// Bandingkan daftar SQL Server dengan master_kunjungan_customer di PostgreSQL
async function bandingkanKunjungan(client, tglBerlaku) {
  const { perCustomer, bentrok, totalBaris } = await ambilKunjunganSqlServer();

  const tglAcuan = /^\d{4}-\d{2}-\d{2}$/.test(tglBerlaku || '')
    ? tglBerlaku
    : tglHariIni();

  // Untuk customer yang BENAR-BENAR baru (belum pernah ada di master), kode
  // kunjungannya diberlakukan sejak transaksi pertamanya, bukan sejak hari ini.
  // Kalau tidak, transaksi bulan-bulan lalu tidak ikut terisi.
  // Customer yang kodenya BERUBAH tetap memakai tanggal berlaku yang dipilih,
  // supaya laporan bulan lalu tetap memakai kode yang dulu benar.
  const awalTransaksi = new Map();
  try {
    const at = await client.query(
      `SELECT LOWER(TRIM(kode_customer)) AS cust, TO_CHAR(MIN(tanggal), 'YYYY-MM-DD') AS awal
       FROM (
         SELECT kode_customer, tanggal FROM data_history_sales
         UNION ALL
         SELECT kode_customer, tanggal FROM data_master_sales
       ) x
       WHERE tanggal IS NOT NULL
         AND kode_customer IS NOT NULL AND TRIM(kode_customer) <> ''
       GROUP BY 1`
    );
    at.rows.forEach(r => {
      if (r.awal) awalTransaksi.set(r.cust, r.awal);
    });
  } catch (e) {
    console.error('[SYNC] Tidak bisa membaca tanggal transaksi pertama:', e.message);
  }

  const pg = await client.query(
    `SELECT LOWER(TRIM(kode_customer)) AS cust, kode_customer, kode_kunjungan,
            kode_kunjungan2, kode_kunjungan3, nama_salesman, kode_salesman,
            nama_customer, berlaku_mulai, sumber
     FROM master_kunjungan_customer
     WHERE berlaku_sampai IS NULL`
  );
  const petaPg = new Map();
  pg.rows.forEach(r => petaPg.set(r.cust, r));

  const baru = [], berubah = [], sama = [], tanpaKode = [], infoBeda = [];

  for (const [kunci, s] of perCustomer.entries()) {
    const lama = petaPg.get(kunci);

    if (!KUNJUNGAN_VALID(s.k1)) {
      tanpaKode.push({
        kode_customer: s.kode_customer, kode_salesman: s.kode_salesman,
        nama_salesman: s.nama_salesman, divisi: s.divisi,
        kode_kunjungan: s.k1 || '(kosong)', k2: s.k2, k3: s.k3,
        kode_kunjungan_sekarang: lama ? lama.kode_kunjungan : null
      });
      continue;
    }

    const isi = {
      kode_customer: s.kode_customer, nama_customer: s.nama_customer || null,
      kode_salesman: s.kode_salesman,
      nama_salesman: s.nama_salesman, posisi: s.posisi, divisi: s.divisi,
      kode_kunjungan: s.k1, k2: s.k2 || null, k3: s.k3 || null,
      salesman_lain: s.salesman_lain || []
    };

    if (!lama) {
      const awal = awalTransaksi.get(kunci);
      baru.push({
        ...isi,
        berlaku_mulai_usulan: (awal && awal < tglAcuan) ? awal : tglAcuan,
        punya_transaksi_lama: !!(awal && awal < tglAcuan)
      });
      continue;
    }

    if (dailyNormKunj(lama.kode_kunjungan) !== s.k1) {
      berubah.push({ ...isi, kode_kunjungan_lama: lama.kode_kunjungan, berlaku_mulai_lama: lama.berlaku_mulai });
      continue;
    }

    // Kode kunjungan sama. Cek apakah keterangan tambahannya perlu diperbarui.
    const perluPerbarui =
      (lama.kode_kunjungan2 || null) !== isi.k2 ||
      (lama.kode_kunjungan3 || null) !== isi.k3 ||
      (lama.nama_salesman || '') !== isi.nama_salesman ||
      (lama.kode_salesman || '') !== isi.kode_salesman ||
      (lama.nama_customer || '') !== (isi.nama_customer || '');

    sama.push({ ...isi, perlu_perbarui_keterangan: perluPerbarui });
  }

  // Ada di PostgreSQL tapi tidak ada di hasil query SQL Server.
  // TIDAK dihapus - hanya dilaporkan, karena bisa jadi customer lama yang
  // masih punya transaksi di data history.
  const hanyaDiPostgres = [];
  for (const [kunci, r] of petaPg.entries()) {
    if (!perCustomer.has(kunci) && !bentrok.some(b => b.kode_customer.toLowerCase() === kunci)) {
      hanyaDiPostgres.push({
        kode_customer: r.kode_customer, kode_kunjungan: r.kode_kunjungan,
        nama_customer: r.nama_customer, sumber: r.sumber || '(tidak diketahui)'
      });
    }
  }

  return {
    ringkasan: {
      baris_sql_server: totalBaris,
      customer_sql_server: perCustomer.size,
      customer_postgres: petaPg.size,
      baru: baru.length,
      baru_ditarik_mundur: baru.filter(x => x.punya_transaksi_lama).length,
      berubah: berubah.length,
      sama: sama.length,
      perlu_perbarui_keterangan: sama.filter(x => x.perlu_perbarui_keterangan).length,
      tanpa_kode: tanpaKode.length,
      bentrok: bentrok.length,
      hanya_di_postgres: hanyaDiPostgres.length
    },
    baru, berubah, tanpa_kode: tanpaKode, bentrok,
    hanya_di_postgres: hanyaDiPostgres,
    sama_perlu_perbarui: sama.filter(x => x.perlu_perbarui_keterangan)
  };
}

// --- PREVIEW: lihat dulu apa yang akan berubah, tidak menulis apa pun ---
app.get('/api/sync-kunjungan-sqlserver', async (req, res) => {
  const client = await pool.connect();
  try {
    const hasil = await bandingkanKunjungan(client, req.query.tanggal_berlaku);
    res.json({ success: true, ...hasil });
  } catch (err) {
    console.error('Error Preview Sync Kunjungan:', err);
    res.status(500).json({
      success: false,
      message: 'Gagal membaca daftar kunjungan dari SQL Server: ' + err.message
    });
  } finally {
    client.release();
  }
});

// Tabel catatan setiap kali sinkron dijalankan (manual maupun otomatis)
async function siapkanLogSyncKunjungan() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS log_sync_kunjungan (
        id SERIAL PRIMARY KEY,
        waktu TIMESTAMP DEFAULT NOW(),
        otomatis BOOLEAN DEFAULT FALSE,
        tanggal_berlaku DATE,
        ditambah INT DEFAULT 0,
        diganti INT DEFAULT 0,
        keterangan INT DEFAULT 0,
        ditarik_mundur INT DEFAULT 0,
        dilewati_bentrok INT DEFAULT 0,
        dilewati_tanpa_kode INT DEFAULT 0,
        terisi_master INT DEFAULT 0,
        terisi_history INT DEFAULT 0,
        berhasil BOOLEAN DEFAULT TRUE,
        pesan TEXT
      )
    `);
  } catch (err) {
    console.error('⚠️  Gagal menyiapkan tabel log_sync_kunjungan:', err.message);
  } finally {
    client.release();
  }
}

// Inti sinkronisasi. Dipakai oleh tombol manual dan oleh job otomatis.
// Customer bentrok dan customer tanpa kd_kunjungan SELALU dilewati.
async function jalankanSyncKunjungan(opsi) {
  const o = opsi || {};
  const tglBerlaku = /^\d{4}-\d{2}-\d{2}$/.test(o.tanggal_berlaku || '') ? o.tanggal_berlaku : tglHariIni();
  const pakaiBaru = o.sertakan_baru !== false;
  const pakaiBerubah = o.sertakan_berubah !== false;
  const isiKosong = o.isi_yang_kosong !== false;
  const otomatis = !!o.otomatis;

  const client = await pool.connect();
  try {
    const hasil = await bandingkanKunjungan(client, tglBerlaku);

    await client.query('BEGIN');
    let ditambah = 0, diganti = 0, keterangan = 0, mundur = 0;

    if (pakaiBaru) {
      for (const b of hasil.baru) {
        await client.query(
          `INSERT INTO master_kunjungan_customer
             (kode_customer, nama_customer, kode_kunjungan, kode_kunjungan2, kode_kunjungan3,
              kode_salesman, nama_salesman, posisi, divisi, berlaku_mulai, sumber)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'sqlserver')`,
          [b.kode_customer, b.nama_customer, b.kode_kunjungan, b.k2, b.k3,
           b.kode_salesman, b.nama_salesman, b.posisi, b.divisi,
           b.berlaku_mulai_usulan || tglBerlaku]
        );
        ditambah++;
        if (b.punya_transaksi_lama) mundur++;
      }
    }

    if (pakaiBerubah) {
      for (const b of hasil.berubah) {
        await client.query(
          `UPDATE master_kunjungan_customer
           SET berlaku_sampai = ($2::date - INTERVAL '1 day')::date
           WHERE LOWER(TRIM(kode_customer)) = LOWER(TRIM($1)) AND berlaku_sampai IS NULL`,
          [b.kode_customer, tglBerlaku]
        );
        await client.query(
          `INSERT INTO master_kunjungan_customer
             (kode_customer, nama_customer, kode_kunjungan, kode_kunjungan2, kode_kunjungan3,
              kode_salesman, nama_salesman, posisi, divisi, berlaku_mulai, sumber)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'sqlserver')`,
          [b.kode_customer, b.nama_customer, b.kode_kunjungan, b.k2, b.k3,
           b.kode_salesman, b.nama_salesman, b.posisi, b.divisi, tglBerlaku]
        );
        diganti++;
      }
    }

    for (const b of hasil.sama_perlu_perbarui) {
      await client.query(
        `UPDATE master_kunjungan_customer
         SET kode_kunjungan2 = $2, kode_kunjungan3 = $3,
             kode_salesman = $4, nama_salesman = $5, posisi = $6, divisi = $7,
             nama_customer = COALESCE(NULLIF(TRIM($8), ''), nama_customer),
             sumber = COALESCE(sumber, 'sqlserver')
         WHERE LOWER(TRIM(kode_customer)) = LOWER(TRIM($1)) AND berlaku_sampai IS NULL`,
        [b.kode_customer, b.k2, b.k3, b.kode_salesman, b.nama_salesman, b.posisi, b.divisi,
         b.nama_customer || '']
      );
      keterangan++;
    }

    // Kode area pada master diselaraskan dengan List Sales Route lewat kode
    // salesman yang sama. Nama team dan nama area tidak disimpan di sini -
    // keduanya diambil langsung dari List Sales Route saat ditampilkan,
    // supaya kalau rutenya diubah, daftar customer ikut berubah sendiri.
    const selaras = await client.query(
      `WITH rute AS (
         SELECT DISTINCT ON (LOWER(TRIM(kode_salesman)))
                LOWER(TRIM(kode_salesman)) AS ks, kode_area
         FROM list_salesman_route
         WHERE kode_salesman IS NOT NULL AND TRIM(kode_salesman) <> ''
         ORDER BY LOWER(TRIM(kode_salesman)), berlaku_mulai DESC NULLS LAST, id DESC
       )
       UPDATE master_kunjungan_customer m
       SET kode_area = r.kode_area
       FROM rute r
       WHERE r.ks = LOWER(TRIM(COALESCE(m.kode_salesman, '')))
         AND COALESCE(m.kode_area, '') IS DISTINCT FROM r.kode_area`
    );

    await client.query('COMMIT');

    // Isi kode_kunjungan yang masih kosong di data omset
    let terisi = { data_master_sales: 0, data_history_sales: 0 };
    if (isiKosong) {
      for (const tabel of ['data_master_sales', 'data_history_sales']) {
        const r = await client.query(
          `UPDATE ${tabel} t
           SET kode_kunjungan = m.kode_kunjungan
           FROM master_kunjungan_customer m
           WHERE LOWER(TRIM(t.kode_customer)) = LOWER(TRIM(m.kode_customer))
             AND t.tanggal >= m.berlaku_mulai
             AND (m.berlaku_sampai IS NULL OR t.tanggal <= m.berlaku_sampai)
             AND (t.kode_kunjungan IS NULL OR TRIM(t.kode_kunjungan) IN ('', '-'))`
        );
        terisi[tabel] = r.rowCount;
      }
    }

    const pesan =
      `${ditambah} customer baru` +
      (mundur > 0 ? ` (${mundur} diberlakukan sejak transaksi pertamanya)` : '') +
      `, ${diganti} kode kunjungan diganti (berlaku ${tglBerlaku}), ` +
      `${keterangan} keterangan diperbarui, ${selaras.rowCount} kode area diselaraskan` +
      (isiKosong
        ? `. Kode kunjungan kosong terisi: ${terisi.data_master_sales} baris di data_master_sales, ` +
          `${terisi.data_history_sales} baris di data_history_sales`
        : '') +
      `. Dilewati: ${hasil.ringkasan.bentrok} bentrok, ${hasil.ringkasan.tanpa_kode} tanpa kode.`;

    await client.query(
      `INSERT INTO log_sync_kunjungan
         (otomatis, tanggal_berlaku, ditambah, diganti, keterangan, ditarik_mundur,
          dilewati_bentrok, dilewati_tanpa_kode, terisi_master, terisi_history, berhasil, pesan)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11)`,
      [otomatis, tglBerlaku, ditambah, diganti, keterangan, mundur,
       hasil.ringkasan.bentrok, hasil.ringkasan.tanpa_kode,
       terisi.data_master_sales, terisi.data_history_sales, pesan]
    ).catch(() => {});

    return {
      success: true, message: 'Selesai. ' + pesan,
      tanggal_berlaku: tglBerlaku,
      ditambah, diganti, keterangan, ditarik_mundur: mundur,
      kode_area_diselaraskan: selaras.rowCount,
      terisi,
      tidak_diproses: { tanpa_kode: hasil.ringkasan.tanpa_kode, bentrok: hasil.ringkasan.bentrok },
      bentrok: hasil.bentrok, tanpa_kode: hasil.tanpa_kode
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(
      `INSERT INTO log_sync_kunjungan (otomatis, berhasil, pesan) VALUES ($1, FALSE, $2)`,
      [otomatis, err.message]
    ).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// --- TERAPKAN (manual dari halaman List Sales Route) ---
app.post('/api/sync-kunjungan-sqlserver', async (req, res) => {
  try {
    const hasil = await jalankanSyncKunjungan({ ...(req.body || {}), otomatis: false });
    res.json(hasil);
  } catch (err) {
    console.error('Error Terapkan Sync Kunjungan:', err);
    res.status(500).json({ success: false, message: 'Gagal menerapkan sinkronisasi: ' + err.message });
  }
});

// --- DAFTAR CUSTOMER + KODE KUNJUNGAN ---
// Nama team, kode area dan nama area TIDAK disimpan di tabel customer.
// Semuanya diambil dari List Sales Route dengan mencocokkan kode salesman,
// jadi begitu rutenya diubah, daftar ini ikut benar dengan sendirinya.
app.get('/api/kunjungan-customer', async (req, res) => {
  try {
    const cari = String(req.query.cari || '').trim();
    const divisi = String(req.query.divisi || '').trim().toUpperCase();
    const hanyaAktif = String(req.query.hanya_aktif || 'true') !== 'false';
    const perHal = Math.min(500, Math.max(10, parseInt(req.query.per_hal) || 50));
    const halaman = Math.max(1, parseInt(req.query.halaman) || 1);

    const syarat = [];
    const params = [];

    if (hanyaAktif) syarat.push('m.berlaku_sampai IS NULL');
    if (divisi) {
      params.push(divisi);
      syarat.push(`UPPER(TRIM(COALESCE(m.divisi, r.nama_divisi, ''))) = $${params.length}`);
    }

    // Beberapa kata dipisah spasi dicari bersamaan (semua harus cocok)
    const kolomCari = `CONCAT_WS(' ',
      m.kode_customer, m.nama_customer, m.kode_kunjungan, m.kode_kunjungan2, m.kode_kunjungan3,
      m.kode_salesman, m.nama_salesman, m.divisi,
      r.nama_team, r.kode_area, r.nama_area, r.nama_salesman)`;

    cari.split(/\s+/).filter(Boolean).forEach(kata => {
      params.push('%' + kata + '%');
      syarat.push(`${kolomCari} ILIKE $${params.length}`);
    });

    const where = syarat.length ? 'WHERE ' + syarat.join(' AND ') : '';

    const dasar = `
      FROM master_kunjungan_customer m
      LEFT JOIN (
        SELECT DISTINCT ON (LOWER(TRIM(kode_salesman)))
               LOWER(TRIM(kode_salesman)) AS ks,
               nama_divisi, nama_team, kode_area, nama_area, nama_salesman
        FROM list_salesman_route
        WHERE kode_salesman IS NOT NULL AND TRIM(kode_salesman) <> ''
        ORDER BY LOWER(TRIM(kode_salesman)), berlaku_mulai DESC NULLS LAST, id DESC
      ) r ON r.ks = LOWER(TRIM(COALESCE(m.kode_salesman, '')))
      ${where}`;

    const hitung = await pool.query(`SELECT COUNT(*)::int AS total ${dasar}`, params);
    const total = hitung.rows[0].total;

    params.push(perHal, (halaman - 1) * perHal);
    const data = await pool.query(
      `SELECT m.id, m.kode_customer, m.nama_customer,
              m.kode_kunjungan, m.kode_kunjungan2, m.kode_kunjungan3,
              m.kode_salesman,
              COALESCE(NULLIF(TRIM(COALESCE(m.nama_salesman, '')), ''), r.nama_salesman) AS nama_salesman,
              COALESCE(NULLIF(TRIM(COALESCE(m.divisi, '')), ''), r.nama_divisi) AS divisi,
              r.nama_team,
              COALESCE(r.kode_area, m.kode_area) AS kode_area,
              r.nama_area,
              (r.ks IS NOT NULL) AS route_cocok,
              TO_CHAR(m.berlaku_mulai,  'YYYY-MM-DD') AS berlaku_mulai,
              TO_CHAR(m.berlaku_sampai, 'YYYY-MM-DD') AS berlaku_sampai,
              m.sumber
       ${dasar}
       ORDER BY m.kode_customer ASC, m.berlaku_mulai DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Ringkasan kecil untuk ditampilkan di atas tabel
    const ring = await pool.query(
      `SELECT COUNT(*)::int AS total_aktif,
              COUNT(*) FILTER (WHERE kode_salesman IS NULL OR TRIM(kode_salesman) = '')::int AS tanpa_salesman
       FROM master_kunjungan_customer WHERE berlaku_sampai IS NULL`
    );

    res.json({
      success: true,
      total, halaman, per_hal: perHal,
      total_halaman: Math.max(1, Math.ceil(total / perHal)),
      ringkasan: ring.rows[0],
      data: data.rows
    });
  } catch (err) {
    console.error('Error Daftar Kunjungan Customer:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil daftar customer: ' + err.message });
  }
});

// --- CATATAN SINKRONISASI ---
app.get('/api/log-sync-kunjungan', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, waktu, otomatis, tanggal_berlaku, ditambah, diganti, keterangan,
              ditarik_mundur, dilewati_bentrok, dilewati_tanpa_kode,
              terisi_master, terisi_history, berhasil, pesan
       FROM log_sync_kunjungan ORDER BY waktu DESC LIMIT 20`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =========================================================================
// AUTO SYNC: jalan otomatis setiap hari
// =========================================================================
const AUTOSYNC_AKTIF = process.env.AUTOSYNC_KUNJUNGAN !== 'off';
const AUTOSYNC_JAM = parseInt(process.env.AUTOSYNC_JAM) || 2;     // jam 02:00

function scheduleAutoSyncKunjungan() {
  if (!AUTOSYNC_AKTIF) {
    console.log('🔁 Auto sync kode kunjungan: NONAKTIF (AUTOSYNC_KUNJUNGAN=off)');
    return;
  }

  const jalankan = async (otomatis) => {
    try {
      const h = await jalankanSyncKunjungan({ otomatis, isi_yang_kosong: true });
      console.log('[AUTO SYNC] ' + h.message);
    } catch (e) {
      console.error('[AUTO SYNC] Gagal:', e.message);
    }
  };

  let sudahJalanHariIni = '';
  setInterval(() => {
    const now = new Date();
    const tag = tglHariIni();
    if (now.getHours() >= AUTOSYNC_JAM && sudahJalanHariIni !== tag) {
      sudahJalanHariIni = tag;
      jalankan(true);
    }
  }, 15 * 60 * 1000);

  console.log(`🔁 Auto sync kode kunjungan: setiap hari jam ${AUTOSYNC_JAM}:00`);
}

// =========================================================================
// PERIKSA & PERBAIKI SELISIH DATA CUSTOMER
// -------------------------------------------------------------------------
// Membandingkan data_history_sales dan data_master_sales dengan master
// kunjungan customer, berdasarkan KODE CUSTOMER. Yang diperiksa:
//
//   1. nama_customer  -> tidak terikat periode, boleh disamakan apa adanya
//   2. kode_kunjungan -> TERIKAT PERIODE. Yang dipakai adalah kode yang
//      berlaku PADA TANGGAL TRANSAKSI itu, bukan kode yang berlaku hari ini.
//      Jadi transaksi September tetap memakai kode September walaupun
//      customernya sekarang sudah punya kode baru.
//
// Selalu ditampilkan dulu (preview), baru diterapkan.
// =========================================================================

const SEL_TABEL = ['data_history_sales', 'data_master_sales'];

// Baris master yang berlaku pada tanggal transaksi.
// DISTINCT ON menjaga supaya satu transaksi hanya cocok ke satu baris master.
const SEL_SQL_KUNJUNGAN = (tabel, syaratTanggal) => `
  SELECT d.id,
         TRIM(d.kode_customer)                        AS kode_customer,
         TRIM(COALESCE(d.nama_customer, ''))          AS nama_customer,
         d.tanggal,
         UPPER(TRIM(COALESCE(d.kode_kunjungan, '')))  AS kunjungan_sekarang,
         m.kode_kunjungan                             AS kunjungan_seharusnya
  FROM ${tabel} d
  JOIN LATERAL (
    SELECT mk.kode_kunjungan
    FROM master_kunjungan_customer mk
    WHERE LOWER(TRIM(mk.kode_customer)) = LOWER(TRIM(d.kode_customer))
      AND (mk.berlaku_mulai  IS NULL OR d.tanggal >= mk.berlaku_mulai)
      AND (mk.berlaku_sampai IS NULL OR d.tanggal <= mk.berlaku_sampai)
    ORDER BY mk.berlaku_mulai DESC NULLS LAST, mk.id DESC
    LIMIT 1
  ) m ON TRUE
  WHERE d.kode_customer IS NOT NULL AND TRIM(d.kode_customer) <> ''
    AND d.tanggal IS NOT NULL
    AND COALESCE(NULLIF(TRIM(m.kode_kunjungan), ''), '') <> ''
    AND UPPER(TRIM(COALESCE(d.kode_kunjungan, ''))) IS DISTINCT FROM UPPER(TRIM(m.kode_kunjungan))
    ${syaratTanggal}`;

// Nama customer tidak terikat periode -> pakai baris master yang masih aktif
const SEL_SQL_NAMA = (tabel, syaratTanggal) => `
  SELECT d.id,
         TRIM(d.kode_customer)               AS kode_customer,
         TRIM(COALESCE(d.nama_customer, '')) AS nama_sekarang,
         m.nama_customer                     AS nama_seharusnya
  FROM ${tabel} d
  JOIN LATERAL (
    SELECT mk.nama_customer
    FROM master_kunjungan_customer mk
    WHERE LOWER(TRIM(mk.kode_customer)) = LOWER(TRIM(d.kode_customer))
      AND mk.berlaku_sampai IS NULL
      AND COALESCE(NULLIF(TRIM(mk.nama_customer), ''), '') <> ''
    ORDER BY mk.berlaku_mulai DESC NULLS LAST, mk.id DESC
    LIMIT 1
  ) m ON TRUE
  WHERE d.kode_customer IS NOT NULL AND TRIM(d.kode_customer) <> ''
    AND TRIM(COALESCE(d.nama_customer, '')) IS DISTINCT FROM TRIM(m.nama_customer)
    ${syaratTanggal}`;

function selSyaratTanggal(query, params) {
  const dari = String(query.dari || '').trim();
  const sampai = String(query.sampai || '').trim();
  const pakai = /^\d{4}-\d{2}-\d{2}$/.test(dari) && /^\d{4}-\d{2}-\d{2}$/.test(sampai);
  if (!pakai) return '';
  params.push(dari, sampai);
  return `AND d.tanggal BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
}

// --- PREVIEW: lihat selisihnya, tidak menulis apa pun ---
app.get('/api/cek-selisih-customer', async (req, res) => {
  try {
    const CONTOH = Math.min(100, Math.max(5, parseInt(req.query.contoh) || 20));
    const hasil = { nama: {}, kunjungan: {}, contoh_nama: [], contoh_kunjungan: [] };

    for (const tabel of SEL_TABEL) {
      const pN = [];
      const sN = selSyaratTanggal(req.query, pN);
      const n = await pool.query(
        `SELECT COUNT(*)::int AS baris,
                COUNT(DISTINCT LOWER(kode_customer))::int AS customer
         FROM (${SEL_SQL_NAMA(tabel, sN)}) x`, pN);
      hasil.nama[tabel] = n.rows[0];

      const pK = [];
      const sK = selSyaratTanggal(req.query, pK);
      const k = await pool.query(
        `SELECT COUNT(*)::int AS baris,
                COUNT(DISTINCT LOWER(kode_customer))::int AS customer
         FROM (${SEL_SQL_KUNJUNGAN(tabel, sK)}) x`, pK);
      hasil.kunjungan[tabel] = k.rows[0];

      // Contoh baris, supaya user bisa memeriksa sebelum menerapkan
      const pCN = [];
      const sCN = selSyaratTanggal(req.query, pCN);
      pCN.push(CONTOH);
      const cn = await pool.query(
        `SELECT kode_customer, nama_sekarang, nama_seharusnya, COUNT(*)::int AS baris
         FROM (${SEL_SQL_NAMA(tabel, sCN)}) x
         GROUP BY 1,2,3 ORDER BY baris DESC LIMIT $${pCN.length}`, pCN);
      cn.rows.forEach(r => hasil.contoh_nama.push({ tabel, ...r }));

      const pCK = [];
      const sCK = selSyaratTanggal(req.query, pCK);
      pCK.push(CONTOH);
      const ck = await pool.query(
        `SELECT kode_customer, kunjungan_sekarang, kunjungan_seharusnya,
                MIN(tanggal) AS dari, MAX(tanggal) AS sampai, COUNT(*)::int AS baris
         FROM (${SEL_SQL_KUNJUNGAN(tabel, sCK)}) x
         GROUP BY 1,2,3 ORDER BY baris DESC LIMIT $${pCK.length}`, pCK);
      ck.rows.forEach(r => hasil.contoh_kunjungan.push({ tabel, ...r }));
    }

    const totalNama = SEL_TABEL.reduce((a, t) => a + hasil.nama[t].baris, 0);
    const totalKunj = SEL_TABEL.reduce((a, t) => a + hasil.kunjungan[t].baris, 0);

    res.json({
      success: true,
      periode: (req.query.dari && req.query.sampai) ? `${req.query.dari} s/d ${req.query.sampai}` : 'semua periode',
      total_nama: totalNama,
      total_kunjungan: totalKunj,
      ...hasil
    });
  } catch (err) {
    console.error('Error Cek Selisih Customer:', err);
    res.status(500).json({ success: false, message: 'Gagal memeriksa selisih: ' + err.message });
  }
});

// --- TERAPKAN: samakan data omset dengan master ---
app.post('/api/perbaiki-selisih-customer', async (req, res) => {
  const client = await pool.connect();
  try {
    const o = req.body || {};
    const pakaiNama = o.nama !== false;
    const pakaiKunjungan = o.kunjungan !== false;
    if (!pakaiNama && !pakaiKunjungan) {
      return res.status(400).json({ success: false, message: 'Pilih minimal satu: nama customer atau kode kunjungan.' });
    }

    await client.query('BEGIN');
    const hasil = { nama: {}, kunjungan: {} };

    for (const tabel of SEL_TABEL) {
      if (pakaiNama) {
        const p = [];
        const s = selSyaratTanggal(o, p);
        const r = await client.query(
          `UPDATE ${tabel} t
           SET nama_customer = x.nama_seharusnya
           FROM (${SEL_SQL_NAMA(tabel, s)}) x
           WHERE t.id = x.id`, p);
        hasil.nama[tabel] = r.rowCount;
      } else hasil.nama[tabel] = 0;

      if (pakaiKunjungan) {
        const p = [];
        const s = selSyaratTanggal(o, p);
        const r = await client.query(
          `UPDATE ${tabel} t
           SET kode_kunjungan = x.kunjungan_seharusnya
           FROM (${SEL_SQL_KUNJUNGAN(tabel, s)}) x
           WHERE t.id = x.id`, p);
        hasil.kunjungan[tabel] = r.rowCount;
      } else hasil.kunjungan[tabel] = 0;
    }

    await client.query('COMMIT');

    const tn = SEL_TABEL.reduce((a, t) => a + hasil.nama[t], 0);
    const tk = SEL_TABEL.reduce((a, t) => a + hasil.kunjungan[t], 0);

    res.json({
      success: true,
      message: `Selesai. Nama customer diperbaiki ${tn} baris ` +
               `(${hasil.nama.data_history_sales} history, ${hasil.nama.data_master_sales} master). ` +
               `Kode kunjungan diperbaiki ${tk} baris ` +
               `(${hasil.kunjungan.data_history_sales} history, ${hasil.kunjungan.data_master_sales} master). ` +
               `Kode kunjungan disesuaikan dengan periode tanggal transaksinya, jadi laporan bulan lalu tidak berubah.`,
      nama: hasil.nama, kunjungan: hasil.kunjungan,
      total_nama: tn, total_kunjungan: tk
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error Perbaiki Selisih Customer:', err);
    res.status(500).json({ success: false, message: 'Gagal memperbaiki selisih: ' + err.message });
  } finally {
    client.release();
  }
});

// Perbaiki data yang SUDAH tersimpan, memakai master kunjungan
app.post('/api/backfill-kunjungan', async (req, res) => {
  const client = await pool.connect();
  try {
    const { dari, sampai } = req.body || {};
    const pakaiTanggal = /^\d{4}-\d{2}-\d{2}$/.test(dari || '') && /^\d{4}-\d{2}-\d{2}$/.test(sampai || '');

    const hasil = {};
    await client.query('BEGIN');

    for (const tabel of ['data_master_sales', 'data_history_sales']) {
      const params = [];
      let syaratTanggal = '';
      if (pakaiTanggal) {
        params.push(dari, sampai);
        syaratTanggal = `AND t.tanggal BETWEEN $1::date AND $2::date`;
      }

      const r = await client.query(
        `UPDATE ${tabel} t
         SET kode_kunjungan = m.kode_kunjungan
         FROM master_kunjungan_customer m
         WHERE LOWER(TRIM(t.kode_customer)) = LOWER(TRIM(m.kode_customer))
           AND t.tanggal >= m.berlaku_mulai
           AND (m.berlaku_sampai IS NULL OR t.tanggal <= m.berlaku_sampai)
           AND (t.kode_kunjungan IS NULL OR TRIM(t.kode_kunjungan) IN ('', '-'))
           ${syaratTanggal}`,
        params
      );
      hasil[tabel] = r.rowCount;
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Kode kunjungan terisi dari master: ${hasil.data_master_sales} baris di data_master_sales, ${hasil.data_history_sales} baris di data_history_sales.`,
      detail: hasil,
      periode: pakaiTanggal ? `${dari} s/d ${sampai}` : 'semua periode'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error Backfill Kunjungan:', err);
    res.status(500).json({ success: false, message: 'Gagal mengisi kode kunjungan: ' + err.message });
  } finally {
    client.release();
  }
});

// Bangun ulang master kunjungan dari data yang sudah ada di database
app.post('/api/rebuild-master-kunjungan', async (req, res) => {
  const client = await pool.connect();
  try {
    // Kolom disebut eksplisit, karena data_history_sales dan data_master_sales
    // tidak punya jumlah kolom yang sama (history punya kolom month).
    const sumberBaris = (tabel) => `
      SELECT TRIM(kode_customer) AS kode_customer,
             UPPER(TRIM(kode_kunjungan)) AS kode_kunjungan,
             kode_area, kode_salesman, nama_customer, tanggal
      FROM ${tabel}
      WHERE kode_customer IS NOT NULL AND TRIM(kode_customer) <> ''
        AND tanggal IS NOT NULL
        AND UPPER(TRIM(COALESCE(kode_kunjungan, ''))) ~ '^K0[1-6]$'`;

    const hasil = await client.query(`
      WITH semua AS (
        ${sumberBaris('data_history_sales')}
        UNION ALL
        ${sumberBaris('data_master_sales')}
      ),
      terbaru AS (
        SELECT DISTINCT ON (LOWER(kode_customer))
               kode_customer, kode_kunjungan, kode_area, kode_salesman, nama_customer
        FROM semua
        ORDER BY LOWER(kode_customer), tanggal DESC
      ),
      awal AS (
        SELECT LOWER(kode_customer) AS cust, MIN(tanggal) AS tgl_awal
        FROM semua GROUP BY 1
      )
      INSERT INTO master_kunjungan_customer
        (kode_customer, kode_kunjungan, kode_area, kode_salesman, nama_customer, berlaku_mulai)
      SELECT t.kode_customer, t.kode_kunjungan, t.kode_area, t.kode_salesman, t.nama_customer, a.tgl_awal
      FROM terbaru t
      JOIN awal a ON a.cust = LOWER(t.kode_customer)
      WHERE NOT EXISTS (
        SELECT 1 FROM master_kunjungan_customer m
        WHERE LOWER(TRIM(m.kode_customer)) = LOWER(t.kode_customer)
          AND m.berlaku_sampai IS NULL
      )
    `);

    const jml = await client.query('SELECT COUNT(*)::int AS n FROM master_kunjungan_customer');
    res.json({
      success: true,
      message: `${hasil.rowCount} customer baru ditambahkan. Master kunjungan sekarang berisi ${jml.rows[0].n} customer.`,
      ditambahkan: hasil.rowCount,
      total: jml.rows[0].n
    });
  } catch (err) {
    console.error('Error Rebuild Master Kunjungan:', err);
    res.status(500).json({ success: false, message: 'Gagal membangun master kunjungan: ' + err.message });
  } finally {
    client.release();
  }
});

// Daftar route AGPC & AGPS dari List Sales Route
async function loadDailyRoutes(tanggalLaporan) {
  // Penugasan dipilih berdasarkan PERIODE BERLAKU, bukan status aktif saat ini.
  // Dengan begitu laporan September tetap memakai salesman yang bertugas di September.
  const pakaiPeriode = /^\d{4}-\d{2}-\d{2}$/.test(tanggalLaporan || '');
  const routeRes = await pool.query(
    `SELECT id, nama_divisi, nama_team, kode_area, nama_area, kode_salesman, nama_salesman,
            berlaku_mulai, berlaku_sampai, aktif
     FROM list_salesman_route
     ${pakaiPeriode ? `WHERE (berlaku_mulai IS NULL OR berlaku_mulai <= $1::date)
                        AND (berlaku_sampai IS NULL OR berlaku_sampai >= $1::date)` : ''}
     ORDER BY berlaku_mulai DESC NULLS LAST, id ASC`,
    pakaiPeriode ? [tanggalLaporan] : []
  );
  const routes = [];
  const seen = new Set();
  routeRes.rows.forEach(r => {
    const up = `${r.nama_divisi || ''} ${r.nama_team || ''}`.toUpperCase();
    const divisi = up.includes('AGPC') ? 'AGPC' : up.includes('AGPS') ? 'AGPS' : null;
    if (!divisi) return;
    const tUp = `${r.nama_team || ''} ${r.nama_divisi || ''} ${r.kode_area || ''}`.toUpperCase();
    const team = tUp.includes('BJB') ? 'BJB' : tUp.includes('JJB') ? 'JJB' : '';
    // Satu route hanya dipegang satu salesman pada satu waktu.
    // Karena hasil query sudah urut berlaku_mulai terbaru, yang pertama ketemu adalah yang berlaku.
    const keyArea = `${divisi}|${team}|${dailyNormText(r.kode_area) || dailyNormText(r.nama_area)}`;
    const keySales = `${divisi}|${dailyNormKode(r.kode_salesman) || dailyNormText(r.nama_salesman)}`;
    if (seen.has(keyArea) || seen.has(keySales)) return;
    seen.add(keyArea);
    seen.add(keySales);
    routes.push({ ...r, divisi, team });
  });
  return routes;
}

// Pencocokan baris data -> baris route. Urutan: kode salesman, nama salesman, kode area, nama area.
const AREA_KOSONG = ['', 'KTR', 'KANTOR'];
function buildRouteResolver(routes) {
  const byKode = new Map(), byNama = new Map(), byKodeArea = new Map(), byNamaArea = new Map();
  routes.forEach(rt => {
    const k = dailyNormKode(rt.kode_salesman);
    const n = dailyNormText(rt.nama_salesman);
    const ka = dailyNormText(rt.kode_area);
    const na = dailyNormText(rt.nama_area);
    if (k && !byKode.has(k)) byKode.set(k, rt);
    if (n && !byNama.has(n)) byNama.set(n, rt);
    if (ka && !byKodeArea.has(ka)) byKodeArea.set(ka, rt);
    if (na && !byNamaArea.has(na)) byNamaArea.set(na, rt);
  });

  const resolveRoute = (row) => {
    // Area dipakai lebih dulu. Area sebuah transaksi tidak berubah walaupun
    // salesmannya diganti atau pindah rute, sedangkan kode salesman ikut
    // pindah bersama orangnya. Kalau salesman dicocokkan duluan, OA bulan
    // lalu milik sebuah rute ikut terbawa ke rute baru si salesman.
    const ka = dailyNormText(row.kode_area);
    if (ka && !AREA_KOSONG.includes(ka) && byKodeArea.has(ka)) return { route: byKodeArea.get(ka), via: 'kode_area' };

    const na = dailyNormText(row.area);
    if (na && !AREA_KOSONG.includes(na) && byNamaArea.has(na)) return { route: byNamaArea.get(na), via: 'nama_area' };

    // Area kosong / '-' / KANTOR -> baru pakai salesman sebagai cadangan
    const k = dailyNormKode(row.ks);
    if (k && byKode.has(k)) return { route: byKode.get(k), via: 'kode_salesman' };

    const n = dailyNormText(row.nama_salesman);
    if (n && byNama.has(n)) return { route: byNama.get(n), via: 'nama_salesman' };

    return { route: null, via: 'TIDAK KETEMU' };
  };

  return { resolveRoute };
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

    // 1. Daftar route yang BERLAKU pada tanggal proses (hanya AGPC & AGPS)
    const routes = await loadDailyRoutes(dateStr);

    // 2. Omset & Cust bulan berjalan (tanggal 1 s/d tanggal proses) dari data upload master
    const masterRes = await pool.query(
      `SELECT LOWER(TRIM(kode_salesman)) AS ks,
              MIN(TRIM(COALESCE(nama_salesman, ''))) AS nama_salesman,
              TRIM(COALESCE(kode_area, '')) AS kode_area,
              TRIM(COALESCE(area, '')) AS area,
              UPPER(REGEXP_REPLACE(COALESCE(kode_kunjungan, ''), '[^A-Za-z0-9]', '', 'g')) AS kunj,
              COALESCE(SUM(dpp_rp), 0)::float8 AS omset,
              COUNT(DISTINCT CASE WHEN UPPER(COALESCE(no_transaksi, '')) NOT LIKE 'RJ%'
                                  THEN NULLIF(TRIM(kode_customer), '') END) AS cust
       FROM data_master_sales
       WHERE tanggal >= $1::date AND tanggal <= $2::date
       GROUP BY 1, 3, 4, 5`,
      [monthStart, dateStr]
    );
    // Periode ini bisa berada di data_master_sales, di data_history_sales (sudah diarsipkan),
    // atau sebagian di masing-masing. Baca KEDUANYA.
    // Anti-dobel: kalau satu kode salesman sudah ada di master, baris history untuk kode itu diabaikan.
    const arsipRes = await pool.query(
      `SELECT LOWER(TRIM(kode_salesman)) AS ks,
              MIN(TRIM(COALESCE(nama_salesman, ''))) AS nama_salesman,
              TRIM(COALESCE(kode_area, '')) AS kode_area,
              TRIM(COALESCE(area, '')) AS area,
              UPPER(REGEXP_REPLACE(COALESCE(kode_kunjungan, ''), '[^A-Za-z0-9]', '', 'g')) AS kunj,
              COALESCE(SUM(dpp_rp), 0)::float8 AS omset,
              COUNT(DISTINCT CASE WHEN UPPER(COALESCE(no_transaksi, '')) NOT LIKE 'RJ%'
                                  THEN NULLIF(TRIM(kode_customer), '') END) AS cust
       FROM data_history_sales
       WHERE tanggal >= $1::date AND tanggal <= $2::date
       GROUP BY 1, 3, 4, 5`,
      [monthStart, dateStr]
    );

    // Pilih sumber per KODE SALESMAN + KODE KUNJUNGAN:
    //  - pakai master kalau omsetnya tidak nol
    //  - kalau master tidak punya baris itu, atau punya tapi omsetnya nol (baris sisa), pakai history
    // Dengan begitu tidak ada yang terhitung dua kali, dan baris sisa di master tidak memblokir arsip.
    const kunci = (r) => `${dailyNormKode(r.ks)}|${dailyNormText(r.kode_area)}|` +
                         `${dailyNormText(r.area)}|${dailyNormKunj(r.kunj)}`;
    const petaOmset = new Map();
    masterRes.rows.forEach(r => petaOmset.set(kunci(r), { row: r, sumber: 'master' }));

    let dipakaiDariArsip = 0;
    let totalDariArsip = 0;
    const bentrok = [];

    arsipRes.rows.forEach(r => {
      const k = kunci(r);
      const ada = petaOmset.get(k);
      const omsetArsip = parseFloat(r.omset) || 0;

      if (!ada || Math.round(parseFloat(ada.row.omset) || 0) === 0) {
        petaOmset.set(k, { row: r, sumber: 'history' });
        dipakaiDariArsip++;
        totalDariArsip += omsetArsip;
      } else if (Math.round(omsetArsip) !== 0) {
        bentrok.push(`${r.nama_salesman || r.ks} ${dailyNormKunj(r.kunj)}`);
      }
    });

    const omsetRows = Array.from(petaOmset.values()).map(v => v.row);
    const dariMaster = Array.from(petaOmset.values()).filter(v => v.sumber === 'master').length;

    const sumberDipakai = [];
    if (dariMaster > 0) sumberDipakai.push('data_master_sales');
    if (dipakaiDariArsip > 0) sumberDipakai.push('data_history_sales (sudah diarsipkan)');
    const omsetSumber = sumberDipakai.join(' + ') || 'tidak ada data';

    if (dipakaiDariArsip > 0) {
      warnings.push(`Sebagian omset periode ini diambil dari data_history_sales karena sudah diarsipkan (${dipakaiDariArsip} kelompok, Rp ${Math.round(totalDariArsip).toLocaleString('id-ID')}).`);
    }
    if (bentrok.length > 0) {
      warnings.push(`${bentrok.length} kelompok punya omset di KEDUA tabel untuk periode yang sama; yang dipakai data_master_sales: ${bentrok.slice(0, 6).join('; ')}${bentrok.length > 6 ? ' ...' : ''}`);
    }
    if (omsetRows.length === 0) {
      warnings.push(`Belum ada data omset untuk tanggal 1 s/d ${day} bulan ini, baik di Upload Master maupun History Transaksi.`);
    }

    // 3. OA: distinct kode_customer dari History Transaksi 2 bulan terakhir
    const oaRes = await pool.query(
      `SELECT LOWER(TRIM(kode_salesman)) AS ks,
              MIN(TRIM(COALESCE(nama_salesman, ''))) AS nama_salesman,
              TRIM(COALESCE(kode_area, '')) AS kode_area,
              TRIM(COALESCE(area, '')) AS area,
              UPPER(REGEXP_REPLACE(COALESCE(kode_kunjungan, ''), '[^A-Za-z0-9]', '', 'g')) AS kunj,
              COUNT(DISTINCT CASE WHEN UPPER(COALESCE(no_transaksi, '')) NOT LIKE 'RJ%'
                                  THEN NULLIF(TRIM(kode_customer), '') END) AS oa
       FROM data_history_sales
       WHERE tanggal >= $1::date AND tanggal < $2::date
       GROUP BY 1, 3, 4, 5`,
      [oaStart, monthStart]
    );

    // 3b. Petakan setiap baris data ke baris List Sales Route
    const { resolveRoute: resolveRouteInfo } = buildRouteResolver(routes);
    const resolveRoute = (row) => resolveRouteInfo(row).route;

    // Kumpulkan data ke keranjang per BARIS ROUTE (bukan per kode salesman)
    const dataByRoute = new Map(); // `${route.id}|K01` -> { omset, cust, oa }
    const bucket = (rt, kunj) => {
      const key = `${rt.id}|${kunj}`;
      if (!dataByRoute.has(key)) dataByRoute.set(key, { omset: 0, cust: 0, oa: 0 });
      return dataByRoute.get(key);
    };

    const orphan = { omset: 0, rows: new Map() }; // data yang tidak ketemu route-nya
    omsetRows.forEach(r => {
      const rt = resolveRoute(r);
      const omset = parseFloat(r.omset) || 0;
      if (!rt) {
        orphan.omset += omset;
        const label = `${r.nama_salesman || r.ks || '-'} (${r.area || r.kode_area || '-'})`;
        orphan.rows.set(label, (orphan.rows.get(label) || 0) + omset);
        return;
      }
      const b = bucket(rt, dailyNormKunj(r.kunj));
      b.omset += omset;
      b.cust += parseInt(r.cust) || 0;
    });

    // Untuk baris riwayat yang areanya kosong, kode salesman diterjemahkan
    // memakai penugasan yang berlaku PADA PERIODE OA, bukan penugasan hari ini.
    // Tanpa ini, riwayat seorang salesman yang baru pindah rute ikut terbawa
    // ke rute barunya dan OA di sana jadi membengkak.
    const akhirOA = new Date(year, month - 1, 0);
    const akhirOAStr = `${akhirOA.getFullYear()}-${dailyPad(akhirOA.getMonth() + 1)}-${dailyPad(akhirOA.getDate())}`;
    const routesOA = await loadDailyRoutes(akhirOAStr);
    const areaSalesmanDulu = new Map();
    routesOA.forEach(rt => {
      const k = dailyNormKode(rt.kode_salesman);
      const n = dailyNormText(rt.nama_salesman);
      if (k && !areaSalesmanDulu.has(k)) areaSalesmanDulu.set(k, rt);
      if (n && !areaSalesmanDulu.has(n)) areaSalesmanDulu.set(n, rt);
    });

    let oaDialihkan = 0;
    const oaTakMasuk = new Map();

    oaRes.rows.forEach(r => {
      const jml = parseInt(r.oa) || 0;
      const ka = dailyNormText(r.kode_area);
      const na = dailyNormText(r.area);
      const areaKepakai = (ka && !AREA_KOSONG.includes(ka)) || (na && !AREA_KOSONG.includes(na));

      let baris = r;
      if (!areaKepakai) {
        // Area kosong -> HANYA boleh memakai penugasan yang berlaku pada
        // periode OA. Kalau salesman itu memang belum punya rute waktu itu,
        // barisnya tidak dimasukkan ke tabel mana pun. Memakai penugasan
        // hari ini akan menumpuk riwayat orang lain ke rute yang baru dia
        // pegang, dan OA di sana jadi membengkak.
        const dulu = areaSalesmanDulu.get(dailyNormKode(r.ks))
                  || areaSalesmanDulu.get(dailyNormText(r.nama_salesman));
        if (!dulu) {
          const label = `${r.nama_salesman || r.ks || '-'} (${r.area || r.kode_area || 'area kosong'})`;
          oaTakMasuk.set(label, (oaTakMasuk.get(label) || 0) + jml);
          return;
        }
        baris = { ...r, kode_area: dulu.kode_area, area: dulu.nama_area };
        oaDialihkan += jml;
      }

      const rt = resolveRoute(baris);
      if (!rt) {
        const label = `${r.nama_salesman || r.ks || '-'} (${r.area || r.kode_area || 'area kosong'})`;
        oaTakMasuk.set(label, (oaTakMasuk.get(label) || 0) + jml);
        return;
      }
      bucket(rt, dailyNormKunj(baris.kunj)).oa += jml;
    });

    if (oaDialihkan > 0) {
      console.log(`[LAPORAN HARIAN] ${oaDialihkan} OA dengan area kosong dialihkan memakai penugasan per ${akhirOAStr}.`);
    }
    if (oaTakMasuk.size > 0) {
      const total = [...oaTakMasuk.values()].reduce((a, b) => a + b, 0);
      const daftar = [...oaTakMasuk.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([l, v]) => `${l}: ${v}`);
      warnings.push(
        `${total} OA pada riwayat 2 bulan terakhir tidak masuk tabel mana pun karena areanya kosong ` +
        `dan salesmannya belum terdaftar di List Sales Route pada periode itu: ${daftar.join('; ')}` +
        `${oaTakMasuk.size > 6 ? ' ...' : ''}`
      );
    }

    if (orphan.rows.size > 0) {
      const list = Array.from(orphan.rows.entries())
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 6)
        .map(([lbl, v]) => `${lbl}: ${Math.round(v).toLocaleString('id-ID')}`);
      warnings.push(`Ada data Upload Master senilai Rp ${Math.round(orphan.omset).toLocaleString('id-ID')} yang kode salesman / area-nya tidak ada di List Sales Route, jadi tidak masuk tabel mana pun: ${list.join('; ')}${orphan.rows.size > 6 ? ' ...' : ''}`);
    }

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
    const rawBlocks = routes.map(rt => {
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
        const d = dataByRoute.get(`${rt.id}|${k}`) || { omset: 0, cust: 0, oa: 0 };
        const sisa = d.omset - target;
        const pct = target > 0 ? (d.omset / target) * 100 : 0;
        return { kunjungan: `K-${dailyPad(i + 1)}`, target, oa: d.oa, cust: d.cust, omset: d.omset, sisa, pct };
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

      // Kunci penggabungan: route yang sama (area yang sama) digabung jadi 1 tabel
      const areaKey = (area && area.codeNorm)
        || dailyNormText(rt.nama_area)
        || dailyNormText(rt.kode_area)
        || `NOAREA-${ks}`;

      return {
        divisi: rt.divisi,
        team: teamKey,
        area_key: areaKey,
        kode_salesman: rt.kode_salesman,
        nama_salesman: rt.nama_salesman,
        kode_area: rt.kode_area,
        nama_area: rt.nama_area,
        target_matched: !!area,
        rows, total, q
      };
    });

    // 6. Gabungkan beberapa salesman yang berada pada ROUTE yang sama menjadi satu tabel.
    //    Hanya untuk tanggal >= DAILY_MERGE_ROUTE_FROM.
    //    OA / CUST / OMSET dijumlahkan, TARGET 100% dihitung sekali (target milik area, bukan per salesman).
    const mergedMap = new Map();
    for (const b of rawBlocks) {
      const key = `${b.divisi}|${b.team}|${b.area_key}`;
      if (!mergedMap.has(key)) {
        mergedMap.set(key, {
          divisi: b.divisi,
          team: b.team,
          area_key: b.area_key,
          kode_area: b.kode_area,
          nama_area: b.nama_area,
          target_matched: b.target_matched,
          sales_list: [],
          kode_sales_list: [],
          rows: DAILY_KUNJUNGAN.map((k, i) => ({
            kunjungan: `K-${dailyPad(i + 1)}`, target: 0, oa: 0, cust: 0, omset: 0, sisa: 0, pct: 0
          }))
        });
      }
      const g = mergedMap.get(key);
      if (b.target_matched) g.target_matched = true;
      if (b.nama_salesman && !g.sales_list.includes(b.nama_salesman)) g.sales_list.push(b.nama_salesman);
      if (b.kode_salesman && !g.kode_sales_list.includes(b.kode_salesman)) g.kode_sales_list.push(b.kode_salesman);
      if (!g.nama_area && b.nama_area) g.nama_area = b.nama_area;
      if (!g.kode_area && b.kode_area) g.kode_area = b.kode_area;

      b.rows.forEach((r, i) => {
        const gr = g.rows[i];
        gr.target = Math.max(gr.target, r.target); // target area: ambil sekali, jangan dijumlah
        gr.oa += r.oa;
        gr.cust += r.cust;
        gr.omset += r.omset;
      });
    }

    const useRealName = dateStr >= DAILY_REAL_NAME_FROM;

    const blocks = Array.from(mergedMap.values()).map(g => {
      g.rows.forEach(r => {
        r.sisa = r.omset - r.target;
        r.pct = r.target > 0 ? (r.omset / r.target) * 100 : 0;
      });

      const sum = (f) => g.rows.reduce((a, r) => a + r[f], 0);
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

      // Buang nama salesman placeholder (mis. "AGPC : BOGOR" / "BOGOR" pada route BOGOR)
      const areaNorm = dailyNormText(g.nama_area);
      const codeNorm = dailyNormText(g.kode_area);
      const isPlaceholder = (n) => {
        const raw = String(n || '').trim();
        if (!raw) return true;
        if (raw.includes(':')) return true;              // mis. "AGPC : BOGOR"
        const x = dailyNormText(raw);
        if (!x) return true;
        if (x === areaNorm || x === codeNorm) return true;
        if (areaNorm && x === `${g.divisi}${areaNorm}`) return true;
        if (areaNorm && x === `${g.divisi}${g.team}${areaNorm}`) return true;
        if (x === g.divisi || x === `${g.divisi}${g.team}`) return true;
        return false;
      };
      // Nama yang ditampilkan:
      //  - sebelum DAILY_REAL_NAME_FROM: apa adanya (nama pertama dari List Sales Route)
      //  - mulai DAILY_REAL_NAME_FROM  : buang nama placeholder bila ada nama asli
      let names;
      if (!useRealName || g.sales_list.length <= 1) {
        names = g.sales_list.slice(0, 1);
      } else {
        names = g.sales_list.filter(n => !isPlaceholder(n));
        if (names.length === 0) names = g.sales_list.slice(0, 1);
      }

      return {
        divisi: g.divisi,
        team: g.team,
        kode_salesman: g.kode_sales_list.join(' / '),
        nama_salesman: names.join(' / ') || '-',
        sales_count: g.sales_list.length,
        kode_area: g.kode_area,
        nama_area: g.nama_area,
        target_matched: g.target_matched,
        rows: g.rows, total, q
      };
    });


    // 7. Sembunyikan tabel yang BENAR-BENAR tidak punya data pada periode ini
    //    (OA = 0, CUST = 0, OMSET = 0). Mis. salesman yang baru masuk bulan berikutnya.
    const hidden = [];
    const visibleBlocks = blocks.filter(b => {
      const t = b.total;
      const hasData = (t.oa > 0) || (t.cust > 0) || (Math.round(t.omset) !== 0);
      if (!hasData) hidden.push(`${b.divisi} - ${b.nama_salesman} (${b.nama_area || b.kode_area || '-'})`);
      return hasData;
    });

    if (unmatched.length > 0) {
      warnings.push(`${unmatched.length} route belum cocok dengan Target Tahunan (cek Kode Area / Nama Area): ${unmatched.slice(0, 8).join('; ')}${unmatched.length > 8 ? ' ...' : ''}`);
    }
    if (hidden.length > 0) {
      warnings.push(`${hidden.length} route disembunyikan karena tidak ada data (OA/CUST/Omset = 0) pada periode ini: ${hidden.slice(0, 8).join('; ')}${hidden.length > 8 ? ' ...' : ''}`);
    }
    if (visibleBlocks.length === 0) {
      warnings.push('Tidak ada tabel yang bisa ditampilkan. Cek data List Sales Route, Upload Master dan History Transaksi untuk periode ini.');
    }

    res.json({
      success: true,
      meta: {
        date: dateStr,
        dateLabel: `${dailyPad(day)}/${dailyPad(month)}/${year}`,
        day, daysInMonth, elapsedPct, quarter,
        monthAbbr: DAILY_MONTH_ABBR[month - 1],
        omsetLabel: `OMSET ${DAILY_MONTH_ABBR[month - 1]} (1-${day})`,
        useRealName,
        omsetSumber
      },
      warnings,
      blocks: visibleBlocks
    });
  } catch (err) {
    console.error('Error Generate Daily Report:', err);
    res.status(500).json({ success: false, message: 'Gagal generate laporan harian: ' + err.message });
  }
});

// =========================================================================
// DIAGNOSA: lihat ke mana setiap kode salesman pada data dialokasikan
// Contoh: /api/debug-daily-mapping?date=2026-09-30
// =========================================================================
app.get('/api/debug-daily-mapping', async (req, res) => {
  try {
    const now = new Date();
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date
      : `${now.getFullYear()}-${dailyPad(now.getMonth() + 1)}-${dailyPad(now.getDate())}`;
    const [year, month] = dateStr.split('-').map(Number);
    const monthStart = `${year}-${dailyPad(month)}-01`;

    const routes = await loadDailyRoutes(dateStr);
    const { resolveRoute } = buildRouteResolver(routes);

    const sqlRingkas = (tabel) => `
      SELECT LOWER(TRIM(kode_salesman)) AS ks,
             MIN(TRIM(COALESCE(nama_salesman, ''))) AS nama_salesman,
             MIN(TRIM(COALESCE(kode_area, ''))) AS kode_area,
             MIN(TRIM(COALESCE(area, ''))) AS area,
             COALESCE(SUM(dpp_rp), 0)::float8 AS omset,
             COUNT(*)::int AS baris
      FROM ${tabel}
      WHERE tanggal >= $1::date AND tanggal <= $2::date
      GROUP BY 1 ORDER BY 5 DESC`;

    const master = await pool.query(sqlRingkas('data_master_sales'), [monthStart, dateStr]);
    const history = await pool.query(sqlRingkas('data_history_sales'), [monthStart, dateStr]);

    // Kode salesman yang punya sisa baris di master (sering jadi biang data history terbuang)
    const ksMaster = new Set(master.rows.map(r => dailyNormKode(r.ks)));

    const petakan = (rows, sumber) => rows.map(r => {
      const hasil = resolveRoute(r);
      return {
        sumber,
        kode_salesman: r.ks,
        nama_salesman: r.nama_salesman,
        kode_area_data: r.kode_area,
        area_data: r.area,
        baris: r.baris,
        omset: Math.round(parseFloat(r.omset) || 0),
        cocok_via: hasil.via,
        ada_juga_di_master: sumber === 'data_history_sales' ? ksMaster.has(dailyNormKode(r.ks)) : null,
        masuk_ke_route: hasil.route
          ? `${hasil.route.divisi} | ${hasil.route.nama_salesman} | ${hasil.route.nama_area} (id ${hasil.route.id})`
          : null
      };
    });

    // Ringkasan per route memakai aturan pemilihan sumber yang sama dengan laporan
    const kunci = (r) => `${dailyNormKode(r.ks)}|${String(r.kode_area || '')}`;
    const peta = new Map();
    master.rows.forEach(r => peta.set(dailyNormKode(r.ks), { row: r, sumber: 'master' }));
    history.rows.forEach(r => {
      const k = dailyNormKode(r.ks);
      const ada = peta.get(k);
      if (!ada || Math.round(parseFloat(ada.row.omset) || 0) === 0) peta.set(k, { row: r, sumber: 'history' });
    });

    const perRoute = new Map();
    peta.forEach(({ row, sumber }) => {
      const hasil = resolveRoute(row);
      const label = hasil.route
        ? `${hasil.route.divisi} | ${hasil.route.nama_salesman} | ${hasil.route.nama_area} (id ${hasil.route.id})`
        : 'TIDAK KETEMU ROUTE';
      const cur = perRoute.get(label) || { omset: 0, dari_master: 0, dari_history: 0, kode_salesman: [] };
      cur.omset += Math.round(parseFloat(row.omset) || 0);
      if (sumber === 'master') cur.dari_master++; else cur.dari_history++;
      if (!cur.kode_salesman.includes(row.ks)) cur.kode_salesman.push(row.ks);
      perRoute.set(label, cur);
    });

    res.json({
      success: true,
      periode: { dari: monthStart, sampai: dateStr },
      jumlah_route: routes.length,
      ringkasan_per_route: Array.from(perRoute.entries())
        .map(([route, v]) => ({ route, omset: v.omset, dari_master: v.dari_master, dari_history: v.dari_history, kode_salesman: v.kode_salesman.join(', ') }))
        .sort((a, b) => b.omset - a.omset),
      route_list: routes.map(r => ({
        id: r.id, divisi: r.divisi, team: r.team,
        kode_salesman: r.kode_salesman, nama_salesman: r.nama_salesman,
        kode_area: r.kode_area, nama_area: r.nama_area
      })),
      data_master: petakan(master.rows, 'data_master_sales'),
      data_history: petakan(history.rows, 'data_history_sales')
    });
  } catch (err) {
    console.error('Error Debug Mapping:', err);
    res.status(500).json({ success: false, message: err.message });
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


// =========================================================================
// ARSIP BULANAN: pindahkan data_master_sales -> data_history_sales
// Jalan otomatis setiap tanggal 5. Data BULAN BERJALAN tidak pernah disentuh.
// =========================================================================
const ARCHIVE_DAY = 5;    // tanggal berapa job dijalankan
const ARCHIVE_HOUR = 1;   // jam berapa (waktu server)

async function ensureArchiveLogTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS data_master_archive_log (
      id SERIAL PRIMARY KEY,
      periode_year INT NOT NULL,
      periode_month INT NOT NULL,
      rows_moved INT DEFAULT 0,
      status VARCHAR(20) NOT NULL,
      message TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Kolom yang ada di KEDUA tabel (tanpa id), supaya INSERT tidak salah kolom
async function getArchiveColumns(client) {
  const res = await client.query(`
    SELECT a.column_name
    FROM information_schema.columns a
    JOIN information_schema.columns b
      ON b.table_schema = a.table_schema
     AND b.table_name = 'data_history_sales'
     AND b.column_name = a.column_name
    WHERE a.table_schema = 'public'
      AND a.table_name = 'data_master_sales'
      AND a.column_name NOT IN ('id')
    ORDER BY a.ordinal_position
  `);
  return res.rows.map(r => r.column_name);
}

async function runArchiveJob(options = {}) {
  const force = options.force === true;
  const client = await pool.connect();
  const hasil = [];

  try {
    await ensureArchiveLogTable(client);

    const cols = await getArchiveColumns(client);
    if (cols.length === 0) {
      throw new Error('Tidak ada kolom yang cocok antara data_master_sales dan data_history_sales.');
    }
    const colList = cols.map(c => `"${c}"`).join(', ');

    // Semua periode di master yang bulannya SUDAH LEWAT (bulan berjalan dikecualikan)
    const periods = await client.query(`
      SELECT EXTRACT(YEAR FROM tanggal)::int AS y,
             EXTRACT(MONTH FROM tanggal)::int AS m,
             COUNT(*)::int AS jml
      FROM data_master_sales
      WHERE tanggal IS NOT NULL
        AND tanggal < date_trunc('month', CURRENT_DATE)
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);

    for (const p of periods.rows) {
      const cek = await client.query(
        `SELECT COUNT(*)::int AS n FROM data_history_sales
         WHERE EXTRACT(YEAR FROM tanggal) = $1 AND EXTRACT(MONTH FROM tanggal) = $2`,
        [p.y, p.m]
      );
      const sudahAda = cek.rows[0].n;

      // Pengaman: jangan menimpa / menggandakan history yang sudah terisi
      if (sudahAda > 0 && !force) {
        const msg = `Dilewati: data_history_sales sudah berisi ${sudahAda} baris untuk periode ini.`;
        await client.query(
          `INSERT INTO data_master_archive_log (periode_year, periode_month, rows_moved, status, message)
           VALUES ($1, $2, 0, 'skipped', $3)`,
          [p.y, p.m, msg]
        );
        hasil.push({ year: p.y, month: p.m, status: 'skipped', rows: 0, message: msg });
        continue;
      }

      try {
        await client.query('BEGIN');

        if (sudahAda > 0 && force) {
          await client.query(
            `DELETE FROM data_history_sales
             WHERE EXTRACT(YEAR FROM tanggal) = $1 AND EXTRACT(MONTH FROM tanggal) = $2`,
            [p.y, p.m]
          );
        }

        const ins = await client.query(
          `INSERT INTO data_history_sales (${colList})
           SELECT ${colList} FROM data_master_sales
           WHERE EXTRACT(YEAR FROM tanggal) = $1 AND EXTRACT(MONTH FROM tanggal) = $2`,
          [p.y, p.m]
        );

        const del = await client.query(
          `DELETE FROM data_master_sales
           WHERE EXTRACT(YEAR FROM tanggal) = $1 AND EXTRACT(MONTH FROM tanggal) = $2`,
          [p.y, p.m]
        );

        // data_master_sales tidak punya kolom "month", jadi isi di history berdasarkan tanggal
        await client.query(
          `UPDATE data_history_sales
           SET month = ${sqlLabelBulan('tanggal')}
           WHERE EXTRACT(YEAR FROM tanggal) = $1 AND EXTRACT(MONTH FROM tanggal) = $2
             AND (month IS NULL OR TRIM(month) = '')`,
          [p.y, p.m]
        );

        if (ins.rowCount !== del.rowCount) {
          throw new Error(`Jumlah baris tidak sama (insert ${ins.rowCount}, delete ${del.rowCount}). Dibatalkan.`);
        }

        await client.query(
          `INSERT INTO data_master_archive_log (periode_year, periode_month, rows_moved, status, message)
           VALUES ($1, $2, $3, 'success', $4)`,
          [p.y, p.m, ins.rowCount, force && sudahAda > 0 ? 'Dipindahkan (mode force, history lama dihapus).' : 'Dipindahkan dari data_master_sales.']
        );

        await client.query('COMMIT');
        hasil.push({ year: p.y, month: p.m, status: 'success', rows: ins.rowCount });
        console.log(`[ARSIP] ${p.y}-${String(p.m).padStart(2, '0')}: ${ins.rowCount} baris dipindahkan ke data_history_sales.`);

      } catch (errPeriode) {
        await client.query('ROLLBACK');
        await client.query(
          `INSERT INTO data_master_archive_log (periode_year, periode_month, rows_moved, status, message)
           VALUES ($1, $2, 0, 'failed', $3)`,
          [p.y, p.m, errPeriode.message]
        );
        hasil.push({ year: p.y, month: p.m, status: 'failed', rows: 0, message: errPeriode.message });
        console.error(`[ARSIP] Gagal periode ${p.y}-${p.m}:`, errPeriode.message);
      }
    }

    return hasil;
  } finally {
    client.release();
  }
}

// Jalankan manual dari halaman web / Postman
app.post('/api/archive-master-to-history', async (req, res) => {
  try {
    const force = req.body && req.body.force === true;
    const hasil = await runArchiveJob({ force });
    const dipindah = hasil.filter(h => h.status === 'success');
    const totalBaris = dipindah.reduce((a, h) => a + h.rows, 0);
    res.json({
      success: true,
      message: dipindah.length === 0
        ? 'Tidak ada periode yang perlu dipindahkan.'
        : `${dipindah.length} periode dipindahkan (${totalBaris} baris) ke data_history_sales.`,
      detail: hasil
    });
  } catch (err) {
    console.error('Error Arsip Bulanan:', err);
    res.status(500).json({ success: false, message: 'Gagal menjalankan arsip: ' + err.message });
  }
});

// Riwayat job arsip
app.get('/api/archive-log', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await ensureArchiveLogTable(client);
      const r = await client.query(
        `SELECT periode_year, periode_month, rows_moved, status, message,
                TO_CHAR(created_at, 'DD/MM/YYYY HH24:MI') AS waktu
         FROM data_master_archive_log ORDER BY id DESC LIMIT 100`
      );
      res.json({ success: true, logs: r.rows });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function scheduleArchiveJob() {
  const jalankan = () => {
    console.log('[ARSIP] Menjalankan arsip bulanan...');
    runArchiveJob().catch(err => console.error('[ARSIP] Error:', err.message));
  };

  try {
    const cron = require('node-cron');
    cron.schedule(`0 ${ARCHIVE_HOUR} ${ARCHIVE_DAY} * *`, jalankan);
    console.log(`🗓️  Arsip bulanan dijadwalkan (node-cron): setiap tanggal ${ARCHIVE_DAY} jam ${ARCHIVE_HOUR}:00`);
    return;
  } catch (e) {
    // node-cron belum di-install -> pakai timer bawaan
  }

  let sudahJalanBulanIni = '';
  setInterval(() => {
    const now = new Date();
    const tag = `${now.getFullYear()}-${now.getMonth() + 1}`;
    if (now.getDate() === ARCHIVE_DAY && now.getHours() >= ARCHIVE_HOUR && sudahJalanBulanIni !== tag) {
      sudahJalanBulanIni = tag;
      jalankan();
    }
  }, 30 * 60 * 1000);
  console.log(`🗓️  Arsip bulanan dijadwalkan (timer internal): setiap tanggal ${ARCHIVE_DAY} jam ${ARCHIVE_HOUR}:00`);
}


const PORT = process.env.PORT || 3000;

function alamatJaringan() {
  const hasil = [];
  const nic = os.networkInterfaces();
  Object.keys(nic).forEach(nama => {
    (nic[nama] || []).forEach(i => {
      if (i.family === 'IPv4' && !i.internal) hasil.push({ nama, alamat: i.address });
    });
  });
  return hasil;
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log('🚀 Report AGPC berjalan pada port ' + PORT);
  console.log('   Dari komputer ini     : http://localhost:' + PORT);
  const ip = alamatJaringan();
  if (ip.length === 0) {
    console.log('   ⚠️  Tidak ada alamat IP jaringan yang terdeteksi.');
  } else {
    ip.forEach(x => console.log('   Dari komputer lain    : http://' + x.alamat + ':' + PORT + '   (' + x.nama + ')'));
    console.log('   Pastikan port ' + PORT + ' sudah diizinkan di Windows Firewall.');
  }
  console.log('');

  // Kalau PostgreSQL belum siap, halaman web tetap bisa dibuka dan pesannya jelas,
  // jadi server tidak mati begitu saja saat user lain sedang mencoba.
  try {
    await initDatabase();
    await siapkanStrukturRouteDanKunjungan();
    await siapkanTabelTargetProduct();
    await siapkanKolomSyncKunjungan();
    await siapkanLogSyncKunjungan();
    await perbaikiSemuaSequence();
    scheduleAutoSyncKunjungan();
    scheduleArchiveJob();
  } catch (err) {
    console.error('');
    console.error('❌ Gagal menyiapkan database: ' + err.message);
    console.error('   Halaman web tetap bisa dibuka, tetapi menu yang butuh data akan error.');
    console.error('   Periksa service PostgreSQL lalu jalankan ulang server.js.');
    console.error('');
  }
});

// Jangan biarkan satu error yang tidak tertangkap mematikan server
process.on('unhandledRejection', (err) => {
  console.error('[PERINGATAN] Promise gagal tanpa penanganan:', err && err.message ? err.message : err);
});