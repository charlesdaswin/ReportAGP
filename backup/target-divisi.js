const currentDivisi = window.PAGE_DIVISI || 'AGPC';
const currentYear = new Date().getFullYear();

const months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const kunjunganCodes = ["K01", "K02", "K03", "K04", "K05", "K06"];

function getAreaCodes(divisi, type) {
  const cleanDiv = divisi.replace(/\s+/g, '');
  return [1, 2, 3, 4, 5].map(num => `${cleanDiv}-${type}-0${num}`);
}

window.onload = function() {
  const subTarget = document.getElementById('submenu-target');
  const arrowTarget = document.getElementById('arrow-target');
  if (subTarget && arrowTarget) {
    subTarget.classList.add('open');
    arrowTarget.classList.add('rotate');
  }

  initDivisiPage();
};

function initDivisiPage() {
  const labelDiv = currentDivisi === 'AGPN' ? 'AGP N' : currentDivisi;
  document.getElementById('page-header-title').innerText = `TARGET DIVISI ${labelDiv} ${currentYear}`;
  document.getElementById('label-target').innerText = `TARGET ${currentYear} :`;
  document.getElementById('title-team-bjb').innerText = `Team ${labelDiv} BJB`;
  document.getElementById('title-team-jjb').innerText = `Team ${labelDiv} JJB`;
  document.getElementById('title-sales-bjb').innerText = `Target Team Sales ${labelDiv} BJB ${currentYear}`;
  document.getElementById('title-sales-jjb').innerText = `Target Team Sales ${labelDiv} JJB ${currentYear}`;

  // Tambahkan ID dinamis id="month-pct-${i}" agar mudah diisi oleh loadHistoryData()
  let monthHtml = '';
  months.forEach((m, i) => {
    monthHtml += `<div><label>${m} (%)</label><input type="number" id="month-pct-${i}" class="input-month" placeholder="%" oninput="updateLivePreviews()"></div>`;
  });
  document.getElementById('monthly-inputs').innerHTML = monthHtml;

  const bjbCodes = getAreaCodes(currentDivisi, 'BJB');
  const jjbCodes = getAreaCodes(currentDivisi, 'JJB');

  renderSalesInputsPerArea('inputs-sales-bjb', bjbCodes, 'sales-bjb');
  renderSalesInputsPerArea('inputs-sales-jjb', jjbCodes, 'sales-jjb');

  renderTeamInputs('inputs-team-bjb', bjbCodes, 'bjb');
  renderTeamInputs('inputs-team-jjb', jjbCodes, 'jjb');

  attachRealtimeAreaNameSync(bjbCodes, jjbCodes);
  loadAutoFillAreaNames(bjbCodes, jjbCodes);
}

function renderTeamInputs(containerId, codes, prefix) {
  let html = '';
  codes.forEach((code, i) => {
    html += `<div class="area-input-row">
      <span class="area-code-label">${code}</span>
      <input type="text" class="area-input-name" id="${prefix}-area-name-${i}" data-prefix="${prefix}" data-index="${i}" placeholder="Nama Area">
      <input type="number" class="area-input-pct ${prefix}-area-pct-input" id="${prefix}-area-pct-${i}" placeholder="%" oninput="updateLivePreviews()">
      <button class="btn-edit-pencil" onclick="enableAreaEdit('${prefix}-area-name-${i}')" title="Edit Nama Area">✏️</button>
    </div>`;
  });
  document.getElementById(containerId).innerHTML = html;
}

function attachRealtimeAreaNameSync(bjbCodes, jjbCodes) {
  document.querySelectorAll('.area-input-name').forEach(input => {
    ['input', 'keyup', 'change'].forEach(evtType => {
      input.addEventListener(evtType, function() {
        const prefix = this.getAttribute('data-prefix');
        const index = this.getAttribute('data-index');
        syncAreaNamesToSales(prefix, index, bjbCodes, jjbCodes);
      });
    });
  });
}

