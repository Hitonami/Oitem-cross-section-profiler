const fileInput = document.getElementById('fileInput');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const numSamplesEl = document.getElementById('numSamples');
const scanHalfEl = document.getElementById('scanHalf');
const umPerPxEl = document.getElementById('umPerPx');
const thresholdModeEl = document.getElementById('thresholdMode');
const thresholdEl = document.getElementById('threshold');
const thresholdNumberEl = document.getElementById('thresholdNumber');
const thresholdMinus5 = document.getElementById('thresholdMinus5');
const thresholdMinus1 = document.getElementById('thresholdMinus1');
const thresholdPlus1 = document.getElementById('thresholdPlus1');
const thresholdPlus5 = document.getElementById('thresholdPlus5');
const gapTolEl = document.getElementById('gapTol');
const measureBtn = document.getElementById('measureBtn');
const resetPoints = document.getElementById('resetPoints');
const downloadCsv = document.getElementById('downloadCsv');
const downloadOverlay = document.getElementById('downloadOverlay');
const p1xEl = document.getElementById('p1x');
const p1yEl = document.getElementById('p1y');
const p2xEl = document.getElementById('p2x');
const p2yEl = document.getElementById('p2y');
const applyPointInputs = document.getElementById('applyPointInputs');
const tbody = document.querySelector('#resultTable tbody');
const summary = document.getElementById('summary');

let img = new Image();
let imageData = null;
let loadedFileName = '';
let loadedImageKind = '';
let points = [];
let draggingIndex = -1;
let results = [];

fileInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  loadedFileName = file.name;
  const isTiff = /\.(tif|tiff)$/i.test(file.name) || /image\/tiff/i.test(file.type || '');
  try {
    if (isTiff) {
      const buffer = await file.arrayBuffer();
      const decoded = decodeTiffToImageData(buffer);
      loadedImageKind = `TIFF (${decoded.width} x ${decoded.height})`;
      await loadImageDataAsSource(decoded.imageData, decoded.width, decoded.height);
    } else {
      loadedImageKind = file.type || 'standard image';
      await loadStandardImageFile(file);
    }
    points = [];
    results = [];
    draw();
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    tbody.innerHTML = '';
    summary.textContent = `${loadedFileName} を読み込みました。左右の支持柱中心を2点クリックしてください。`;
    downloadCsv.disabled = true;
    downloadOverlay.disabled = true;
    updatePointInputs();
  } catch (err) {
    console.error(err);
    alert(`画像の読み込みに失敗しました。\n${err.message || err}`);
  }
});

function loadStandardImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('この画像形式はブラウザで読み込めません。TIFFの場合は拡張子が .tif または .tiff であることを確認してください。'));
    };
    img.src = url;
  });
}

