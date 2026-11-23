/* VectorKit offline label reader — free, no internet, no account.
 * Recognises handwritten / printed labels (A, B, x, y, H2O, θ, 5 cm …) by comparing the
 * stroke skeleton of each character against skeletons of the same characters drawn with
 * the device's own fonts (shape matching with chamfer distance), plus context rules. */
(function (root) {
  'use strict';
  const E = root.VecEngine, X = root.VecExport;
  const S = 40, BOX = 30; // feature canvas size / glyph box
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-=()<>/→θπαβΔΩλμ√';
  const FONTS = ['Arial, Helvetica, "Liberation Sans", "DejaVu Sans", sans-serif', '"Times New Roman", Times, "DejaVu Serif", serif', '"Courier New", Courier, monospace', '"Comic Sans MS", "Comic Relief", "Chalkboard SE", cursive', 'Verdana, Tahoma, sans-serif'];
  const STYLES = [];
  FONTS.forEach((f, i) => { STYLES.push('400 64px ' + f); if (i === 0 || i === 1) STYLES.push('italic 400 64px ' + f); if (i === 0) STYLES.push('700 64px ' + f); });
  const PAIRS = { c: 'C', o: 'O', s: 'S', u: 'U', v: 'V', w: 'W', x: 'X', z: 'Z', p: 'P', k: 'K' };
  let templates = null;

  // binary bitmap (Uint8Array w*h) → normalised skeleton feature
  function feature(bm, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bm[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // skeleton at (near) native resolution, padded
    const pad = 3, ds = Math.max(1, Math.max(bw, bh) / 110), cw = Math.ceil(bw / ds) + 2 * pad, ch = Math.ceil(bh / ds) + 2 * pad;
    const crop = new Uint8Array(cw * ch);
    for (let y = 0; y < ch - 2 * pad; y++) for (let x = 0; x < cw - 2 * pad; x++) { const sx = Math.min(x1, x0 + Math.floor(x * ds)), sy = Math.min(y1, y0 + Math.floor(y * ds)); crop[(y + pad) * cw + x + pad] = bm[sy * w + sx]; }
    const m = new Uint8Array(S * S), k = BOX / Math.max(bw, bh) * ds, ox = (S - (cw - 2 * pad) * k) / 2, oy = (S - (ch - 2 * pad) * k) / 2;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (crop[y * cw + x]) { const X2 = Math.floor(ox + (x - pad) * k), Y2 = Math.floor(oy + (y - pad) * k); if (X2 >= 0 && Y2 >= 0 && X2 < S && Y2 < S) m[Y2 * S + X2] = 1; }
    const skFull = E.thinBitmap({ m: crop, w: cw, h: ch });
    const set = new Uint8Array(S * S);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (skFull[y * cw + x]) { const X2 = Math.floor(ox + (x - pad) * k), Y2 = Math.floor(oy + (y - pad) * k); if (X2 >= 0 && Y2 >= 0 && X2 < S && Y2 < S) set[Y2 * S + X2] = 1; }
    const pts = []; for (let i = 0; i < S * S; i++) if (set[i]) pts.push(i);
    if (pts.length < 3) for (let i = 0; i < S * S; i++) if (m[i]) pts.push(i);
    // chamfer distance transform of the skeleton
    const dt = new Float32Array(S * S).fill(1e3);
    for (const p of pts) dt[p] = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = y * S + x; let v = dt[i]; if (x) v = Math.min(v, dt[i - 1] + 1); if (y) v = Math.min(v, dt[i - S] + 1); if (x && y) v = Math.min(v, dt[i - S - 1] + 1.4); if (y && x < S - 1) v = Math.min(v, dt[i - S + 1] + 1.4); dt[i] = v; }
      for (let y = S - 1; y >= 0; y--) for (let x = S - 1; x >= 0; x--) { const i = y * S + x; let v = dt[i]; if (x < S - 1) v = Math.min(v, dt[i + 1] + 1); if (y < S - 1) v = Math.min(v, dt[i + S] + 1); if (x < S - 1 && y < S - 1) v = Math.min(v, dt[i + S + 1] + 1.4); if (y < S - 1 && x) v = Math.min(v, dt[i + S - 1] + 1.4); dt[i] = v; }
    }
    // holes count (topology: A,B,D,O,P,Q,R,a,b,d,e,g,o,p,q,0,4,6,8,9 …)
    const N = cw * ch, inv = new Uint8Array(N); for (let i = 0; i < N; i++) inv[i] = crop[i] ? 0 : 1;
    let holes = 0; const seen = new Uint8Array(N), minHole = Math.max(4, (cw * ch) * 0.004);
    for (let i = 0; i < N; i++) {
      if (!inv[i] || seen[i]) continue; let border = false, area = 0; const st = [i]; seen[i] = 1;
      while (st.length) { const p = st.pop(), x = p % cw, y = (p / cw) | 0; area++; if (!x || !y || x === cw - 1 || y === ch - 1) border = true;
        for (const q of [p - 1, p + 1, p - cw, p + cw]) { const qx = q % cw; if (q < 0 || q >= N || Math.abs(qx - x) > 1 || !inv[q] || seen[q]) continue; seen[q] = 1; st.push(q); } }
      if (!border && area >= minHole) holes++;
    }
    return { pts, dt, aspect: bw / bh, holes };
  }
  function score(a, b) {
    let s1 = 0; for (const p of a.pts) s1 += Math.min(8, b.dt[p]); s1 /= a.pts.length;
    let s2 = 0; for (const p of b.pts) s2 += Math.min(8, a.dt[p]); s2 /= b.pts.length;
    const asp = Math.abs(Math.log((a.aspect + 0.05) / (b.aspect + 0.05)));
    return (s1 + s2) / 2 + 1.0 * asp + (Math.min(a.holes, 2) === Math.min(b.holes, 2) ? 0 : 0.6);
  }
  function buildTemplates() {
    if (templates) return templates;
    templates = [];
    const c = document.createElement('canvas'); c.width = 120; c.height = 120; const g = c.getContext('2d', { willReadFrequently: true });
    for (const st of STYLES) for (const ch of CHARS) {
      g.fillStyle = '#fff'; g.fillRect(0, 0, 120, 120); g.fillStyle = '#000'; g.font = st; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText(ch, 60, 64);
      const d = g.getImageData(0, 0, 120, 120).data, bm = new Uint8Array(120 * 120);
      for (let i = 0; i < 120 * 120; i++) bm[i] = d[i * 4] < 128 ? 1 : 0;
      const f = feature(bm, 120, 120); if (f) { f.ch = ch; templates.push(f); }
    }
    return templates;
  }
  // rasterise vector glyph elements into a bitmap
  function rasterize(els, bbox) {
    const pad = 2, bw = bbox[2] - bbox[0], bh = bbox[3] - bbox[1], k = Math.min(4, 90 / Math.max(bw, bh, 1));
    const W = Math.ceil(bw * k) + 2 * pad, H = Math.ceil(bh * k) + 2 * pad;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.setTransform(k, 0, 0, k, pad - bbox[0] * k, pad - bbox[1] * k); g.fillStyle = '#000';
    for (const e of els) g.fill(new Path2D(X.cmdsToD(E.shapeToSubpaths(e))), e.shape === 'compound' || e.holes ? 'evenodd' : 'nonzero');
    const d = g.getImageData(0, 0, W, H).data, bm = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) bm[i] = d[i * 4] < 128 ? 1 : 0;
    return { bm, W, H };
  }
  // split a glyph group into characters (merge pieces stacked vertically, e.g. i, j, =, ÷)
  function chars(group, res) {
    const items = group.members.map((id) => res.elements.find((e) => e.id === id)).filter(Boolean).map((e) => ({ els: [e], b: E.elementBBox(e) }));
    items.sort((a, b) => a.b[0] - b.b[0]);
    const out = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (last) { const ov = Math.min(last.b[2], it.b[2]) - Math.max(last.b[0], it.b[0]); const mw = Math.min(last.b[2] - last.b[0], it.b[2] - it.b[0]); if (ov > 0.55 * mw) { last.els.push(...it.els); last.b = [Math.min(last.b[0], it.b[0]), Math.min(last.b[1], it.b[1]), Math.max(last.b[2], it.b[2]), Math.max(last.b[3], it.b[3])]; continue; } }
      out.push({ els: it.els.slice(), b: it.b.slice() });
    }
    return out;
  }
  function classify(ch) {
    const T = buildTemplates(); const r = rasterize(ch.els, ch.b); const f = feature(r.bm, r.W, r.H); if (!f) return null;
    const best = new Map();
    for (const t of T) { const s = score(f, t); if (!best.has(t.ch) || s < best.get(t.ch)) best.set(t.ch, s); }
    return [...best.entries()].sort((a, b) => a[1] - b[1]);
  }
  // read every glyph group. returns [{group, runs, confidence}]
  function readLabels(res) {
    const groups = E.glyphGroups(res); const results = [];
    // does the drawing contain numbers (axis ticks, values)? → single look-alike chars read as digits
    let numericImage = false;
    const allH = groups.map((g) => g.bbox[3] - g.bbox[1]).sort((a, b) => a - b); const refH = allH[Math.floor(allH.length * 0.6)] || 20;
    for (const gr of groups) { const cs = chars(gr, res); if (cs.length >= 2 && cs.length <= 4) { const top = cs.map((c) => (classify(c) || [['?']])[0][0]); if (top.every((t) => /[0-9.]/.test(t))) { numericImage = true; break; } } }
    for (const gr of groups) {
      const cs = chars(gr, res); if (!cs.length || cs.length > 14) continue;
      const lineH = Math.max(...cs.map((c) => c.b[3] - c.b[1]));
      const runs = []; let worst = 0, ok = true; let prev = null;
      cs.forEach((c, idx) => {
        const ranked = classify(c); if (!ranked) { ok = false; return; }
        let [ch, s] = ranked[0];
        const h = c.b[3] - c.b[1];
        // context priors: letters vs look-alike digits
        const LD = { '8': 'B', '0': 'O', '5': 'S', '2': 'Z', '6': 'b', '1': 'I', '9': 'g' };
        const DL = { B: '8', O: '0', o: '0', S: '5', s: '5', Z: '2', z: '2', b: '6', I: '1', l: '1', g: '9' };
        const sc = (k) => (ranked.find((r) => r[0] === k) || [k, 99])[1];
        const wantDigits = (prev && /\d/.test(prev.t)) || (!prev && cs.length > 1 && /\d/.test(String((classify(cs[1]) || [['']])[0][0]))) || (cs.length === 1 && numericImage);
        if (wantDigits && DL[ch] && sc(DL[ch]) < s + 0.35) { ch = DL[ch]; }
        else if (!wantDigits && LD[ch] && sc(LD[ch]) < s + 0.35) { ch = LD[ch]; }
        if ('1lI|'.includes(ch) && !wantDigits && cs.length > 1 && prev && /[a-z]/.test(prev.t)) ch = 'l';
        // case from size
        const low = Object.keys(PAIRS).find((k) => k === ch || PAIRS[k] === ch);
        if (low) { const ref = cs.length > 1 ? lineH : refH; ch = h >= 0.72 * ref ? PAIRS[low] : low; }
        // sub / superscript relative to previous main character
        let sub = false, sup = false;
        if (prev && !prev.sub && !prev.sup && /[A-Za-z)\]]/.test(prev.t.slice(-1)) && /[0-9+\-−nxy]/.test(ch)) {
          const ph = prev.h, pb = prev.b;
          if (h < 0.82 * ph && c.b[1] > pb[1] + 0.25 * ph && c.b[3] >= pb[3] - 0.08 * ph) sub = true;
          else if (h < 0.82 * ph && c.b[3] < pb[3] - 0.25 * ph && c.b[1] <= pb[1] + 0.08 * ph) sup = true;
        }
        worst = Math.max(worst, s);
        const run = { t: ch, sub, sup }; runs.push(run); prev = Object.assign({ h, b: c.b }, run);
      });
      if (!ok || !runs.length) continue;
      // units: "5cm", "12 kg", "3V" → digits before the unit
      if (runs.length >= 2 && runs[runs.length - 1].t === 'm' && runs[runs.length - 2].t === 'C') runs[runs.length - 2].t = 'c';
      const flat = runs.map((r) => r.t).join('');
      const um = flat.match(/^([0-9SOoIlZzBbg.]+)(cm|mm|km|m|kg|g|s|ms|V|A|N|J|W|Hz|Ω|K|mA|kV)$/);
      if (um && /[0-9]/.test(um[1].replace(/[SOoIlZzBbg]/g, '')) || (um && um[1].length <= 3)) { const map = { S: '5', O: '0', o: '0', I: '1', l: '1', Z: '2', z: '2', B: '8', b: '6', g: '9' }; let i2 = 0; for (const r of runs) { if (i2 >= um[1].length) break; r.t = map[r.t] || r.t; r.sub = r.sup = false; i2 += r.t.length; } }
      // merge consecutive runs with the same style
      const merged = []; for (const r of runs) { const l = merged[merged.length - 1]; if (l && l.sub === r.sub && l.sup === r.sup) l.t += r.t; else merged.push(Object.assign({}, r)); }
      results.push({ group: gr, runs: merged.map((r) => ({ t: r.t, sub: r.sub || undefined, sup: r.sup || undefined })), confidence: Math.max(0, Math.min(1, 1 - (worst - 1.2) / 2.6)) });
    }
    return results;
  }
  // "H_2O", "x^2", "CO_{2}", "v_{max}" → runs
  function parseRuns(str) {
    const runs = []; let i = 0; const push = (t, sub, sup) => { if (!t) return; const l = runs[runs.length - 1]; if (l && !!l.sub === !!sub && !!l.sup === !!sup) l.t += t; else runs.push({ t, sub: sub || undefined, sup: sup || undefined }); };
    while (i < str.length) {
      const c = str[i];
      if ((c === '_' || c === '^') && i + 1 < str.length) {
        let t; if (str[i + 1] === '{') { const j = str.indexOf('}', i + 2); t = str.slice(i + 2, j < 0 ? str.length : j); i = j < 0 ? str.length : j + 1; } else { t = str[i + 1]; i += 2; }
        push(t, c === '_', c === '^');
      } else { push(c); i++; }
    }
    return runs;
  }
  const runsToString = (runs) => runs.map((r) => (r.sub ? (r.t.length > 1 ? '_{' + r.t + '}' : '_' + r.t) : r.sup ? (r.t.length > 1 ? '^{' + r.t + '}' : '^' + r.t) : r.t)).join('');
  root.VecOCR = { _dbg: { chars, rasterize, classify, feature, S },  readLabels, parseRuns, runsToString, buildTemplates };
})(typeof window !== 'undefined' ? window : this);