function enableAreaEdit(inputId) {
  const input = document.getElementById(inputId);
  input.disabled = false;
  input.focus();
}

function syncAreaNamesToSales(prefix, index, bjbCodes, jjbCodes) {
  const inputEl = document.getElementById(`${prefix}-area-name-${index}`);
  const nameVal = (inputEl && inputEl.value.trim() !== "") ? inputEl.value.trim() : "Area belum diisi";
  
  const salesPrefix = prefix === 'bjb' ? 'sales-bjb' : 'sales-jjb';
  const targetTitleEl = document.getElementById(`${salesPrefix}-sales-title-${index}`);
  
  if (targetTitleEl) {
    const codes = prefix === 'bjb' ? bjbCodes : jjbCodes;
    targetTitleEl.innerText = `${codes[index]}: ${nameVal}`;
  }
}

function renderSalesInputsPerArea(containerId, codes, prefix) {
  let html = '';
  codes.forEach((code, i) => {
    html += `<div class="sales-area-box">
      <div class="sales-area-header">
        <span class="sales-area-title" id="${prefix}-sales-title-${i}">${code}: Area belum diisi</span>
        <span class="pct-preview-badge" id="${prefix}-sales-area-preview-${i}">Total: 0%</span>
      </div>
      <div class="grid-kunjungan">`;
    
    kunjunganCodes.forEach((kCode, kIdx) => {
      html += `<div class="kunjungan-item">
        <label>${kCode} (%)</label>
        <input type="number" id="${prefix}-area-${i}-k-${kIdx}" class="${prefix}-area-${i}-pct" placeholder="%" oninput="updateLivePreviews()">
      </div>`;
    });

    html += `</div></div>`;
  });
  document.getElementById(containerId).innerHTML = html;
}

async function loadAutoFillAreaNames(bjbCodes, jjbCodes) {
  try {
    const res = await fetch(`http://localhost:3000/api/get-latest-area-names?divisi=${currentDivisi}`);
    const data = await res.json();
    if (data.success && data.areas.length > 0) {
      data.areas.forEach(area => {
        bjbCodes.forEach((code, i) => {
          if (code === area.area_code && area.area_name) {
            const el = document.getElementById(`bjb-area-name-${i}`);
            if (el) { el.value = area.area_name; el.disabled = true; }
            syncAreaNamesToSales('bjb', i, bjbCodes, jjbCodes);
          }
        });
        jjbCodes.forEach((code, i) => {
          if (code === area.area_code && area.area_name) {
            const el = document.getElementById(`jjb-area-name-${i}`);
            if (el) { el.value = area.area_name; el.disabled = true; }
            syncAreaNamesToSales('jjb', i, bjbCodes, jjbCodes);
          }
        });
      });
    }
  } catch (err) {
    console.log('Belum ada data area tersimpan.');
  }
}

function updateLivePreviews() {
  const monthPcts = Array.from(document.querySelectorAll('.input-month')).map(el => parseFloat(el.value) || 0);
  updateBadge('preview-month-pct', monthPcts.reduce((a, b) => a + b, 0));

  const bjbAreaPcts = Array.from(document.querySelectorAll('.bjb-area-pct-input')).map(el => parseFloat(el.value) || 0);
  updateBadge('preview-bjb-area-pct', bjbAreaPcts.reduce((a, b) => a + b, 0));

  const jjbAreaPcts = Array.from(document.querySelectorAll('.jjb-area-pct-input')).map(el => parseFloat(el.value) || 0);
  updateBadge('preview-jjb-area-pct', jjbAreaPcts.reduce((a, b) => a + b, 0));

  let grandSalesBjbSum = 0;
  for (let i = 0; i < 5; i++) {
    const pcts = Array.from(document.querySelectorAll(`.sales-bjb-area-${i}-pct`)).map(el => parseFloat(el.value) || 0);
    const sum = pcts.reduce((a, b) => a + b, 0);
    updateBadge(`sales-bjb-sales-area-preview-${i}`, sum);
    grandSalesBjbSum += sum;
  }
  updateBadge('preview-sales-bjb-pct', Math.round(grandSalesBjbSum / 5));

  let grandSalesJjbSum = 0;
  for (let i = 0; i < 5; i++) {
    const pcts = Array.from(document.querySelectorAll(`.sales-jjb-area-${i}-pct`)).map(el => parseFloat(el.value) || 0);
    const sum = pcts.reduce((a, b) => a + b, 0);
    updateBadge(`sales-jjb-sales-area-preview-${i}`, sum);
    grandSalesJjbSum += sum;
  }
  updateBadge('preview-sales-jjb-pct', Math.round(grandSalesJjbSum / 5));
}