function loadImageDataAsSource(decodedImageData, width, height) {
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(decodedImageData, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  return new Promise((resolve, reject) => {
    img = new Image();
    img.onload = resolve;
    img.onerror = () => reject(new Error('TIFFをCanvas画像へ変換できませんでした。'));
    img.src = dataUrl;
  });
}


function decodeTiffToImageData(buffer) {
  const view = new DataView(buffer);
  const byteOrder = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') throw new Error('TIFFのバイトオーダーを判定できません。');
  const u16 = off => view.getUint16(off, little);
  const u32 = off => view.getUint32(off, little);
  if (u16(2) !== 42) throw new Error('有効なTIFFファイルではありません。');

  const ifdOffset = u32(4);
  const tags = readIfd(view, ifdOffset, little);
  const width = Number(firstValue(tags[256]));
  const height = Number(firstValue(tags[257]));
  if (!width || !height) throw new Error('TIFFから画像サイズを取得できません。');

  const compression = Number(firstValue(tags[259], 1));
  if (compression !== 1) {
    throw new Error(`このTIFFの圧縮形式（Compression=${compression}）には未対応です。ImageJ/Fiji等で非圧縮TIFFとして保存してください。`);
  }

  const photometric = Number(firstValue(tags[262], 1));
  const samplesPerPixel = Number(firstValue(tags[277], 1));
  const planarConfig = Number(firstValue(tags[284], 1));
  if (planarConfig !== 1) throw new Error('Planar TIFFには未対応です。Interleaved形式で保存してください。');

  const bits = valuesOf(tags[258], [8]);
  const bitsPerSample = bits.map(Number);
  const bits0 = bitsPerSample[0] || 8;
  if (!bitsPerSample.every(b => b === bits0)) throw new Error('サンプルごとにbit深度が異なるTIFFには未対応です。');
  if (![8, 16].includes(bits0)) throw new Error(`このbit深度（${bits0} bit）には未対応です。8-bitまたは16-bit TIFFを使用してください。`);
  if (![1, 3, 4].includes(samplesPerPixel)) throw new Error(`SamplesPerPixel=${samplesPerPixel} のTIFFには未対応です。グレースケールまたはRGB/RGBA TIFFを使用してください。`);

  const stripOffsets = valuesOf(tags[273]);
  const stripByteCounts = valuesOf(tags[279]);
  if (!stripOffsets.length || !stripByteCounts.length) throw new Error('TIFFのStripOffsets/StripByteCountsを取得できません。');

  const bytesPerSample = bits0 / 8;
  const bytesPerPixel = samplesPerPixel * bytesPerSample;
  const raw = new Uint8Array(width * height * bytesPerPixel);
  let dst = 0;
  for (let i = 0; i < stripOffsets.length; i++) {
    const off = Number(stripOffsets[i]);
    const count = Number(stripByteCounts[i] ?? stripByteCounts[0]);
    raw.set(new Uint8Array(buffer, off, count), dst);
    dst += count;
  }

  const out = new ImageData(width, height);
  const signed = Number(firstValue(tags[339], 1)) === 2;
  const maxUnsigned = bits0 === 16 ? 65535 : 255;
  for (let pix = 0; pix < width * height; pix++) {
    const base = pix * bytesPerPixel;
    let r, g, b, a = 255;
    if (samplesPerPixel === 1) {
      const v = readSample(raw, base, bits0, little, signed);
      const gray = photometric === 0 ? 255 - scaleSample(v, bits0, signed, maxUnsigned) : scaleSample(v, bits0, signed, maxUnsigned);
      r = g = b = gray;
    } else {
      r = scaleSample(readSample(raw, base, bits0, little, signed), bits0, signed, maxUnsigned);
      g = scaleSample(readSample(raw, base + bytesPerSample, bits0, little, signed), bits0, signed, maxUnsigned);
      b = scaleSample(readSample(raw, base + bytesPerSample * 2, bits0, little, signed), bits0, signed, maxUnsigned);
      if (samplesPerPixel >= 4) a = scaleSample(readSample(raw, base + bytesPerSample * 3, bits0, little, signed), bits0, signed, maxUnsigned);
    }
    const o = pix * 4;
    out.data[o] = r;
    out.data[o + 1] = g;
    out.data[o + 2] = b;
    out.data[o + 3] = a;
  }
  return { width, height, imageData: out };
}

function readIfd(view, offset, little) {
  const u16 = off => view.getUint16(off, little);
  const u32 = off => view.getUint32(off, little);
  const n = u16(offset);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12;
    const tag = u16(e);
    const type = u16(e + 2);
    const count = u32(e + 4);
    const valueOffset = e + 8;
    const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }[type];
    if (!typeSize) continue;
    const total = typeSize * count;
    const dataOffset = total <= 4 ? valueOffset : u32(valueOffset);
    const values = [];
    for (let j = 0; j < count; j++) {
      const p = dataOffset + j * typeSize;
      if (type === 1 || type === 7) values.push(view.getUint8(p));
      else if (type === 3) values.push(view.getUint16(p, little));
      else if (type === 4) values.push(view.getUint32(p, little));
      else if (type === 6) values.push(view.getInt8(p));
      else if (type === 8) values.push(view.getInt16(p, little));
      else if (type === 9) values.push(view.getInt32(p, little));
      else if (type === 11) values.push(view.getFloat32(p, little));
      else if (type === 12) values.push(view.getFloat64(p, little));
      else if (type === 2) values.push(String.fromCharCode(view.getUint8(p)));
      else if (type === 5) values.push(view.getUint32(p, little) / view.getUint32(p + 4, little));
      else if (type === 10) values.push(view.getInt32(p, little) / view.getInt32(p + 4, little));
    }
    tags[tag] = { type, count, values };
  }
  return tags;
}

