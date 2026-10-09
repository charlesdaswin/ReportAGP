/* =========================================================================
 * update-history-from-excel.js
 * Memperbarui data yang KOSONG atau bertanda "-" di tabel data_history_sales
 * berdasarkan isi file Excel Master Sales. Tidak menghapus dan tidak menambah baris.
 *
 * Cara pakai (jalankan di folder yang sama dengan server.js dan db.js):
 *   node update-history-from-excel.js "D:\\Report AGPC\\Omset SEPT.xlsx"
 *   node update-history-from-excel.js file1.xlsx file2.xlsx
 *
 * Opsi:
 *   --dry-run        hanya menampilkan rencana perubahan, TIDAK menulis ke database
 *   --overwrite      timpa kode_kunjungan walau sudah terisi (kolom lain tetap hanya yang kosong)
 *   --with-master    ikut memperbarui data_master_sales
 *   --from=2026-09-01 --to=2026-09-30   batasi hanya pada rentang tanggal tertentu
 * ========================================================================= */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('./db');

// ---------- argumen ----------
const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const files = argv.filter(a => !a.startsWith('--'));
const punyaFlag = (n) => flags.includes(n);
const nilaiFlag = (n) => {
  const f = flags.find(x => x.startsWith(n + '='));
  return f ? f.split('=')[1] : null;
};

const DRY_RUN = punyaFlag('--dry-run');
const OVERWRITE = punyaFlag('--overwrite');
const WITH_MASTER = punyaFlag('--with-master');
const FROM = nilaiFlag('--from');
const TO = nilaiFlag('--to');

if (files.length === 0) {
  console.error('\nCara pakai: node update-history-from-excel.js "path\\file.xlsx" [--dry-run] [--overwrite] [--with-master]\n');
  process.exit(1);
}

const TABEL = ['data_history_sales'];
if (WITH_MASTER) TABEL.push('data_master_sales');

// Kolom yang nilainya sama untuk seluruh baris dalam satu No Transaksi.
// Kode Barang / Nama Barang / Qty / DPP TIDAK disentuh karena berbeda tiap baris.
const KOLOM_ISI = [
  'kode_kunjungan', 'nama_divisi', 'kode_salesman', 'nama_salesman',
  'nama_pasar', 'kode_customer', 'nama_customer'
];

const normKunj = (v) => {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^K0*(\d+)$/);
  return m ? 'K' + String(parseInt(m[1], 10)).padStart(2, '0') : s;
};
const kosong = (v) => {
  const t = String(v == null ? '' : v).trim();
  return t === '' || t === '-';
};
const angka = (n) => Number(n || 0).toLocaleString('id-ID');

// =========================================================================
// PARSER EXCEL
// Mendukung 2 bentuk file:
//  A. Tabel rapi berheader (Nama Divisi | Kode Salesman | ... | DPP (Rp))  <- file "FINAL"
//  B. Format lama bercolumn lebar (dipakai menu Upload Data Master)
// =========================================================================