function updateBadge(badgeId, total) {
  const badge = document.getElementById(badgeId);
  if (!badge) return;
  badge.innerText = `Total: ${total}%`;
  if (total === 100) { badge.classList.add('complete'); } else { badge.classList.remove('complete'); }
}

function formatRupiah(num) {
  return new Intl.NumberFormat('id-ID').format(Math.round(num));
}

function prosesKalkulasi() {
  const bjbCodes = getAreaCodes(currentDivisi, 'BJB');
  const jjbCodes = getAreaCodes(currentDivisi, 'JJB');
  const labelDiv = currentDivisi === 'AGPN' ? 'AGP N' : currentDivisi;

  const totalTarget = parseFloat(document.getElementById('input-target-nominal').value) || 0;
  const monthPcts = Array.from(document.querySelectorAll('.input-month')).map(el => parseFloat(el.value) || 0);
  const monthValues = monthPcts.map(pct => totalTarget * (pct / 100));

  const bjbPct = parseFloat(document.getElementById('persen-bjb').value) || 0;
  const jjbPct = parseFloat(document.getElementById('persen-jjb').value) || 0;

  const bjbMonthly = monthValues.map(v => v * (bjbPct / 100));
  const jjbMonthly = monthValues.map(v => v * (jjbPct / 100));

  const bjbAreas = bjbCodes.map((code, i) => ({
    code: code,
    name: document.getElementById(`bjb-area-name-${i}`).value || `-`,
    pct: parseFloat(document.getElementById(`bjb-area-pct-${i}`).value) || 0,
    monthly: bjbMonthly.map(val => val * ((parseFloat(document.getElementById(`bjb-area-pct-${i}`).value) || 0) / 100)),
    kunjunganPcts: Array.from(document.querySelectorAll(`.sales-bjb-area-${i}-pct`)).map(el => parseFloat(el.value) || 0)
  }));

  const jjbAreas = jjbCodes.map((code, i) => ({
    code: code,
    name: document.getElementById(`jjb-area-name-${i}`).value || `-`,
    pct: parseFloat(document.getElementById(`jjb-area-pct-${i}`).value) || 0,
    monthly: jjbMonthly.map(val => val * ((parseFloat(document.getElementById(`jjb-area-pct-${i}`).value) || 0) / 100)),
    kunjunganPcts: Array.from(document.querySelectorAll(`.sales-jjb-area-${i}-pct`)).map(el => parseFloat(el.value) || 0)
  }));

  let totalMonthPctsSum = monthPcts.reduce((a, b) => a + b, 0);

  let outputHtml = `<div class="table-container" id="section-gambar-1">
    <h3>GAMBAR 1: Summary Target Divisi ${labelDiv}</h3>
    <table>
      <tr class="bg-header-agp"><th colspan="14">TARGET DIVISI ${labelDiv} ${currentYear}</th></tr>
      <tr><th colspan="14">100% : ${formatRupiah(totalTarget)}</th></tr>
      <tr><th>${labelDiv} ${currentYear}</th>` + monthPcts.map(p => `<th>${p}%</th>`).join('') + `<th>${totalMonthPctsSum}%</th></tr>
      <tr><th>Target</th>` + monthValues.map(v => `<td>${formatRupiah(v)}</td>`).join('') + `<th>${formatRupiah(totalTarget)}</th></tr>
    </table><br>

    <table>
      <tr class="bg-header-agp"><th>BULAN</th>` + months.map(m => `<th>${m}</th>`).join('') + `<th>TOTAL</th></tr>
      <tr><th>BJB (${bjbPct}%)</th>` + bjbMonthly.map(v => `<td>${formatRupiah(v)}</td>`).join('') + `<td>${formatRupiah(bjbMonthly.reduce((a,b)=>a+b,0))}</td></tr>
      <tr><th>JJB (${jjbPct}%)</th>` + jjbMonthly.map(v => `<td>${formatRupiah(v)}</td>`).join('') + `<td>${formatRupiah(jjbMonthly.reduce((a,b)=>a+b,0))}</td></tr>
      <tr class="bg-yellow"><th>TOTAL</th>` + monthValues.map(v => `<td>${formatRupiah(v)}</td>`).join('') + `<td>${formatRupiah(totalTarget)}</td></tr>
    </table><br>` +
    generateAreaTable(`TEAM ${labelDiv} BJB`, bjbAreas) + `<br>` +
    generateAreaTable(`TEAM ${labelDiv} JJB`, jjbAreas) +
  `</div>`;

  outputHtml += `<div class="table-container" id="section-gambar-2">
    <h3>GAMBAR 2: Target Team Sales ${labelDiv} BJB ${currentYear}</h3>` +
    generateSalesBreakdownTables(bjbAreas) +
  `</div>`;

  outputHtml += `<div class="table-container" id="section-gambar-3">
    <h3>GAMBAR 3: Target Team Sales ${labelDiv} JJB ${currentYear}</h3>` +
    generateSalesBreakdownTables(jjbAreas) +
  `</div>`;

  document.getElementById('output-tables').innerHTML = outputHtml;
  document.getElementById('export-buttons-bar').style.display = 'flex';
}