function valuesOf(tag, fallback = []) { return tag ? tag.values : fallback; }
function firstValue(tag, fallback = undefined) { return tag && tag.values.length ? tag.values[0] : fallback; }

function readSample(raw, offset, bits, little, signed) {
  if (bits === 8) return signed ? (raw[offset] << 24) >> 24 : raw[offset];
  const v = little ? raw[offset] | (raw[offset + 1] << 8) : (raw[offset] << 8) | raw[offset + 1];
  return signed ? (v << 16) >> 16 : v;
}

function scaleSample(v, bits, signed, maxUnsigned) {
  if (signed) {
    const min = bits === 16 ? -32768 : -128;
    const max = bits === 16 ? 32767 : 127;
    return clamp(Math.round((v - min) * 255 / (max - min)), 0, 255);
  }
  return bits === 16 ? clamp(Math.round(v * 255 / maxUnsigned), 0, 255) : clamp(v, 0, 255);
}

function setThreshold(value, shouldMeasure = false) {
  const v = clamp(Math.round(Number(value)), 0, 255);
  thresholdEl.value = v;
  thresholdNumberEl.value = v;
  if (shouldMeasure && results.length > 0) measure();
}

thresholdEl.addEventListener('input', () => setThreshold(thresholdEl.value, false));
thresholdEl.addEventListener('change', () => { if (results.length > 0) measure(); });
thresholdNumberEl.addEventListener('input', () => setThreshold(thresholdNumberEl.value, false));
thresholdNumberEl.addEventListener('change', () => setThreshold(thresholdNumberEl.value, true));
thresholdNumberEl.addEventListener('keydown', evt => {
  if (evt.key === 'Enter') setThreshold(thresholdNumberEl.value, true);
});
thresholdMinus5.addEventListener('click', () => setThreshold(Number(thresholdEl.value) - 5, true));
thresholdMinus1.addEventListener('click', () => setThreshold(Number(thresholdEl.value) - 1, true));
thresholdPlus1.addEventListener('click', () => setThreshold(Number(thresholdEl.value) + 1, true));
thresholdPlus5.addEventListener('click', () => setThreshold(Number(thresholdEl.value) + 5, true));

function canvasPoint(evt) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (evt.clientX - rect.left) * sx, y: (evt.clientY - rect.top) * sy };
}

canvas.addEventListener('mousedown', evt => {
  if (!img.src) return;
  const p = canvasPoint(evt);
  const hit = points.findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) < 18);
  if (hit >= 0) {
    draggingIndex = hit;
    return;
  }
  if (points.length < 2) {
    points.push(p);
    updatePointInputs();
    draw();
  }
});
canvas.addEventListener('mousemove', evt => {
  if (draggingIndex < 0) return;
  points[draggingIndex] = canvasPoint(evt);
  updatePointInputs();
  draw();
});
window.addEventListener('mouseup', () => draggingIndex = -1);

resetPoints.addEventListener('click', () => {
  points = [];
  results = [];
  draw();
  tbody.innerHTML = '';
  summary.textContent = '点をリセットしました。左右の支持柱中心を2点クリックしてください。';
  downloadCsv.disabled = true;
  downloadOverlay.disabled = true;
  updatePointInputs();
});

measureBtn.addEventListener('click', measure);
downloadCsv.addEventListener('click', exportCsv);
downloadOverlay.addEventListener('click', exportOverlayImage);
applyPointInputs.addEventListener('click', applyManualPoints);
[p1xEl, p1yEl, p2xEl, p2yEl].forEach(el => {
  el.addEventListener('keydown', evt => {
    if (evt.key === 'Enter') applyManualPoints();
  });
});

function updatePointInputs() {
  const els = [[p1xEl, p1yEl], [p2xEl, p2yEl]];
  els.forEach(([xEl, yEl], i) => {
    if (points[i]) {
      xEl.value = points[i].x.toFixed(2);
      yEl.value = points[i].y.toFixed(2);
    } else {
      xEl.value = '';
      yEl.value = '';
    }
  });
}