function parseTanggal(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const str = String(val).trim();
  if (!str || str.length > 20 || str.toLowerCase().includes('total')) return null;

  const bulan = {
    jan: '01', feb: '02', mar: '03', apr: '04', mei: '05', may: '05',
    jun: '06', jul: '07', ags: '08', aug: '08', sep: '09', okt: '10',
    oct: '10', nov: '11', des: '12', dec: '12'
  };

  if (str.includes('/') || str.includes('-')) {
    const p = str.split(/[\/\-]/);
    if (p.length === 3) {
      let p0 = p[0].trim(), p1 = p[1].trim().toLowerCase(), p2 = p[2].trim();
      p1 = bulan[p1.substring(0, 3)] || p1.padStart(2, '0');
      if (/^\d+$/.test(p0) && /^\d+$/.test(p1) && /^\d+$/.test(p2)) {
        if (p0.length === 4) return `${p0}-${p1}-${p2.padStart(2, '0')}`;
        if (p2.length === 4) return `${p2}-${p1}-${p0.padStart(2, '0')}`;
        if (p2.length === 2) return `20${p2}-${p1}-${p0.padStart(2, '0')}`;
      }
    }
  }

  const n = Number(val);
  if (!isNaN(n) && n > 30000 && n < 60000) {
    const d = new Date((n - (25567 + 2)) * 86400 * 1000);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  return null;
}

function parseAngka(item) {
  if (item === '' || item === null || item === undefined) return null;
  if (typeof item === 'number') return isNaN(item) ? null : item;

  let s = String(item).trim();
  if (!s) return null;
  if (s.includes('/')) return null;
  if (/^\d{1,4}-\d{1,2}-\d{1,4}$/.test(s)) return null;

  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (/^[-\u2212\u2013]/.test(s)) { neg = true; s = s.slice(1).trim(); }
  if (/[-\u2212\u2013]$/.test(s)) { neg = true; s = s.slice(0, -1).trim(); }
  if (s.includes('-')) return null;

  s = s.replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  if (s === '') return null;

  const n = Number(s);
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

// Nama kolom yang dikenali (huruf kecil, tanpa karakter selain huruf/angka)
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

// --- Bentuk A: tabel rapi berheader ---
function parseBerheader(rawData) {
  let barisHeader = -1;
  let petaKolom = null;

  for (let i = 0; i < Math.min(rawData.length, 20); i++) {
    const row = rawData[i];
    if (!row || row.length === 0) continue;

    const peta = {};
    row.forEach((cell, idx) => {
      const nama = ALIAS_KOLOM[bersihkanLabel(cell)];
      if (nama && peta[nama] === undefined) peta[nama] = idx;
    });

    if (peta.no_transaksi !== undefined && peta.tanggal !== undefined && peta.dpp_rp !== undefined) {
      barisHeader = i;
      petaKolom = peta;
      break;
    }
  }

  if (barisHeader === -1) return null;

  const hasil = [];
  for (let i = barisHeader + 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || row.length === 0) continue;

    const ambil = (k) => (petaKolom[k] === undefined ? '' : String(row[petaKolom[k]] == null ? '' : row[petaKolom[k]]).trim());

    const tanggal = parseTanggal(row[petaKolom.tanggal]);
    const noTrx = ambil('no_transaksi');
    if (!tanggal || !noTrx) continue;

    const teksBaris = row.join(' ').toLowerCase();
    if (teksBaris.includes('grand total')) continue;

    let dpp = parseAngka(row[petaKolom.dpp_rp]) || 0;
    const qty = petaKolom.qty_crt !== undefined ? Math.round(parseAngka(row[petaKolom.qty_crt]) || 0) : 0;
    if (/^RJ/i.test(noTrx) && dpp > 0) dpp = -dpp;   // retur harus minus

    hasil.push({
      nama_divisi: ambil('nama_divisi'),
      kode_salesman: ambil('kode_salesman'),
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
      dpp_rp: dpp
    });
  }
  return hasil;
}

// --- Bentuk B: format lama bercolumn lebar ---
function parseFormatLama(rawData) {
  let iKodeSales = -1, iNamaSales = -1, iNamaPasar = -1, iKodeCust = -1,
      iNamaCust = -1, iKodeBrg = -1, iNamaBrg = -1, iNoTrx = -1;

  for (let r = 0; r < Math.min(rawData.length, 10); r++) {
    const row = rawData[r];
    if (!row) continue;
    row.forEach((cell, idx) => {
      const t = bersihkanLabel(cell);
      if (t === 'kodesalesman') iKodeSales = idx;
      if (t === 'namasalesman') iNamaSales = idx;
      if (t === 'namapasar') iNamaPasar = idx;
      if (t === 'kodecustomer' || t === 'kodecust') iKodeCust = idx;
      if (t === 'namacustomer' || t === 'namacust') iNamaCust = idx;
      if (t === 'kodebarang') iKodeBrg = idx;
      if (t === 'namabarang') iNamaBrg = idx;
      if (t === 'notransaksi') iNoTrx = idx;
    });
  }
  if (iKodeSales === -1) iKodeSales = 4;
  if (iNamaSales === -1) iNamaSales = 8;
  if (iNamaPasar === -1) iNamaPasar = 12;
  if (iKodeCust === -1) iKodeCust = 16;
  if (iNamaCust === -1) iNamaCust = 20;
  if (iKodeBrg === -1) iKodeBrg = 24;
  if (iNamaBrg === -1) iNamaBrg = 28;
  if (iNoTrx === -1) iNoTrx = 36;

  const hasil = [];
  let divisi = 'AGPC', kodeSales = '', namaSales = '', namaPasar = '',
      kodeCust = '', namaCust = '', kodeBrg = '', namaBrg = '';

  for (let i = 7; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || row.length === 0) continue;

    const teks = row.join(' ').toLowerCase();
    if (teks.includes('total') || teks.includes('jenis transaksi') || teks.includes('nama barang')) {
      if (teks.includes('total')) { kodeBrg = ''; namaBrg = ''; }
      continue;
    }

    const val = (idx) => (row[idx] ? String(row[idx]).trim() : '');
    if (val(0) || val(1)) divisi = val(0) || val(1);
    if (val(iKodeSales)) kodeSales = val(iKodeSales);
    if (val(iNamaSales)) namaSales = val(iNamaSales);
    if (val(iNamaPasar)) namaPasar = val(iNamaPasar);
    if (val(iKodeCust)) kodeCust = val(iKodeCust);
    if (val(iNamaCust)) namaCust = val(iNamaCust);
    if (val(iKodeBrg)) kodeBrg = val(iKodeBrg);
    if (val(iNamaBrg) && !parseTanggal(val(iNamaBrg))) namaBrg = val(iNamaBrg);

    let tanggal = null, kunjungan = '';
    for (let c = 25; c < row.length; c++) {
      if (!row[c]) continue;
      const cek = parseTanggal(row[c]);
      if (cek) {
        tanggal = cek;
        if (row[c + 4]) kunjungan = String(row[c + 4]).trim();
        else if (row[c + 1] && String(row[c + 1]).startsWith('K')) kunjungan = String(row[c + 1]).trim();
        break;
      }
    }
    if (!tanggal) continue;

    const angkaBaris = [];
    for (let c = row.length - 1; c >= 30; c--) {
      const n = parseAngka(row[c]);
      if (n !== null) angkaBaris.push(n);
    }
    let dpp = angkaBaris.length >= 1 ? angkaBaris[0] : 0;
    const qty = angkaBaris.length >= 2 ? Math.round(angkaBaris[1]) : 0;
    const noTrx = val(iNoTrx) || '-';
    if (/^RJ/i.test(noTrx) && dpp > 0) dpp = -dpp;

    hasil.push({
      nama_divisi: divisi, kode_salesman: kodeSales, nama_salesman: namaSales,
      nama_pasar: namaPasar, kode_customer: kodeCust, nama_customer: namaCust,
      kode_barang: kodeBrg || '-', nama_barang: namaBrg || '-',
      no_transaksi: noTrx, tanggal: tanggal,
      kode_kunjungan: kunjungan || '-', qty_crt: qty, dpp_rp: dpp
    });
  }
  return hasil;
}