function generateAreaTable(title, areas) {
  let html = `<table>
    <tr class="bg-header-agp"><th colspan="15">${title}</th></tr>
    <tr><th>Kode Area</th><th>Nama Area</th><th>Persen</th>` + months.map(m => `<th>${m}</th>`).join('') + `<th>TOTAL</th></tr>`;
  let grandMonthlyTotals = new Array(12).fill(0);

  areas.forEach(a => {
    let areaTotal = a.monthly.reduce((x, y) => x + y, 0);
    html += `<tr>
      <td class="text-center">${a.code}</td>
      <td class="text-left">${a.name}</td>
      <td class="text-center">${a.pct}%</td>` +
      a.monthly.map((v, idx) => {
        grandMonthlyTotals[idx] += v;
        return `<td>${formatRupiah(v)}</td>`;
      }).join('') +
      `<td>${formatRupiah(areaTotal)}</td>
    </tr>`;
  });

  let totalAll = grandMonthlyTotals.reduce((x, y) => x + y, 0);
  html += `<tr class="bg-yellow"><th colspan="3">TOTAL</th>` +
    grandMonthlyTotals.map(v => `<td>${formatRupiah(v)}</td>`).join('') +
    `<td>${formatRupiah(totalAll)}</td></tr></table>`;

  return html;
}

function generateSalesBreakdownTables(areas) {
  let html = '';
  areas.forEach(area => {
    html += `<table style="margin-bottom: 20px;">
      <tr class="bg-header-agp"><th colspan="15">NAMA AREA: ${area.name} (${area.code})</th></tr>
      <tr><th>Kunjungan</th><th>Persen</th>` + months.map(m => `<th>${m}</th>`).join('') + `<th>TOTAL</th></tr>`;
    let monthKunjunganTotals = new Array(12).fill(0);

    kunjunganCodes.forEach((kCode, kIdx) => {
      let pct = area.kunjunganPcts[kIdx] || 0;
      let kMonthly = area.monthly.map(val => val * (pct / 100));
      let rowTotal = kMonthly.reduce((a, b) => a + b, 0);

      html += `<tr>
        <td class="text-center">${kCode}</td>
        <td class="text-center">${pct}%</td>` +
        kMonthly.map((v, idx) => {
          monthKunjunganTotals[idx] += v;
          return `<td>${formatRupiah(v)}</td>`;
        }).join('') +
        `<td>${formatRupiah(rowTotal)}</td>
      </tr>`;
    });

    let grandTotalArea = monthKunjunganTotals.reduce((a, b) => a + b, 0);
    html += `<tr class="bg-yellow"><th colspan="2">TOTAL</th>` +
      monthKunjunganTotals.map(v => `<td>${formatRupiah(v)}</td>`).join('') +
      `<td class="bg-yellow">${formatRupiah(grandTotalArea)}</td></tr></table>`;
  });
  return html;
}

