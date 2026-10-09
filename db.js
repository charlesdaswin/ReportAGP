// db.js
const { Pool } = require('pg');

// Konfigurasi koneksi database PostgreSQL
const pool = new Pool({
  user: 'postgres',           // Sesuaikan dengan user PostgreSQL Anda
  host: 'localhost',
  database: 'agpc_report_db', // Nama database Anda
  password: '12345',          // Password PostgreSQL Anda
  port: 5433,                 // Port PostgreSQL Anda
});

// Fungsi untuk membuat tabel otomatis saat server pertama kali berjalan
async function initDatabase() {
  const client = await pool.connect();
  try {
    console.log('Memeriksa dan menyiapkan struktur tabel database...');

    // 1. Tabel Users (Untuk Fitur Login)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tambahkan user admin default jika belum ada di tabel users
    await client.query(`
      INSERT INTO users (username, password, full_name, role)
      VALUES ('admin', 'admin123', 'Administrator AGP', 'admin')
      ON CONFLICT (username) DO NOTHING;
    `);

    // 2. Tabel Header Target Tahunan (Ditambahkan kolom divisi)
    await client.query(`
      CREATE TABLE IF NOT EXISTS annual_targets (
        id SERIAL PRIMARY KEY,
        divisi VARCHAR(20) NOT NULL DEFAULT 'AGPC',
        year INT NOT NULL,
        total_target DECIMAL(18,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Tabel Persentase Target Bulanan
    await client.query(`
      CREATE TABLE IF NOT EXISTS monthly_target_percentages (
        id SERIAL PRIMARY KEY,
        annual_target_id INT REFERENCES annual_targets(id) ON DELETE CASCADE,
        month INT NOT NULL,
        percentage DECIMAL(5,2) NOT NULL,
        nominal_value DECIMAL(18,2) NOT NULL
      );
    `);

    // 4. Tabel Persentase Divisi / Team (BJB & JJB)
    await client.query(`
      CREATE TABLE IF NOT EXISTS division_targets (
        id SERIAL PRIMARY KEY,
        annual_target_id INT REFERENCES annual_targets(id) ON DELETE CASCADE,
        division_code VARCHAR(10) NOT NULL,
        percentage DECIMAL(5,2) NOT NULL
      );
    `);

    // 5. Tabel Area Target
    await client.query(`
      CREATE TABLE IF NOT EXISTS area_targets (
        id SERIAL PRIMARY KEY,
        annual_target_id INT REFERENCES annual_targets(id) ON DELETE CASCADE,
        division_code VARCHAR(10) NOT NULL,
        area_code VARCHAR(20) NOT NULL,
        area_name VARCHAR(100) NOT NULL,
        percentage DECIMAL(5,2) NOT NULL
      );
    `);

    // 6. Tabel Sales Kunjungan (K01 - K06)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_kunjungan_targets (
        id SERIAL PRIMARY KEY,
        area_target_id INT REFERENCES area_targets(id) ON DELETE CASCADE,
        kunjungan_code VARCHAR(10) NOT NULL,
        percentage DECIMAL(5,2) NOT NULL
      );
    `);

    // 7. Tabel Change Log (Ditambahkan kolom divisi)
    await client.query(`
      CREATE TABLE IF NOT EXISTS area_change_logs (
        id SERIAL PRIMARY KEY,
        divisi VARCHAR(20) NOT NULL DEFAULT 'AGPC',
        year INT NOT NULL,
        division_code VARCHAR(10) NOT NULL,
        area_code VARCHAR(20) NOT NULL,
        old_name VARCHAR(100),
        new_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ Semua tabel database (termasuk Users & Divisi) siap digunakan!');
  } catch (err) {
    console.error('❌ Gagal inisialisasi tabel:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDatabase };