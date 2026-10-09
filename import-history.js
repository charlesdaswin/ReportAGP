const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('./db');

async function importHistory() {
  const filePath = path.join(__dirname, 'HISTORY JAN-SEP 2026 FIX.xlsx');
  
  if (!fs.existsSync(filePath)) {
    console.error('❌ File Excel tidak ditemukan! Pastikan ditaruh di folder proyek.');
    return;
  }

  console.log('📖 Membaca file Excel history, harap tunggu...');
  // raw: true agar nilai Date/String dibaca secara murni tanpa pergeseran Timezone
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawData = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  console.log(`📊 Total baris dibaca dari Excel: ${rawData.length}`);

  const client = await pool.connect();

  try {
    const cleanStr = (val, maxLen = 250) => {
      if (val === null || val === undefined) return '';
      return String(val).trim().substring(0, maxLen);
    };

    // 1. Dapatkan Mapping Rute Salesman
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

    await client.query('BEGIN');

    // 2. Kosongkan tabel & Reset ID
    await client.query('TRUNCATE TABLE data_history_sales RESTART IDENTITY;');
    console.log('🧹 Tabel data_history_sales telah dibersihkan.');

    const BATCH_SIZE = 1000;
    let batchValues = [];
    let processedCount = 0;

    // Helper Parsing Tanggal Kuat (Handled Date String & Serial Excel)
    const parseDate = (val) => {
      if (!val) return null;
      const str = String(val).trim();

      // Format DD/MM/YYYY atau DD-MM-YYYY
      if (str.includes('/') || str.includes('-')) {
        const parts = str.split(/[\/\-]/);
        if (parts.length === 3) {
          let p0 = parts[0].padStart(2, '0');
          let p1 = parts[1].padStart(2, '0');
          let p2 = parts[2];

          if (p2.length === 4) return `${p2}-${p1}-${p0}`;
          if (p0.length === 4) return `${p0}-${p1}-${p2}`;
        }
      }

      // Serial Number Excel (misal: 46023)
      const num = Number(val);
      if (!isNaN(num) && num > 30000 && num < 60000) {
        const parsedDate = new Date((num - (25567 + 2)) * 86400 * 1000);
        if (!isNaN(parsedDate.getTime())) {
          const y = parsedDate.getFullYear();
          const m = String(parsedDate.getMonth() + 1).padStart(2, '0');
          const d = String(parsedDate.getDate()).padStart(2, '0');
          return `${y}-${m}-${d}`;
        }
      }

      return null;
    };

    // Helper Format Month menjadi Bulan-Tahun (misal: "Jan-26", "Agu-26")
    const formatMonthName = (val, tanggalStr) => {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'];

      // Jika Tanggal Valid Ada -> Ambil Bulan & Tahun dari Tanggal
      if (tanggalStr) {
        const parts = tanggalStr.split('-');
        if (parts.length === 3) {
          const mIdx = parseInt(parts[1], 10) - 1;
          const yr = parts[0].slice(-2);
          if (mIdx >= 0 && mIdx < 12) return `${monthNames[mIdx]}-${yr}`;
        }
      }

      return '-';
    };

    for (let i = 0; i < rawData.length; i++) {
      const row = rawData[i];

      const rawMonth     = row['Month'];
      const namaDivisi   = cleanStr(row['Divisi'], 90);
      let excelKodeArea  = cleanStr(row['Kode Area'], 90);
      let excelArea      = cleanStr(row['Area'], 240);
      const kodeSalesman = cleanStr(row['Kode Salesman'], 90);
      const namaSalesman = cleanStr(row['Nama Salesman'], 240);
      const namaPasar    = cleanStr(row['Nama Pasar'], 240);
      const kodeCustomer = cleanStr(row['Kode Customer'], 90);
      const namaCustomer = cleanStr(row['Nama Customer'], 240);
      const kodeBarang   = cleanStr(row['Kode Barang'], 240);
      const namaBarang   = cleanStr(row['Nama Barang'], 240);
      const noTransaksi  = cleanStr(row['No Transaksi'], 240);
      const tanggal      = parseDate(row['Tanggal']);
      const kodeKunj     = cleanStr(row['Kode Kunjungan'] || '-', 90);
      const qtyCrt       = Math.round(Number(row['Qty (Crt)']) || 0);
      const dppRp        = Number(row['DPP (Rp)']) || 0;

      // Format Month Ke "Bulan-Tahun"
      const monthFormatted = formatMonthName(rawMonth, tanggal);

      // Auto Mapping Area jika Kosong
      let finalKodeArea = excelKodeArea;
      let finalArea = excelArea;

      const matchedRoute = routeMap[kodeSalesman.toLowerCase()];
      if (matchedRoute) {
        if (!finalKodeArea) finalKodeArea = matchedRoute.kode_area;
        if (!finalArea) finalArea = matchedRoute.area;
      }

      if (!finalKodeArea) finalKodeArea = 'KTR';
      if (!finalArea) finalArea = 'KANTOR';

      batchValues.push([
        monthFormatted, namaDivisi, finalKodeArea, finalArea,
        kodeSalesman, namaSalesman, namaPasar, kodeCustomer,
        namaCustomer, kodeBarang, namaBarang, noTransaksi,
        tanggal, kodeKunj, qtyCrt, dppRp
      ]);

      // Push Batch Setiap 1000 baris ATAU di Baris Terakhir
      if (batchValues.length === BATCH_SIZE || i === rawData.length - 1) {
        let valueStrings = [];
        let params = [];
        let paramIdx = 1;

        batchValues.forEach(r => {
          valueStrings.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7}, $${paramIdx+8}, $${paramIdx+9}, $${paramIdx+10}, $${paramIdx+11}, $${paramIdx+12}, $${paramIdx+13}, $${paramIdx+14}, $${paramIdx+15})`);
          params.push(...r);
          paramIdx += 16;
        });

        const insertQuery = `
          INSERT INTO data_history_sales 
          (month, nama_divisi, kode_area, area, kode_salesman, nama_salesman, nama_pasar, kode_customer, nama_customer, kode_barang, nama_barang, no_transaksi, tanggal, kode_kunjungan, qty_crt, dpp_rp)
          VALUES ${valueStrings.join(', ')}
        `;

        await client.query(insertQuery, params);
        processedCount += batchValues.length;
        console.log(`🚀 Terinsert: ${processedCount} / ${rawData.length} baris...`);
        batchValues = [];
      }
    }

    await client.query('COMMIT');
    console.log(`✅ SUKSES LENGKAP! Total ${processedCount} data History Transaksi berhasil masuk sempurna.`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error Import History:', err);
  } finally {
    client.release();
    process.exit();
  }
}

importHistory();