function applyManualPoints() {
  if (!img.src) {
    alert('先に画像を読み込んでください。');
    return;
  }
  const values = [p1xEl.value, p1yEl.value, p2xEl.value, p2yEl.value].map(Number);
  if (values.some(v => !Number.isFinite(v))) {
    alert('点1・点2のX/Y座標をすべて数値で入力してください。');
    return;
  }
  points = [
    { x: clamp(values[0], 0, canvas.width - 1), y: clamp(values[1], 0, canvas.height - 1) },
    { x: clamp(values[2], 0, canvas.width - 1), y: clamp(values[3], 0, canvas.height - 1) }
  ];
  results = [];
  tbody.innerHTML = '';
  summary.textContent = '座標を反映しました。「測定する」を押してください。';
  downloadCsv.disabled = true;
  downloadOverlay.disabled = true;
  updatePointInputs();
  draw();
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function draw() {
  if (!img.src) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);

  if (points.length === 2) {
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'cyan';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.stroke();
    ctx.restore();
  }

  // 測定線と端点を描画
  for (const r of results) {
    if (!Number.isFinite(r.widthPx)) continue;
    ctx.save();
    ctx.strokeStyle = 'yellow';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(r.edge1.x, r.edge1.y);
    ctx.lineTo(r.edge2.x, r.edge2.y);
    ctx.stroke();
    ctx.restore();
  }

  points.forEach((p, i) => {
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = i === 0 ? 'lime' : 'orange';
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '20px sans-serif';
    ctx.fillText(String(i + 1), p.x + 20, p.y - 18);
    ctx.restore();
  });
}

function getPixel(x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  const i = (y * canvas.width + x) * 4;
  return [imageData.data[i], imageData.data[i+1], imageData.data[i+2]];
}

function isMuscle(rgb) {
  if (!rgb) return false;
  const [r, g, b] = rgb;
  const th = Number(thresholdEl.value);
  if (thresholdModeEl.value === 'dark') {
    const gray = 0.299*r + 0.587*g + 0.114*b;
    return gray < th;
  }
  // 赤〜茶色を拾う簡易指標：赤成分が相対的に高く、明るすぎない部分
  const redness = r - 0.5*g - 0.5*b;
  const gray = 0.299*r + 0.587*g + 0.114*b;
  return redness > th - 128 && gray < 210;
}

function scanWidth(center, normal, scanHalf, gapTol) {
  const samples = [];
  for (let s = -scanHalf; s <= scanHalf; s++) {
    const x = center.x + normal.x * s;
    const y = center.y + normal.y * s;
    samples.push({ s, x, y, on: isMuscle(getPixel(x, y)) });
  }
  const midIndex = scanHalf;
  if (!samples[midIndex]?.on) {
    // 中心点が筋肉判定外の場合、近傍で最も近い筋肉画素を探す
    let nearest = -1;
    for (let d = 0; d <= scanHalf; d++) {
      if (samples[midIndex - d]?.on) { nearest = midIndex - d; break; }
      if (samples[midIndex + d]?.on) { nearest = midIndex + d; break; }
    }
    if (nearest < 0) return null;
    return expandFrom(samples, nearest, gapTol);
  }
  return expandFrom(samples, midIndex, gapTol);
}

function expandFrom(samples, start, gapTol) {
  let left = start, right = start;
  let gap = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (samples[i].on) { left = i; gap = 0; }
    else if (++gap > gapTol) break;
  }
  gap = 0;
  for (let i = start + 1; i < samples.length; i++) {
    if (samples[i].on) { right = i; gap = 0; }
    else if (++gap > gapTol) break;
  }
  return { a: samples[left], b: samples[right], width: Math.abs(samples[right].s - samples[left].s) };
}

