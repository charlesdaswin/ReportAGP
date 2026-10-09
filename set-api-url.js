/**
 * set-api-url.js
 * -----------------------------------------------------------------------
 * Menyiapkan semua halaman .html supaya bisa dibuka dari komputer lain
 * satu jaringan lewat http://<IP-server>:3000
 *
 * Cara kerjanya: script ini TIDAK mengubah kode halaman sama sekali.
 * Ia hanya:
 *   1. membuat file  js/api-base.js
 *   2. menyisipkan satu baris <script src="js/api-base.js"> di dalam <head>
 *
 * js/api-base.js itulah yang mengalihkan setiap panggilan ke
 * localhost:3000 menjadi alamat yang sedang dibuka di browser.
 * Jadi baris seperti  const API = 'http://localhost:3000'  atau
 * fetch('http://localhost:3000/api/login')  tetap dibiarkan apa adanya
 * dan tetap berfungsi, termasuk kalau halaman dibuka lewat file://
 *
 * Cara pakai (dari folder D:\Report AGPC):
 *     node set-api-url.js --dry-run     <- lihat dulu apa yang akan dikerjakan
 *     node set-api-url.js               <- kerjakan (backup .bak otomatis)
 *     node set-api-url.js --undo        <- kembalikan seperti semula
 *
 * Cukup dijalankan SEKALI. Aman kalau terlanjur dijalankan dua kali.
 * -----------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const undo = argv.includes('--undo');
const folder = process.cwd();

const NAMA_JS = path.join('js', 'api-base.js');
const PENANDA = 'api-base.js';

const ISI_API_BASE = `/* ---------------------------------------------------------------------------
 * api-base.js  -  dibuat otomatis oleh set-api-url.js
 * ---------------------------------------------------------------------------
 * Mengalihkan panggilan ke localhost:3000 / 127.0.0.1:3000 menjadi alamat
 * yang sedang dibuka di browser, supaya halaman bisa dipakai dari komputer
 * lain satu jaringan tanpa mengubah kode halaman.
 *
 *   dibuka http://192.168.0.45:3000 -> panggilan ikut ke 192.168.0.45:3000
 *   dibuka http://localhost:3000    -> tetap localhost
 *   dibuka file:///D:/...           -> tetap localhost (seperti sebelumnya)
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  if (String(location.protocol).indexOf('http') !== 0) {
    window.API_BASE = 'http://localhost:3000';
    return;
  }

  var ASAL = location.origin;
  var LOKAL = /^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?/i;

  window.API_BASE = ASAL;

  function alihkan(url) {
    try {
      if (typeof url === 'string' && LOKAL.test(url)) return url.replace(LOKAL, ASAL);
      if (url && typeof url === 'object' && typeof url.href === 'string' && LOKAL.test(url.href)) {
        return url.href.replace(LOKAL, ASAL);
      }
    } catch (e) { /* biarkan apa adanya */ }
    return url;
  }

  if (typeof window.fetch === 'function') {
    var fetchAsli = window.fetch;
    window.fetch = function (masukan, opsi) {
      if (typeof masukan === 'string' || (masukan && typeof masukan.href === 'string')) {
        masukan = alihkan(masukan);
      } else if (masukan && typeof masukan.url === 'string' && LOKAL.test(masukan.url)) {
        try { masukan = new Request(alihkan(masukan.url), masukan); } catch (e) { /* lewati */ }
      }
      return fetchAsli.call(this, masukan, opsi);
    };
  }

  if (window.XMLHttpRequest && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open) {
    var openAsli = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      if (arguments.length > 1) arguments[1] = alihkan(arguments[1]);
      return openAsli.apply(this, arguments);
    };
  }
})();
`;

function daftarHtml(dir, hasil = []) {
  for (const nama of fs.readdirSync(dir)) {
    if (nama === 'node_modules' || nama.startsWith('.')) continue;
    const penuh = path.join(dir, nama);
    let st;
    try { st = fs.statSync(penuh); } catch (e) { continue; }
    if (st.isDirectory()) daftarHtml(penuh, hasil);
    else if (/\.html?$/i.test(nama)) hasil.push(penuh);
  }
  return hasil;
}

console.log('Folder  :', folder);
console.log('Mode    :', undo ? 'UNDO (kembalikan seperti semula)' : dryRun ? 'DRY-RUN (tidak menulis apa pun)' : 'PASANG');
console.log('');

const berkas = daftarHtml(folder);
if (berkas.length === 0) {
  console.log('Tidak ada file .html di folder ini.');
  console.log('Jalankan dari folder aplikasi, contoh:  cd /d "D:\\Report AGPC"');
  process.exit(1);
}

// ---------------------------------------------------------------- js/api-base.js
const targetJs = path.join(folder, NAMA_JS);
if (undo) {
  if (fs.existsSync(targetJs)) {
    if (!dryRun) fs.unlinkSync(targetJs);
    console.log('  dihapus      :', NAMA_JS);
  }
} else {
  const sudahSama = fs.existsSync(targetJs) && fs.readFileSync(targetJs, 'utf8') === ISI_API_BASE;
  if (sudahSama) {
    console.log('  sudah ada    :', NAMA_JS);
  } else {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetJs), { recursive: true });
      fs.writeFileSync(targetJs, ISI_API_BASE);
    }
    console.log('  dibuat       :', NAMA_JS);
  }
}

// ---------------------------------------------------------------- file .html
let dipasang = 0, dilewati = 0, galat = 0;

for (const f of berkas) {
  const nama = path.relative(folder, f);
  try {
    if (undo) {
      const bak = f + '.bak';
      if (!fs.existsSync(bak)) { dilewati++; continue; }
      if (!dryRun) { fs.copyFileSync(bak, f); fs.unlinkSync(bak); }
      console.log('  dikembalikan :', nama);
      dipasang++;
      continue;
    }

    const isi = fs.readFileSync(f, 'utf8');

    if (isi.includes(PENANDA)) {
      console.log('  sudah siap   :', nama);
      dilewati++;
      continue;
    }

    // Path relatif dari lokasi file .html menuju js/api-base.js
    const relJs = path
      .relative(path.dirname(f), targetJs)
      .split(path.sep).join('/');
    const tag = `<script src="${relJs}"></script>`;

    // Sisipkan tepat setelah <head ...>
    const cocok = isi.match(/<head\b[^>]*>/i);
    let baru;
    if (cocok) {
      const pos = isi.indexOf(cocok[0]) + cocok[0].length;
      baru = isi.slice(0, pos) + '\n  ' + tag + isi.slice(pos);
    } else if (/<html\b[^>]*>/i.test(isi)) {
      // Halaman tanpa <head> -> taruh setelah <html>
      const m = isi.match(/<html\b[^>]*>/i);
      const pos = isi.indexOf(m[0]) + m[0].length;
      baru = isi.slice(0, pos) + '\n' + tag + isi.slice(pos);
    } else {
      baru = tag + '\n' + isi;
    }

    if (!dryRun) {
      // Backup selalu ditimpa dengan isi TERBARU sebelum disisipi, supaya
      // --undo mengembalikan versi yang sekarang, bukan versi lama.
      fs.writeFileSync(f + '.bak', isi);
      fs.writeFileSync(f, baru);
    }
    console.log('  dipasang     :', nama);
    dipasang++;
  } catch (err) {
    console.log('  GAGAL        :', nama, '-', err.message);
    galat++;
  }
}

console.log('');
console.log(`Selesai. ${dipasang} file ${undo ? 'dikembalikan' : dryRun ? 'akan dipasang' : 'dipasang'}, ` +
            `${dilewati} dilewati, ${galat} gagal.`);
if (!undo && !dryRun && dipasang > 0) {
  console.log('Isi halaman tidak diubah, hanya ditambah 1 baris <script> di dalam <head>.');
  console.log('Backup asli disimpan berakhiran .bak  (batalkan: node set-api-url.js --undo)');
}
