/* ================= 依存ゼロの簡易SVGチャート =================
 * 閉域ネットワークでも動くよう外部ライブラリは使わない。
 * Charts.donut / Charts.hbar / Charts.line を提供。 */
const Charts = {
  donut(items, { size = 160, hole = 0.62 } = {}) {
    // items: [{label, value, color}]
    const total = items.reduce((a, b) => a + b.value, 0);
    const cx = size / 2, cy = size / 2;
    // 円弧はストローク（太さ r*(1-hole)）で描くため、外縁 = r + 太さ/2 が
    // viewBox に収まるよう中心線半径 r を逆算する（従来は外縁がはみ出して欠けていた）
    const r = (size / 2 - 2) / (1 + (1 - hole) / 2);
    if (!total) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="${r * (1 - hole)}"/>
        <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#94a3b8" font-size="12">データなし</text></svg>`;
    }
    let angle = -Math.PI / 2;
    const paths = [];
    for (const it of items) {
      if (!it.value) continue;
      const frac = it.value / total;
      const a2 = angle + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(a2 - 0.004), y2 = cy + r * Math.sin(a2 - 0.004);
      if (frac >= 0.9999) {
        paths.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${r * (1 - hole)}"><title>${U.esc(it.label)}: ${it.value}</title></circle>`);
      } else {
        paths.push(`<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}" fill="none" stroke="${it.color}" stroke-width="${r * (1 - hole)}"><title>${U.esc(it.label)}: ${it.value}</title></path>`);
      }
      angle = a2;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      ${paths.join('')}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="22" font-weight="700" fill="#1f2937">${total}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="11" fill="#94a3b8">タスク</text></svg>`;
  },

  hbar(items, { width = 320, rowH = 28, max = null } = {}) {
    // items: [{label, value, color, sub}] 横棒グラフ
    const m = max ?? Math.max(1, ...items.map(i => i.value));
    const labelW = 90, valW = 34;
    const barW = width - labelW - valW;
    const h = items.length * rowH || rowH;
    const rows = items.map((it, i) => {
      const y = i * rowH;
      const w = Math.max(2, (it.value / m) * barW);
      return `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="12" fill="#475569">${U.esc(it.label)}</text>
        <rect x="${labelW}" y="${y + 6}" width="${barW}" height="${rowH - 12}" rx="4" fill="#eef1f7"/>
        <rect x="${labelW}" y="${y + 6}" width="${it.value ? w : 0}" height="${rowH - 12}" rx="4" fill="${it.color}"><title>${U.esc(it.label)}: ${it.value}</title></rect>
        <text x="${labelW + barW + 6}" y="${y + rowH / 2 + 4}" font-size="12" font-weight="600" fill="#1f2937">${it.value}</text>`;
    }).join('');
    return `<svg width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${rows}</svg>`;
  },

  line(points, { width = 420, height = 150, color = '#4f6ef7', fill = true, yMax = null, labels = [] } = {}) {
    // points: number[]（等間隔）。labels: X軸ラベル（省略可）
    if (points.length < 2) {
      return `<svg width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#94a3b8" font-size="12">データ不足</text></svg>`;
    }
    const padL = 30, padB = 18, padT = 8, padR = 8;
    const w = width - padL - padR, h = height - padT - padB;
    const m = yMax ?? Math.max(1, ...points);
    const px = (i) => padL + (i / (points.length - 1)) * w;
    const py = (v) => padT + h - (v / m) * h;
    const pts = points.map((v, i) => `${px(i)},${py(v)}`).join(' ');
    const grid = [0, 0.5, 1].map(f =>
      `<line x1="${padL}" y1="${py(m * f)}" x2="${width - padR}" y2="${py(m * f)}" stroke="#eef1f6"/>
       <text x="${padL - 5}" y="${py(m * f) + 4}" text-anchor="end" font-size="10" fill="#94a3b8">${Math.round(m * f)}</text>`).join('');
    const xLabels = labels.map((l, i) => l
      ? `<text x="${px(i)}" y="${height - 4}" text-anchor="middle" font-size="10" fill="#94a3b8">${U.esc(l)}</text>` : '').join('');
    const area = fill
      ? `<polygon points="${padL},${py(0)} ${pts} ${px(points.length - 1)},${py(0)}" fill="${color}" opacity="0.12"/>` : '';
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="max-width:100%">
      ${grid}${area}
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
      ${xLabels}</svg>`;
  },
};