function measure() {
  if (!imageData || points.length !== 2) {
    alert('画像を読み込み、左右の支持柱中心を2点指定してください。');
    return;
  }
  const n = Math.max(2, Number(numSamplesEl.value));
  const scanHalf = Math.max(10, Number(scanHalfEl.value));
  const gapTol = Math.max(0, Number(gapTolEl.value));
  const umPerPx = Number(umPerPxEl.value) || 1;
  const p0 = points[0], p1 = points[1];
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  const tangent = { x: dx / len, y: dy / len };
  const normal = { x: -tangent.y, y: tangent.x };

  results = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const c = { x: p0.x + dx * t, y: p0.y + dy * t };
    const sw = scanWidth(c, normal, scanHalf, gapTol);
    if (sw) {
      results.push({
        index: i, t, x: c.x, y: c.y,
        widthPx: sw.width,
        widthUm: sw.width * umPerPx,
        edge1: { x: sw.a.x, y: sw.a.y }, edge2: { x: sw.b.x, y: sw.b.y }
      });
    } else {
      results.push({ index: i, t, x: c.x, y: c.y, widthPx: NaN, widthUm: NaN, edge1: c, edge2: c });
    }
  }
  draw();
  renderTable();
}

function renderTable() {
  tbody.innerHTML = '';
  const valid = results.filter(r => Number.isFinite(r.widthPx));
  const avg = valid.reduce((a, r) => a + r.widthPx, 0) / Math.max(1, valid.length);
  const min = Math.min(...valid.map(r => r.widthPx));
  const max = Math.max(...valid.map(r => r.widthPx));
  summary.textContent = `有効測定点 ${valid.length}/${results.length}、平均 ${avg.toFixed(2)} px、最小 ${min.toFixed(2)} px、最大 ${max.toFixed(2)} px`;
  for (const r of results) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.index}</td><td>${r.t.toFixed(4)}</td><td>${r.x.toFixed(2)}</td><td>${r.y.toFixed(2)}</td><td>${fmt(r.widthPx)}</td><td>${fmt(r.widthUm)}</td>`;
    tbody.appendChild(tr);
  }
  downloadCsv.disabled = false;
  downloadOverlay.disabled = false;
}
function fmt(v) { return Number.isFinite(v) ? v.toFixed(3) : ''; }


function exportCsv() {
  const p0 = points[0] || { x: NaN, y: NaN };
  const p1 = points[1] || { x: NaN, y: NaN };
  const fileName = loadedFileName || (fileInput.files && fileInput.files[0] ? fileInput.files[0].name : '');
  const now = new Date().toISOString();

  const lines = [];
  lines.push('# Analysis Parameters');
  lines.push(`SourceImage,${fileName}`);
  lines.push(`SourceImageType,${loadedImageKind}`);
  lines.push(`AnalysisDateTime,${now}`);
  lines.push(`ThresholdMode,${thresholdModeEl.value}`);
  lines.push(`ThresholdValue,${Number(thresholdEl.value)}`);
  lines.push(`ContinuityTolerance,${Number(gapTolEl.value)}`);
  lines.push(`NumberOfSections,${Number(numSamplesEl.value)}`);
  lines.push(`ScanHalfLength,${Number(scanHalfEl.value)}`);
  lines.push(`PixelToMicron,${Number(umPerPxEl.value)}`);
  lines.push(`LeftSupportX_px,${p0.x}`);
  lines.push(`LeftSupportY_px,${p0.y}`);
  lines.push(`RightSupportX_px,${p1.x}`);
  lines.push(`RightSupportY_px,${p1.y}`);
  lines.push('');
  lines.push('# Measurement Results');
  lines.push('ProfilePointID,NormalizedDistanceFromLeftSupport,CenterX_px,CenterY_px,CrossSectionWidth_px,CrossSectionWidth_um,Edge1X_px,Edge1Y_px,Edge2X_px,Edge2Y_px');

  for (const r of results) {
    lines.push([
      r.index, r.t, r.x, r.y, r.widthPx, r.widthUm,
      r.edge1.x, r.edge1.y, r.edge2.x, r.edge2.y
    ].map(v => Number.isFinite(v) ? Number(v).toFixed(6) : '').join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'oitem_cross_section_profile_results.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}


function exportOverlayImage() {
  if (!img.src) {
    alert('画像が読み込まれていません。');
    return;
  }
  // 現在のcanvas表示内容（元画像＋支点＋中心線＋測定線）をPNGとして保存
  draw();
  canvas.toBlob(blob => {
    if (!blob) {
      alert('画像の書き出しに失敗しました。');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'oitem_cross_section_profile_overlay.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}