async function exportToImages() {
  if (typeof html2canvas === 'undefined') return alert('Library html2canvas belum dimuat dari folder js/!');
  if (typeof JSZip === 'undefined' || typeof saveAs === 'undefined') return alert('Library jszip.min.js atau FileSaver.min.js belum dimuat!');

  const outputContainer = document.getElementById('output-tables');
  if (!outputContainer || outputContainer.children.length === 0) return alert('Belum ada data tabel untuk di-export!');

  const cleanDiv = currentDivisi.replace(/\s+/g, '');
  const zip = new JSZip();
  const folder = zip.folder(`Gambar_Target_Divisi_${cleanDiv}_${currentYear}`);

  const tables = outputContainer.querySelectorAll('table');
  for (let i = 0; i < tables.length; i++) {
    const tableEl = tables[i];
    let title = `Tabel_${i + 1}`;
    const prevEl = tableEl.previousElementSibling;
    if (prevEl && (prevEl.tagName === 'H3' || prevEl.tagName === 'H4')) {
      title = prevEl.innerText.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    }

    const canvas = await html2canvas(tableEl, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = canvas.toDataURL('image/png').split(',')[1];
    folder.file(`${i + 1}_${title}_${cleanDiv}_${currentYear}.png`, imgData, { base64: true });
  }

  zip.generateAsync({ type: 'blob' }).then(function(content) {
    saveAs(content, `Export_Gambar_Target_${cleanDiv}_${currentYear}.zip`);
  });
}

function exportToExcel() {
  const outputContainer = document.getElementById('output-tables');
  if (!outputContainer || outputContainer.children.length === 0) return alert('Belum ada data tabel untuk di-export!');

  const cleanDiv = currentDivisi.replace(/\s+/g, '');
  let excelHTML = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="utf-8">
      <style>
        table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
        th, td { border: 1px solid #000000 !important; padding: 6px; text-align: center !important; font-family: Calibri, sans-serif; font-size: 11pt; }
        th { background-color: #f1f5f9; font-weight: bold; }
        .bg-header-agp { background-color: #ffe6e6 !important; color: #800000; font-weight: bold; text-align: center !important; }
        .bg-yellow { background-color: #fef08a !important; font-weight: bold; }
      </style>
    </head>
    <body>${outputContainer.innerHTML}</body>
    </html>`;

  const blob = new Blob([excelHTML], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Report_Target_Divisi_${cleanDiv}_${currentYear}.xls`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportToPDF() {
  if (typeof html2pdf === 'undefined') return alert('Library html2pdf belum di-download!');
  const element = document.getElementById('output-tables');
  if (!element || element.children.length === 0) return alert('Belum ada data tabel untuk di-export!');

  const pdfStyle = document.createElement('style');
  pdfStyle.id = 'pdf-export-style';
  pdfStyle.innerHTML = `
    #output-tables { width: 100% !important; max-width: 100% !important; padding: 0 !important; }
    #output-tables table { width: 100% !important; border-collapse: collapse !important; margin-bottom: 12px !important; }
    #output-tables th, #output-tables td { padding: 3px 1px !important; font-size: 7pt !important; white-space: nowrap !important; }
  `;
  document.head.appendChild(pdfStyle);

  const opt = {
    margin: [0.15, 0.15, 0.15, 0.15],
    filename: `Report_Target_Divisi_${currentDivisi}_${currentYear}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, logging: false },
    jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape' },
    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
  };

  html2pdf().set(opt).from(element).save().then(() => {
    const appliedStyle = document.getElementById('pdf-export-style');
    if (appliedStyle) appliedStyle.remove();
  }).catch(err => {
    console.error(err);
    const appliedStyle = document.getElementById('pdf-export-style');
    if (appliedStyle) appliedStyle.remove();
  });
}

async function simpanKeDatabase() {
  try {
    const year = parseInt(document.getElementById('select-history-year')?.value || '2026');
    const totalTarget = parseFloat(document.getElementById('input-target-nominal')?.value || 0);

    // 1. Bulanan
    const monthlyData = [];
    document.querySelectorAll('#monthly-inputs input').forEach((inp, idx) => {
      monthlyData.push({ month: idx + 1, percentage: parseFloat(inp.value || 0) });
    });

    // 2. Divisi BJB / JJB
    const divisionData = [
      { division_code: 'BJB', percentage: parseFloat(document.getElementById('persen-bjb')?.value || 0) },
      { division_code: 'JJB', percentage: parseFloat(document.getElementById('persen-jjb')?.value || 0) }
    ];

    // 3. Area BJB (Ambil tepat dari 1 s/d 5)
    const areaData = [];
    for (let i = 1; i <= 5; i++) {
      const nameEl = document.getElementById(`bjb-area-name-${i}`) 
                  || document.querySelectorAll('#inputs-team-bjb input[type="text"]')[i - 1];
      const pctEl = document.getElementById(`bjb-area-pct-${i}`) 
                 || document.querySelectorAll('#inputs-team-bjb input[type="number"]')[i - 1];

      const kunjungan = [];
      for (let k = 1; k <= 6; k++) {
        const kEl = document.getElementById(`bjb-kunj-${i}-K0${k}`) 
                 || document.querySelectorAll(`#inputs-sales-bjb input`)[((i - 1) * 6) + (k - 1)];
        kunjungan.push({ kunjungan_code: `K0${k}`, percentage: parseFloat(kEl?.value || 0) });
      }

      areaData.push({
        area_code: `AGPC-BJB-0${i}`,
        area_name: nameEl?.value || '',
        percentage: parseFloat(pctEl?.value || 0),
        kunjungan: kunjungan
      });
    }

    // 4. Area JJB (Ambil tepat dari 1 s/d 5)
    for (let i = 1; i <= 5; i++) {
      const nameEl = document.getElementById(`jjb-area-name-${i}`) 
                  || document.querySelectorAll('#inputs-team-jjb input[type="text"]')[i - 1];
      const pctEl = document.getElementById(`jjb-area-pct-${i}`) 
                 || document.querySelectorAll('#inputs-team-jjb input[type="number"]')[i - 1];

      const kunjungan = [];
      for (let k = 1; k <= 6; k++) {
        const kEl = document.getElementById(`jjb-kunj-${i}-K0${k}`) 
                 || document.querySelectorAll(`#inputs-sales-jjb input`)[((i - 1) * 6) + (k - 1)];
        kunjungan.push({ kunjungan_code: `K0${k}`, percentage: parseFloat(kEl?.value || 0) });
      }

      areaData.push({
        area_code: `AGPC-JJB-0${i}`,
        area_name: nameEl?.value || '',
        percentage: parseFloat(pctEl?.value || 0),
        kunjungan: kunjungan
      });
    }

    const payload = {
      year: year,
      divisi: 'AGPC',
      total_target: totalTarget,
      monthly: monthlyData,
      divisions: divisionData,
      areas: areaData
    };

    const response = await fetch('http://localhost:3000/api/save-agpc-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      alert(`⚠️ Server Error ${response.status}. Restart server.js!`);
      return;
    }

    const res = await response.json();
    if (res.success) {
      alert('✅ Data Target AGPC Berhasil Disimpan ke Database!');
    } else {
      alert('❌ Gagal menyimpan: ' + res.message);
    }

  } catch (err) {
    console.error('Error simpan data:', err);
    alert('Terjadi kesalahan saat menyimpan data: ' + err.message);
  }
}
async function bukaModalHistory() {
  document.getElementById('modal-history').style.display = 'flex';
  const select = document.getElementById('select-history-year');
  select.innerHTML = '<option value="">Memuat data...</option>';

  try {
    const res = await fetch(`http://localhost:3000/api/history-years?divisi=${currentDivisi}`);
    const data = await res.json();
    if (data.success && data.years.length > 0) {
      select.innerHTML = '<option value="">-- Pilih Tahun --</option>';
      data.years.forEach(y => {
        select.innerHTML += `<option value="${y.year}">${y.year} (Target: ${formatRupiah(y.total_target)})</option>`;
      });
    } else { select.innerHTML = '<option value="">Belum ada data tersimpan</option>'; }
  } catch (err) { select.innerHTML = '<option value="">Gagal memuat history</option>'; }
}

function tutupModalHistory() { document.getElementById('modal-history').style.display = 'none'; }

// ==========================================
// FUNGSI LOAD HISTORY DATA (SUDAH DIPERBAIKI PRESISI)
// ==========================================
// ==========================================
// FUNGSI LOAD HISTORY DATA AGPC (MURNI BACA DATA TERSIMPAN)
// ==========================================
// =========================================================================
// FUNGSI LOAD HISTORY DATA AGPC (SEKALIGUS UNTUK GAMBAR 1, GAMBAR 2, & GAMBAR 3)
// =========================================================================
// =========================================================================
// FUNGSI LOAD HISTORY DATA AGPC (PERBAIKAN TOTAL AREA & GAMBAR 2 & GAMBAR 3)
// =========================================================================
// =========================================================================
// FUNGSI LOAD HISTORY DATA AGPC (PERBAIKAN TOTAL PASTI TERISI BJB-01 & JJB-01)
// =========================================================================
async function loadHistoryData() {
  const selectYear = document.getElementById('select-history-year');
  if (!selectYear || !selectYear.value) {
    alert('Silakan pilih tahun terlebih dahulu!');
    return;
  }

  const selectedYear = selectYear.value;

  try {
    const endpoint = `http://localhost:3000/api/get-agpc-target-by-year/${selectedYear}`;
    const response = await fetch(endpoint);

    if (!response.ok) {
      alert(`⚠️ Server Error ${response.status}. Restart server.js!`);
      return;
    }

    const res = await response.json();

    if (res.success && res.data) {
      const { header, monthly, divisions, areas } = res.data;

      // 1. Target Nominal
      const inputTarget = document.getElementById('input-target-nominal');
      if (inputTarget) inputTarget.value = parseFloat(header.total_target || header.nominal || 0);

      // 2. Persentase Bulanan
      if (monthly && Array.isArray(monthly)) {
        monthly.forEach((m, idx) => {
          const mNum = m.month || (idx + 1);
          let valPct = parseFloat(m.percentage || 0);
          if (valPct > 0 && valPct < 1) valPct = valPct * 100;

          const inputs = document.querySelectorAll('#monthly-inputs input');
          if (inputs[mNum - 1]) inputs[mNum - 1].value = valPct;
        });
      }

      // 3. Persentase Divisi BJB / JJB
      if (divisions && Array.isArray(divisions)) {
        divisions.forEach(d => {
          const dCode = (d.division_code || '').toUpperCase();
          let valPct = parseFloat(d.percentage || 0);
          if (valPct > 0 && valPct < 1) valPct = valPct * 100;

          if (dCode.includes('BJB')) {
            const el = document.getElementById('persen-bjb');
            if (el) el.value = valPct;
          } else if (dCode.includes('JJB')) {
            const el = document.getElementById('persen-jjb');
            if (el) el.value = valPct;
          }
        });
      }

      // 4. BACA AREA MENGGUNAKAN CODES KUNCI 'AGPC-BJB-01' SAMPAI 'AGPC-BJB-05' (ANTI-GESER INDEX)
      if (areas && Array.isArray(areas)) {
        areas.forEach(a => {
          const rawCode = (a.area_code || '').toUpperCase();
          let valPct = parseFloat(a.percentage || 0);
          if (valPct > 0 && valPct < 1) valPct = valPct * 100;

          // Ekstrak nomor dari area_code (misal: "AGPC-BJB-01" -> 1)
          const matchNum = rawCode.match(/\d+/);
          const num = matchNum ? parseInt(matchNum[0], 10) : null;

          if (num && num >= 1 && num <= 5) {
            const isBjb = rawCode.includes('BJB');
            const prefix = isBjb ? 'bjb' : 'jjb';
            const idxSelector = num - 1;

            const nameInput = document.getElementById(`${prefix}-area-name-${num}`) 
                           || document.querySelectorAll(`#inputs-team-${prefix} input[type="text"]`)[idxSelector];

            const pctInput = document.getElementById(`${prefix}-area-pct-${num}`) 
                          || document.querySelectorAll(`#inputs-team-${prefix} input[type="number"]`)[idxSelector];

            if (nameInput) nameInput.value = a.area_name || '';
            if (pctInput) pctInput.value = valPct;

            // Fill Sales Kunjungan (K01 - K06)
            if (a.kunjungan && Array.isArray(a.kunjungan)) {
              a.kunjungan.forEach((k, kIdx) => {
                let valKPct = parseFloat(k.percentage || 0);
                if (valKPct > 0 && valKPct < 1) valKPct = valKPct * 100;

                const kInput = document.getElementById(`${prefix}-kunj-${num}-K0${kIdx+1}`) 
                            || document.querySelectorAll(`#inputs-sales-${prefix} input`)[(idxSelector * 6) + kIdx];

                if (kInput) kInput.value = valKPct;
              });
            }
          }
        });
      }

      if (typeof tutupModalHistory === 'function') tutupModalHistory();

      // Trigger event input
      document.querySelectorAll('.card input').forEach(inp => {
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Kalkulasi Ulang
      setTimeout(() => {
        if (typeof prosesKalkulasi === 'function') prosesKalkulasi();
      }, 150);

    } else {
      alert('⚠️ ' + (res.message || 'Data tidak ditemukan'));
    }

  } catch (err) {
    console.error('Error load history AGPC:', err);
    alert('Gagal memuat data history: ' + err.message);
  }
}
async function bukaModalLog() {
  document.getElementById('modal-log').style.display = 'flex';
  const container = document.getElementById('log-content-container');
  container.innerHTML = 'Memuat data log...';

  try {
    const res = await fetch(`http://localhost:3000/api/change-logs?divisi=${currentDivisi}`);
    const data = await res.json();

    if (data.success && data.logs.length > 0) {
      let html = `<table>
        <tr class="bg-header-agp">
          <th>Tanggal & Waktu</th>
          <th>Tahun Target</th>
          <th>Kode Area</th>
          <th>Update Nama Area</th>
        </tr>`;
      data.logs.forEach(log => {
        html += `<tr>
          <td class="text-center">${log.formatted_date}</td>
          <td class="text-center">${log.year}</td>
          <td class="text-center"><b>${log.area_code}</b></td>
          <td class="text-left"><span style="color:#dc2626;">${log.old_name}</span> &rarr; <span style="color:#15803d; font-weight:bold;">${log.new_name}</span></td>
        </tr>`;
      });
      html += `</table>`;
      container.innerHTML = html;
    } else {
      container.innerHTML = '<p style="text-align:center; padding:20px; color:#64748b;">Belum ada riwayat perubahan Nama Area.</p>';
    }
  } catch (err) {
    container.innerHTML = '<p style="text-align:center; color:#dc2626;">Gagal memuat log perubahan.</p>';
  }
}

function tutupModalLog() { document.getElementById('modal-log').style.display = 'none'; }