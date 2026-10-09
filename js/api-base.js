/* ---------------------------------------------------------------------------
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
  var LOKAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i;

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