function bacaFileExcel(buffer, namaFile) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const semua = [];

  for (const namaSheet of wb.SheetNames) {
    const rawData = XLSX.utils.sheet_to_json(wb.Sheets[namaSheet], { header: 1, defval: '' });
    if (rawData.length === 0) continue;

    let rows = parseBerheader(rawData);
    let bentuk = 'tabel berheader';
    if (!rows || rows.length === 0) {
      rows = parseFormatLama(rawData);
      bentuk = 'format lama';
    }
    if (rows && rows.length > 0) {
      console.log(`   sheet "${namaSheet}": ${rows.length} baris (${bentuk})`);
      semua.push(...rows);
    } else {
      console.log(`   sheet "${namaSheet}": 0 baris, dilewati`);
    }
  }
  return semua;
}


// ---------- proses utama ----------
(async () => {
  const mulai = Date.now();
  console.log('\n=== UPDATE DATA DARI EXCEL -> ' + TABEL.join(' + ') + ' ===');
  if (DRY_RUN) console.log('MODE UJI COBA (--dry-run): tidak ada data yang ditulis.\n');

  const client = await pool.connect();
  try {
    // Baca semua file Excel
    const fileObjs = [];
    for (const f of files) {
      const p = path.resolve(f);
      if (!fs.existsSync(p)) {
        console.error('File tidak ditemukan: ' + p);
        process.exit(1);
      }
      console.log('Membaca: ' + p);
      fileObjs.push({ buffer: fs.readFileSync(p), nama: path.basename(p) });
    }

    let rows = [];
    for (const fo of fileObjs) rows = rows.concat(bacaFileExcel(fo.buffer, fo.nama));
    console.log('Baris transaksi terbaca dari Excel: ' + angka(rows.length));
    if (rows.length === 0) {
      console.error('Tidak ada baris transaksi valid. Periksa format file Excel.');
      process.exit(1);
    }

    // Kumpulkan nilai per No Transaksi per kolom
    const perTrx = new Map();
    let tanpaKunjungan = 0;
    rows.forEach(r => {
      const noTrx = String(r.no_transaksi || '').trim().toUpperCase();
      if (!noTrx || noTrx === '-') return;
      if (!perTrx.has(noTrx)) perTrx.set(noTrx, {});
      const b = perTrx.get(noTrx);

      KOLOM_ISI.forEach(kol => {
        let nilai = r[kol];
        if (kol === 'kode_kunjungan') {
          const k = normKunj(nilai);
          nilai = /^K0[1-6]$/.test(k) ? k : null;
        }
        if (nilai == null || kosong(nilai)) return;
        if (!b[kol]) b[kol] = new Set();
        b[kol].add(String(nilai).trim());
      });

      if (!/^K0[1-6]$/.test(normKunj(r.kode_kunjungan))) tanpaKunjungan++;
    });

    console.log('No Transaksi unik: ' + angka(perTrx.size));
    if (tanpaKunjungan > 0) console.log('Baris Excel tanpa kode kunjungan: ' + angka(tanpaKunjungan));
    if (perTrx.size === 0) {
      console.error('Tidak ada No Transaksi yang terbaca.');
      process.exit(1);
    }

    const syaratTanggal = (FROM && TO) ? ' AND t.tanggal BETWEEN $3::date AND $4::date' : '';
    const paramTanggal = (FROM && TO) ? [FROM, TO] : [];
    if (syaratTanggal) console.log('Dibatasi tanggal: ' + FROM + ' s/d ' + TO);

    await client.query('BEGIN');

    const ringkasan = [];
    for (const kol of KOLOM_ISI) {
      const daftarTrx = [];
      const daftarNilai = [];
      let tidakKonsisten = 0;

      perTrx.forEach((b, noTrx) => {
        const set = b[kol];
        if (!set) return;
        if (set.size > 1) { tidakKonsisten++; return; }
        daftarTrx.push(noTrx);
        daftarNilai.push(Array.from(set)[0]);
      });

      if (daftarTrx.length === 0) {
        ringkasan.push({ kolom: kol, data_history_sales: 0, data_master_sales: 0, tidak_konsisten: tidakKonsisten });
        continue;
      }

      const bolehTimpa = (kol === 'kode_kunjungan') && OVERWRITE;
      const syaratKosong = bolehTimpa ? '' : `AND (t.${kol} IS NULL OR TRIM(t.${kol}) IN ('', '-'))`;

      const baris = { kolom: kol, tidak_konsisten: tidakKonsisten };
      for (const tabel of TABEL) {
        const sql = DRY_RUN
          ? `SELECT COUNT(*)::int AS n
             FROM ${tabel} t
             JOIN (SELECT UNNEST($1::text[]) AS notrx, UNNEST($2::text[]) AS nilai) v
               ON UPPER(TRIM(t.no_transaksi)) = v.notrx
             WHERE COALESCE(TRIM(t.${kol}), '') IS DISTINCT FROM v.nilai
               ${syaratKosong} ${syaratTanggal}`
          : `UPDATE ${tabel} t
             SET ${kol} = v.nilai
             FROM (SELECT UNNEST($1::text[]) AS notrx, UNNEST($2::text[]) AS nilai) v
             WHERE UPPER(TRIM(t.no_transaksi)) = v.notrx
               AND COALESCE(TRIM(t.${kol}), '') IS DISTINCT FROM v.nilai
               ${syaratKosong} ${syaratTanggal}`;

        const res = await client.query(sql, [daftarTrx, daftarNilai, ...paramTanggal]);
        baris[tabel] = DRY_RUN ? (res.rows[0] ? res.rows[0].n : 0) : res.rowCount;
      }
      ringkasan.push(baris);
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    console.log('\n--- RINGKASAN ' + (DRY_RUN ? '(RENCANA, belum ditulis)' : '(SUDAH DITULIS)') + ' ---');
    console.table(ringkasan);

    const total = {};
    TABEL.forEach(t => { total[t] = ringkasan.reduce((a, r) => a + (r[t] || 0), 0); });
    TABEL.forEach(t => console.log('Total baris ' + (DRY_RUN ? 'akan diubah' : 'diubah') + ' di ' + t + ': ' + angka(total[t])));
    console.log('Selesai dalam ' + ((Date.now() - mulai) / 1000).toFixed(1) + ' detik.');
    if (DRY_RUN) console.log('\nJalankan ulang TANPA --dry-run untuk benar-benar menyimpan perubahan.');

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('\nGAGAL: ' + err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
