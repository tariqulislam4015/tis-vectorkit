/* =====================================================================
 *  VectorKit engine — raster diagram → clean, standardized vector shapes
 *  Pure JS, no dependencies. Works in browser (window.VecEngine) and Node.
 * ===================================================================== */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ utils
  const hypot = Math.hypot, abs = Math.abs, PI = Math.PI;
  const dist = (a, b) => hypot(a[0] - b[0], a[1] - b[1]);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const angOf = (v) => Math.atan2(v[1], v[0]);
  function angDiff(a, b) { let d = (a - b) % (2 * PI); if (d > PI) d -= 2 * PI; if (d < -PI) d += 2 * PI; return d; }
  function median(arr) { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); return s[s.length >> 1]; }

  function solveLinear(A, b) { // gaussian elimination, A n×n (array of arrays)
    const n = b.length; A = A.map((r) => r.slice()); b = b.slice();
    for (let i = 0; i < n; i++) {
      let p = i; for (let r = i + 1; r < n; r++) if (abs(A[r][i]) > abs(A[p][i])) p = r;
      if (abs(A[p][i]) < 1e-12) return null;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
    return x;
  }

  // ------------------------------------------------- 1. background / ink mask
  // Smooth lighting model: robust quadratic surface fitted to paper blocks.
  function fitBackground(ch, w, h, gray) {
    const B = Math.max(16, Math.round(Math.min(w, h) / 24));
    const blocks = [];
    for (let by = 0; by < h; by += B) for (let bx = 0; bx < w; bx += B) {
      const vals = [], gv = [];
      for (let y = by; y < Math.min(h, by + B); y += 2) for (let x = bx; x < Math.min(w, bx + B); x += 2) { vals.push(gray[y * w + x]); }
      vals.sort((a, b) => a - b);
      const g90 = vals[Math.floor(vals.length * 0.9)];
      const cx = Math.min(w, bx + B / 2), cy = Math.min(h, by + B / 2);
      blocks.push({ x: (cx / w) * 2 - 1, y: (cy / h) * 2 - 1, bx, by, g: g90 });
    }
    const basis = (x, y) => [1, x, y, x * x, x * y, y * y];
    let active = blocks.slice();
    const maxG = Math.max(...blocks.map((b) => b.g));
    active = active.filter((b) => b.g > maxG - 90); // discard obviously covered blocks
    let coef = null;
    for (let it = 0; it < 4; it++) {
      if (active.length < 8) break;
      const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), r = new Array(6).fill(0);
      for (const b of active) { const f = basis(b.x, b.y); for (let i = 0; i < 6; i++) { r[i] += f[i] * b.g; for (let j = 0; j < 6; j++) A[i][j] += f[i] * f[j]; } }
      for (let i = 0; i < 6; i++) A[i][i] += 1e-3;
      coef = solveLinear(A, r); if (!coef) break;
      const res = active.map((b) => b.g - basis(b.x, b.y).reduce((s, f, i) => s + f * coef[i], 0));
      const sd = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length) + 2;
      active = active.filter((b, i) => res[i] > -2.0 * sd);
    }
    // per channel fits on the accepted blocks
    const keep = new Set(active.map((b) => b.bx + ',' + b.by));
    const out = [];
    for (let c = 0; c < 3; c++) {
      const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), r = new Array(6).fill(0);
      let cnt = 0;
      for (const b of blocks) {
        if (!keep.has(b.bx + ',' + b.by)) continue;
        const vals = [];
        for (let y = b.by; y < Math.min(h, b.by + B); y += 2) for (let x = b.bx; x < Math.min(w, b.bx + B); x += 2) vals.push(ch[c][y * w + x]);
        vals.sort((a, b2) => a - b2);
        const v = vals[Math.floor(vals.length * 0.9)];
        const f = basis(b.x, b.y); cnt++;
        for (let i = 0; i < 6; i++) { r[i] += f[i] * v; for (let j = 0; j < 6; j++) A[i][j] += f[i] * f[j]; }
      }
      for (let i = 0; i < 6; i++) A[i][i] += 1e-3;
      const k = cnt >= 8 ? solveLinear(A, r) : null;
      out.push(k || [255, 0, 0, 0, 0, 0]);
    }
    return { coefs: out, basis };
  }

  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
      sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; th = t; }
    }
    return th;
  }

  function normalizeImage(rgba, w, h, opts) {
    const n = w * h, R = new Float32Array(n), G = new Float32Array(n), Bc = new Float32Array(n), gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = rgba[i * 4 + 3] / 255; // composite transparent images on white
      R[i] = rgba[i * 4] * a + 255 * (1 - a); G[i] = rgba[i * 4 + 1] * a + 255 * (1 - a); Bc[i] = rgba[i * 4 + 2] * a + 255 * (1 - a);
      gray[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * Bc[i];
    }
    const bg = fitBackground([R, G, Bc], w, h, gray);
    const out = { r: new Uint8ClampedArray(n), g: new Uint8ClampedArray(n), b: new Uint8ClampedArray(n), lum: new Uint8ClampedArray(n) };
    const chans = [R, G, Bc], dst = [out.r, out.g, out.b];
    for (let y = 0; y < h; y++) {
      const ny = (y / h) * 2 - 1;
      for (let x = 0; x < w; x++) {
        const nx = (x / w) * 2 - 1, f = bg.basis(nx, ny), i = y * w + x;
        for (let c = 0; c < 3; c++) {
          let b = 0; for (let k = 0; k < 6; k++) b += f[k] * bg.coefs[c][k];
          b = clamp(b, 40, 255);
          dst[c][i] = (chans[c][i] / b) * 255;
        }
        out.lum[i] = 0.299 * out.r[i] + 0.587 * out.g[i] + 0.114 * out.b[i];
      }
    }
    return out;
  }

  // sliding-window max/min (monotonic deque, O(n))
  function slide1D(src, out, len, stride, off, r, isMax, q) {
    let head = 0, tail = 0;
    for (let i = 0; i < len + r; i++) {
      if (i < len) { const v = src[off + i * stride]; while (tail > head && (isMax ? src[off + q[tail - 1] * stride] <= v : src[off + q[tail - 1] * stride] >= v)) tail--; q[tail++] = i; }
      const c = i - r; if (c < 0) continue;
      while (q[head] < c - r) head++;
      out[off + c * stride] = src[off + q[head] * stride];
    }
  }
  function filter2D(src, w, h, r, isMax) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), q = new Int32Array(Math.max(w, h) + 1);
    for (let y = 0; y < h; y++) slide1D(src, tmp, w, 1, y * w, r, isMax, q);
    for (let x = 0; x < w; x++) slide1D(tmp, out, h, w, x, r, isMax, q);
    return out;
  }
  const maxFilter = (src, w, h, r) => filter2D(src, w, h, r, true);
  function inkMask(norm, w, h, opts) {
    const n = w * h, hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[norm.lum[i]]++;
    const T = clamp(otsu(hist, n), 105, 205) + (opts.sensitivity || 0);
    const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = 255 - norm.lum[i];
    // morphological top-hat: darkness relative to the local paper (removes shadows / paper edges)
    const R2 = Math.max(10, Math.round(Math.min(w, h) / 55));
    const opened = filter2D(filter2D(d, w, h, R2, false), w, h, R2, true);
    const th = new Float32Array(n); for (let i = 0; i < n; i++) th[i] = d[i] - opened[i];
    const sample = []; for (let i = 0; i < n; i += 7) sample.push(th[i]); sample.sort((a, b) => a - b);
    const med = sample[sample.length >> 1]; const mad = median(sample.map((v) => abs(v - med))) || 1;
    const floor = med + Math.max(14, 7 * mad) - (opts.sensitivity || 0) * 0.5;
    const inkVals = sample.filter((v) => v > floor); inkVals.sort((a, b) => a - b);
    const peak = inkVals.length ? inkVals[Math.floor(inkVals.length * 0.9)] : 255;
    const R = Math.max(4, Math.round(Math.min(w, h) / 160));
    const lmax = maxFilter(th, w, h, R);
    const absDark = 255 - Math.min(T, 110); // solid dark areas (filled black shapes) are always ink
    const strong = new Uint8Array(n), weak = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const thrS = Math.max(floor, 0.5 * lmax[i], Math.min(255 - T, 0.42 * peak));
      const thrW = Math.max(floor * 0.9, 0.42 * lmax[i], Math.min(255 - T - 15, 0.34 * peak));
      const r = norm.r[i], g = norm.g[i], b = norm.b[i], ch = Math.max(r, g, b) - Math.min(r, g, b);
      if (th[i] > thrS || d[i] > absDark || ch > 70) strong[i] = 1; else if (th[i] > thrW || ch > 55) weak[i] = 1;
    }
    const mask = strong.slice(); const st = []; for (let i = 0; i < n; i++) if (strong[i]) st.push(i);
    while (st.length) { const p = st.pop(), x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const q = yy * w + xx; if (weak[q] && !mask[q]) { mask[q] = 1; st.push(q); } } }
    return { mask, T, faint: peak < 115 };
  }

  // ------------------------------------------------- 2. colour layers
  function colorLayers(norm, mask, n, opts) {
    const idx = []; for (let i = 0; i < n; i++) if (mask[i]) idx.push(i);
    if (!idx.length) return { labels: new Int16Array(n).fill(-1), centers: [] };
    const step = Math.max(1, Math.floor(idx.length / 20000));
    const S = []; for (let k = 0; k < idx.length; k += step) { const i = idx[k]; S.push([norm.r[i], norm.g[i], norm.b[i]]); }
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    // farthest point init starting from darkest
    let centers = [S.reduce((m, p) => (p[0] + p[1] + p[2] < m[0] + m[1] + m[2] ? p : m), S[0]).slice()];
    const maxK = opts.monochrome ? 1 : 8;
    while (centers.length < maxK) {
      let far = null, fd = -1;
      for (const p of S) { let md = Infinity; for (const c of centers) md = Math.min(md, d2(p, c)); if (md > fd) { fd = md; far = p; } }
      if (Math.sqrt(fd) < 75) break;
      centers.push(far.slice());
    }
    const assign = new Int16Array(S.length);
    for (let it = 0; it < 10; it++) {
      const acc = centers.map(() => [0, 0, 0, 0]);
      for (let s = 0; s < S.length; s++) {
        let bi = 0, bd = Infinity; for (let c = 0; c < centers.length; c++) { const d = d2(S[s], centers[c]); if (d < bd) { bd = d; bi = c; } }
        assign[s] = bi; const a = acc[bi]; a[0] += S[s][0]; a[1] += S[s][1]; a[2] += S[s][2]; a[3]++;
      }
      centers = centers.map((c, k) => (acc[k][3] ? [acc[k][0] / acc[k][3], acc[k][1] / acc[k][3], acc[k][2] / acc[k][3]] : c));
      // merge close / tiny clusters
      let merged = true;
      while (merged) {
        merged = false;
        const cnt = centers.map((_, k) => acc[k] ? acc[k][3] : 0);
        for (let a = 0; a < centers.length && !merged; a++) for (let b = a + 1; b < centers.length && !merged; b++) {
          const lumA = (centers[a][0] + centers[a][1] + centers[a][2]) / 3, lumB = (centers[b][0] + centers[b][1] + centers[b][2]) / 3;
          const chA = Math.max(...centers[a]) - Math.min(...centers[a]), chB = Math.max(...centers[b]) - Math.min(...centers[b]);
          const bothDarkNeutral = chA < 45 && chB < 45 && lumA < 150 && lumB < 150;
          if (Math.sqrt(d2(centers[a], centers[b])) < 60 || bothDarkNeutral) {
            const wa = cnt[a] + 1, wb = cnt[b] + 1;
            centers[a] = centers[a].map((v, i) => (v * wa + centers[b][i] * wb) / (wa + wb));
            // keep the darker/more saturated looking one as representative for neutrals
            if (bothDarkNeutral) centers[a] = lumA < lumB ? centers[a] : centers[a];
            centers.splice(b, 1); acc.splice(b, 1); merged = true;
          }
        }
      }
      const total = S.length;
      const accCnt = new Array(centers.length).fill(0); for (let s = 0; s < S.length; s++) if (assign[s] < centers.length) accCnt[assign[s]]++;
      if (centers.length > 1) {
        const tiny = accCnt.map((c, k) => (c < total * 0.004 ? k : -1)).filter((k) => k >= 0);
        if (tiny.length && tiny.length < centers.length) centers = centers.filter((_, k) => !tiny.includes(k));
      }
    }
    // final assignment for all ink pixels; pixels far from every centre (antialias mixes) get -2 = "uncertain"
    const labels = new Int16Array(n).fill(-1);
    const dists = new Float32Array(n);
    for (const i of idx) {
      const p = [norm.r[i], norm.g[i], norm.b[i]];
      let bi = 0, bd = Infinity; for (let c = 0; c < centers.length; c++) { const d = d2(p, centers[c]); if (d < bd) { bd = d; bi = c; } }
      labels[i] = bi; dists[i] = Math.sqrt(bd);
    }
    return { labels, centers, dists };
  }

  // ------------------------------------------------- 3. binary helpers
  function components(mask, w, h, minArea) {
    const n = w * h, lab = new Int32Array(n).fill(-1), comps = [];
    const stack = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (!mask[s] || lab[s] >= 0) continue;
      const id = comps.length; let sp = 0; stack[sp++] = s; lab[s] = id;
      const pix = []; let minx = w, miny = h, maxx = 0, maxy = 0;
      while (sp) {
        const p = stack[--sp]; pix.push(p);
        const x = p % w, y = (p / w) | 0;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const q = yy * w + xx; if (mask[q] && lab[q] < 0) { lab[q] = id; stack[sp++] = q; } } }
      }
      comps.push({ id, pix, area: pix.length, minx, miny, maxx, maxy });
    }
    return { lab, comps: comps.filter((c) => c.area >= minArea) };
  }

  // crop a component into a padded local bitmap
  function cropComp(c, w, pad) {
    const cw = c.maxx - c.minx + 1 + 2 * pad, chh = c.maxy - c.miny + 1 + 2 * pad;
    const m = new Uint8Array(cw * chh);
    for (const p of c.pix) { const x = (p % w) - c.minx + pad, y = ((p / w) | 0) - c.miny + pad; m[y * cw + x] = 1; }
    return { m, w: cw, h: chh, ox: c.minx - pad, oy: c.miny - pad };
  }

  function fillSmallHoles(bm, maxHole) {
    const { m, w, h } = bm, inv = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) inv[i] = m[i] ? 0 : 1;
    const { comps } = components4(inv, w, h);
    for (const c of comps) {
      if (c.minx === 0 || c.miny === 0 || c.maxx === w - 1 || c.maxy === h - 1) continue;
      if (c.area <= maxHole) for (const p of c.pix) m[p] = 1;
    }
  }
  function components4(mask, w, h) {
    const n = w * h, lab = new Int32Array(n).fill(-1), comps = [], stack = [];
    for (let s = 0; s < n; s++) {
      if (!mask[s] || lab[s] >= 0) continue;
      const id = comps.length; stack.length = 0; stack.push(s); lab[s] = id; const pix = [];
      let minx = w, miny = h, maxx = 0, maxy = 0;
      while (stack.length) {
        const p = stack.pop(); pix.push(p); const x = p % w, y = (p / w) | 0;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && mask[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; stack.push(p - 1); }
        if (x < w - 1 && mask[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; stack.push(p + 1); }
        if (y > 0 && mask[p - w] && lab[p - w] < 0) { lab[p - w] = id; stack.push(p - w); }
        if (y < h - 1 && mask[p + w] && lab[p + w] < 0) { lab[p + w] = id; stack.push(p + w); }
      }
      comps.push({ pix, area: pix.length, minx, miny, maxx, maxy });
    }
    return { lab, comps };
  }

  // exact Euclidean distance transform (Felzenszwalb) → distance to background
  function edt(bm) {
    const { m, w, h } = bm, INF = 1e12, f = new Float64Array(Math.max(w, h)), d = new Float64Array(w * h);
    const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1), out = new Float64Array(Math.max(w, h));
    function dt1(len) {
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0; for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    }
    for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = m[y * w + x] ? INF : 0; dt1(h); for (let y = 0; y < h; y++) d[y * w + x] = out[y]; }
    for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = d[y * w + x]; dt1(w); for (let x = 0; x < w; x++) d[y * w + x] = Math.sqrt(out[x]); }
    return d;
  }

  // Zhang–Suen thinning
  function thin(bm) {
    const { w, h } = bm, m = bm.m.slice();
    let changed = true; const del = [];
    while (changed) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        del.length = 0;
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
          const i = y * w + x; if (!m[i]) continue;
          const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1], p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9; if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (pass === 0) { if (p2 && p4 && p6) continue; if (p4 && p6 && p8) continue; }
          else { if (p2 && p4 && p8) continue; if (p2 && p6 && p8) continue; }
          del.push(i);
        }
        if (del.length) { changed = true; for (const i of del) m[i] = 0; }
      }
    }
    // remove redundant staircase pixels (keep 8-connectivity, 1px wide)
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (!m[i]) continue;
      const N = m[i - w], S = m[i + w], E = m[i + 1], W = m[i - 1];
      if ((N && E && !m[i + w - 1] && !S && !W) || (N && W && !m[i + w + 1] && !S && !E) ||
          (S && E && !m[i - w - 1] && !N && !W) || (S && W && !m[i - w + 1] && !N && !E)) m[i] = 0;
    }
    return m;
  }

  // ------------------------------------------------- 4. skeleton graph
  const NB = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  function skeletonGraph(sk, w, h) {
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? sk[y * w + x] : 0);
    const nodeId = new Int32Array(w * h).fill(-1), nodes = [];
    const cross = (x, y) => { let c = 0; for (let k = 0; k < 8; k++) { const a = at(x + NB[k][0], y + NB[k][1]), b = at(x + NB[(k + 1) % 8][0], y + NB[(k + 1) % 8][1]); if (!a && b) c++; } return c; };
    const deg = (x, y) => { let c = 0; for (const [dx, dy] of NB) c += at(x + dx, y + dy); return c; };
    const special = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!sk[y * w + x]) continue;
      const cn = cross(x, y), dg = deg(x, y);
      if (cn >= 3 || (dg >= 3 && cn !== 2)) special[y * w + x] = 2; else if (cn <= 1) special[y * w + x] = 1;
    }
    // group adjacent junction pixels
    for (let i = 0; i < w * h; i++) {
      if (!special[i] || nodeId[i] >= 0) continue;
      const id = nodes.length, st = [i], pix = []; nodeId[i] = id;
      while (st.length) {
        const p = st.pop(); pix.push(p); const x = p % w, y = (p / w) | 0;
        if (special[p] !== 2) continue;
        for (const [dx, dy] of NB) { const q = (y + dy) * w + (x + dx); if (at(x + dx, y + dy) && special[q] === 2 && nodeId[q] < 0) { nodeId[q] = id; st.push(q); } }
      }
      let sx = 0, sy = 0; for (const p of pix) { sx += p % w; sy += (p / w) | 0; }
      nodes.push({ id, pix, x: sx / pix.length, y: sy / pix.length, junction: special[i] === 2, edges: [] });
    }
    const visited = new Uint8Array(w * h), edges = [];
    function walk(startNode, sx, sy, fx, fy) {
      const pts = [[startNode.x, startNode.y], [fx, fy]];
      visited[fy * w + fx] = 1; let cx = fx, cy = fy, end = -1;
      for (let guard = 0; guard < w * h; guard++) {
        let nxt = null, nodeHit = -1;
        for (const [dx, dy] of NB) {
          const x = cx + dx, y = cy + dy; if (!at(x, y)) continue; const q = y * w + x;
          if (nodeId[q] >= 0) { if (nodeId[q] !== startNode.id || pts.length > 3) { if (nodeHit < 0 || nodeId[q] !== startNode.id) nodeHit = nodeId[q]; } continue; }
          if (visited[q]) continue;
          if (!nxt || (dx === 0 || dy === 0)) nxt = [x, y];
        }
        if (nodeHit >= 0 && (!nxt || pts.length > 2)) { end = nodeHit; break; }
        if (!nxt) break;
        visited[nxt[1] * w + nxt[0]] = 1; pts.push(nxt); cx = nxt[0]; cy = nxt[1];
      }
      if (end >= 0) pts.push([nodes[end].x, nodes[end].y]);
      return { pts, a: startNode.id, b: end };
    }
    for (const nd of nodes) {
      for (const p of nd.pix) {
        const x = p % w, y = (p / w) | 0;
        for (const [dx, dy] of NB) {
          const xx = x + dx, yy = y + dy; if (!at(xx, yy)) continue; const q = yy * w + xx;
          if (nodeId[q] >= 0 || visited[q]) continue;
          const e = walk(nd, x, y, xx, yy);
          if (e.b < 0) { // dead end without node (shouldn't happen often) → make an endpoint node
            const last = e.pts[e.pts.length - 1];
            const nn = { id: nodes.length, pix: [], x: last[0], y: last[1], junction: false, edges: [] };
            nodes.push(nn); e.b = nn.id;
          }
          edges.push(e);
        }
      }
    }
    // pure cycles
    for (let i = 0; i < w * h; i++) {
      if (!sk[i] || visited[i] || nodeId[i] >= 0) continue;
      const pts = []; let cx = i % w, cy = (i / w) | 0; visited[i] = 1; pts.push([cx, cy]);
      for (;;) {
        let nxt = null;
        for (const [dx, dy] of NB) { const x = cx + dx, y = cy + dy; if (!at(x, y) || visited[y * w + x]) continue; if (!nxt || dx === 0 || dy === 0) nxt = [x, y]; }
        if (!nxt) break; visited[nxt[1] * w + nxt[0]] = 1; pts.push(nxt); cx = nxt[0]; cy = nxt[1];
      }
      if (pts.length > 8) edges.push({ pts, a: -1, b: -1, cycle: true });
    }
    edges.forEach((e, k) => { e.id = k; if (e.a >= 0) nodes[e.a].edges.push(k); if (e.b >= 0) nodes[e.b].edges.push(k); });
    return { nodes, edges };
  }

  const pathLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; };

  // direction of edge leaving node `nid`, measured over distance d
  function edgeDirFrom(e, nid, d) {
    const pts = e.a === nid ? e.pts : e.pts.slice().reverse();
    let acc = 0, i = 1; for (; i < pts.length - 1 && acc < d; i++) acc += dist(pts[i - 1], pts[i]);
    return angOf(sub(pts[i], pts[0]));
  }

  // prune spurs, detect arrowheads, merge straight-through edges into chains
  function simplifyGraph(G, sw) {
    const { nodes, edges } = G; const alive = edges.map(() => true); const arrows = [];
    const len = edges.map((e) => pathLen(e.pts));
    const incident = (nid) => nodes[nid].edges.filter((k) => alive[k]);
    const otherEnd = (e, nid) => (e.a === nid ? e.b : e.a);
    const isTip = (nid) => incident(nid).length === 1;
    // contract very short junction–junction edges (split junctions in blobby areas)
    const rJ = Math.max(4, 1.6 * sw);
    for (const e of edges) {
      if (!alive[e.id] || e.cycle || e.a < 0 || e.b < 0 || e.a === e.b) continue;
      if (len[e.id] >= rJ || isTip(e.a) || isTip(e.b)) continue;
      const A = nodes[e.a], Bn = nodes[e.b]; alive[e.id] = false;
      const nx = (A.x + Bn.x) / 2, ny = (A.y + Bn.y) / 2; A.x = nx; A.y = ny;
      for (const k of Bn.edges) { if (k === e.id) continue; const o = edges[k]; if (o.a === Bn.id) o.a = A.id; if (o.b === Bn.id) o.b = A.id; A.edges.push(k); }
      Bn.edges = [];
      for (const k of A.edges) { const o = edges[k]; if (o.a === A.id) o.pts[0] = [nx, ny]; if (o.b === A.id) o.pts[o.pts.length - 1] = [nx, ny]; }
    }
    // arrowheads: junction with 2 short back-pointing barbs (+ optional short forward spur) and one shaft
    for (const nd of nodes) {
      const inc = [...new Set(incident(nd.id))]; if (inc.length < 3 || inc.length > 4) continue;
      const shortTip = inc.filter((k) => { const e = edges[k]; const o = otherEnd(e, nd.id); return o >= 0 && o !== nd.id && isTip(o) && len[k] < Math.max(10 * sw, 45); });
      const longs = inc.filter((k) => !shortTip.includes(k));
      let sh = null;
      if (longs.length === 1) sh = longs[0];
      else if (longs.length === 0) { sh = shortTip.slice().sort((x, y) => len[y] - len[x])[0]; }
      if (sh === null) continue;
      const others = shortTip.filter((k) => k !== sh);
      const as = edgeDirFrom(edges[sh], nd.id, Math.min(len[sh] / 2, 6 * sw));
      const barbs = [], fwd = [];
      for (const k of others) {
        const d = angDiff(edgeDirFrom(edges[k], nd.id, len[k] * 0.8), as);
        if (abs(d) > 0.2 && abs(d) < 1.3 && len[k] > 1.2 * sw) barbs.push([k, d]);
        else if (abs(d) > 2.4) fwd.push(k);
      }
      if (barbs.length !== 2 || fwd.length > 1 || barbs.length + fwd.length !== others.length) continue;
      if (Math.sign(barbs[0][1]) === Math.sign(barbs[1][1])) continue;
      if (len[sh] < 1.5 * Math.max(len[barbs[0][0]], len[barbs[1][0]])) continue;
      let tip = [nd.x, nd.y];
      if (fwd.length) { const e = edges[fwd[0]]; const o = nodes[otherEnd(e, nd.id)]; tip = [o.x, o.y]; alive[fwd[0]] = false; }
      alive[barbs[0][0]] = alive[barbs[1][0]] = false;
      arrows.push({ node: nd.id, tip, edge: sh, size: Math.max(dist(tip, [nd.x, nd.y]) + (len[barbs[0][0]] + len[barbs[1][0]]) / 2, 0), spread: (abs(barbs[0][1]) + abs(barbs[1][1])) / 2 });
    }
    // spur pruning
    const spur = Math.max(4, 1.6 * sw);
    for (let round = 0; round < 3; round++) {
      let any = false;
      for (const e of edges) {
        if (!alive[e.id] || e.cycle) continue;
        const ta = e.a >= 0 && isTip(e.a), tb = e.b >= 0 && isTip(e.b);
        if (len[e.id] < spur && ((ta && !tb && incident(e.b).length >= 3) || (tb && !ta && incident(e.a).length >= 3))) { alive[e.id] = false; any = true; }
      }
      if (!any) break;
    }
    // pair edge ends at nodes for continuation
    const pair = new Map(); // key `${edge}:${end}` -> key
    const key = (k, end) => k + ':' + end;
    for (const nd of nodes) {
      const inc = incident(nd.id); if (inc.length < 2) continue;
      const ends = [];
      for (const k of inc) { const e = edges[k]; if (e.a === nd.id) ends.push({ k, end: 'a' }); if (e.b === nd.id) ends.push({ k, end: 'b' }); }
      if (ends.length === 2 && !(ends[0].k === ends[1].k) && abs(angDiff(edgeDirFrom(edges[ends[0].k], nd.id, Math.max(8, 3 * sw)), edgeDirFrom(edges[ends[1].k], nd.id, Math.max(8, 3 * sw)))) > 0.9) { pair.set(key(ends[0].k, ends[0].end), key(ends[1].k, ends[1].end)); pair.set(key(ends[1].k, ends[1].end), key(ends[0].k, ends[0].end)); continue; }
      const dirs = ends.map((o) => { const e = edges[o.k]; const pts = o.end === 'a' ? e.pts : e.pts.slice().reverse(); let acc = 0, i = 1; const d = Math.min(len[o.k] * 0.6, Math.max(12, 4 * sw)); for (; i < pts.length - 1 && acc < d; i++) acc += dist(pts[i - 1], pts[i]); return angOf(sub(pts[i], pts[0])); });
      const cand = [];
      for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) { const d = abs(angDiff(dirs[i], dirs[j])); if (d > (145 * PI) / 180) cand.push([PI - d, i, j]); }
      cand.sort((p, q) => p[0] - q[0]); const used = new Set();
      for (const [, i, j] of cand) { if (used.has(i) || used.has(j)) continue; used.add(i); used.add(j); pair.set(key(ends[i].k, ends[i].end), key(ends[j].k, ends[j].end)); pair.set(key(ends[j].k, ends[j].end), key(ends[i].k, ends[i].end)); }
    }
    // build chains
    const usedE = new Set(), chains = [];
    function follow(startK, startEnd) { // startEnd = the end we start from (free end)
      let pts = [], k = startK, enterEnd = startEnd, closed = false; const nodeSeq = [];
      for (;;) {
        usedE.add(k); const e = edges[k];
        const seg = enterEnd === 'a' ? e.pts : e.pts.slice().reverse();
        pts = pts.length ? pts.concat(seg.slice(1)) : seg.slice();
        const exitEnd = enterEnd === 'a' ? 'b' : 'a';
        const nxt = pair.get(key(k, exitEnd)); if (!nxt) break;
        const [nk, ne] = nxt.split(':'); const nki = +nk;
        if (usedE.has(nki)) { if (nki === startK) closed = true; break; }
        k = nki; enterEnd = ne;
      }
      return { pts, closed };
    }
    for (const e of edges) {
      if (!alive[e.id] || usedE.has(e.id) || e.cycle) continue;
      if (!pair.has(key(e.id, 'a'))) chains.push(follow(e.id, 'a'));
      else if (!pair.has(key(e.id, 'b'))) chains.push(follow(e.id, 'b'));
    }
    for (const e of edges) { if (!alive[e.id] || usedE.has(e.id)) continue; if (e.cycle) { usedE.add(e.id); chains.push({ pts: e.pts.concat([e.pts[0]]), closed: true }); } else chains.push(follow(e.id, 'a')); }
    // arrow tips on chain endpoints
    const arrowPts = arrows.map((a) => ({ x: nodes[a.node].x, y: nodes[a.node].y, tip: a.tip, size: a.size, spread: a.spread }));
    return { chains, arrowPts };
  }

  // ------------------------------------------------- 5. curve analysis
  function resample(pts, step, closed) {
    const out = [pts[0].slice()]; let need = step;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = dist(a, b); let pos = 0;
      while (L - pos >= need) { pos += need; const f = pos / L; out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); need = step; }
      need -= L - pos;
    }
    const last = pts[pts.length - 1]; if (!closed && dist(out[out.length - 1], last) > step * 0.3) out.push(last.slice());
    if (closed && out.length > 2 && dist(out[out.length - 1], out[0]) < step * 0.5) out.pop();
    return out;
  }
  function smooth(pts, r, closed, iters) {
    let p = pts; const n = pts.length;
    for (let it = 0; it < (iters || 1); it++) {
      const q = p.map((v) => v.slice());
      for (let i = 0; i < n; i++) {
        if (!closed && (i < 1 || i > n - 2)) continue;
        let sx = 0, sy = 0, c = 0;
        for (let k = -r; k <= r; k++) { let j = i + k; if (closed) j = (j + n) % n; else j = clamp(j, 0, n - 1); const wt = r + 1 - abs(k); sx += p[j][0] * wt; sy += p[j][1] * wt; c += wt; }
        q[i] = [sx / c, sy / c];
      }
      p = q;
    }
    return p;
  }

  function turnAt(p, i, k, closed) {
    const n = p.length; let a = i - k, b = i + k;
    if (closed) { a = (a + n) % n; b = b % n; } else { if (a < 0 || b >= n) return 0; }
    const v1 = sub(p[i], p[a]), v2 = sub(p[b], p[i]);
    return abs(angDiff(angOf(v2), angOf(v1)));
  }

  function findCorners(p, step, sw, closed, sharp) {
    const n = p.length; const k1 = Math.max(2, Math.round(Math.max(5, 1.8 * sw) / step)), k2 = 2 * k1;
    const minTurn = ((sharp || 32) * PI) / 180;
    const score = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t1 = turnAt(p, i, k1, closed), t2 = turnAt(p, i, k2, closed);
      if (t1 > minTurn && t2 > minTurn * 0.9 && t1 > 0.62 * t2) score[i] = t1;
    }
    const corners = [];
    for (let i = 0; i < n; i++) {
      if (!score[i]) continue; let isMax = true;
      for (let k = -k2; k <= k2; k++) { let j = i + k; if (closed) j = (j + n) % n; else if (j < 0 || j >= n) continue; if (score[j] > score[i] || (score[j] === score[i] && j < i && k !== 0)) { isMax = false; break; } }
      if (isMax) corners.push(i);
    }
    if (!closed) return corners.filter((i) => i >= k1 && i <= n - 1 - k1);
    return corners;
  }

  function fitLine(pts) { // total least squares
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0; for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), dx = Math.cos(th), dy = Math.sin(th);
    let maxd = 0, ss = 0; for (const p of pts) { const d = abs(-(p[0] - mx) * dy + (p[1] - my) * dx); ss += d * d; if (d > maxd) maxd = d; }
    return { mx, my, dx, dy, maxd, rms: Math.sqrt(ss / pts.length) };
  }
  const projOnLine = (L, p) => { const t = (p[0] - L.mx) * L.dx + (p[1] - L.my) * L.dy; return [L.mx + t * L.dx, L.my + t * L.dy]; };

  function fitCircle(pts) {
    // Kåsa algebraic fit followed by Gauss-Newton geometric refinement
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
    let Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
    for (const p of pts) { const u = p[0] - mx, v = p[1] - my; Suu += u * u; Svv += v * v; Suv += u * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u; }
    const det = Suu * Svv - Suv * Suv; if (abs(det) < 1e-9) return null;
    const b1 = 0.5 * (Suuu + Suvv), b2 = 0.5 * (Svvv + Svuu);
    let cx = mx + (b1 * Svv - b2 * Suv) / det, cy = my + (Suu * b2 - Suv * b1) / det;
    let r = 0; for (const p of pts) r += dist(p, [cx, cy]); r /= pts.length;
    for (let it = 0; it < 12; it++) {
      let JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Jtr = [0, 0, 0];
      for (const p of pts) { const d = dist(p, [cx, cy]) || 1e-9; const res = d - r; const J = [-(p[0] - cx) / d, -(p[1] - cy) / d, -1];
        for (let i = 0; i < 3; i++) { Jtr[i] += J[i] * res; for (let j = 0; j < 3; j++) JtJ[i][j] += J[i] * J[j]; } }
      const s = solveLinear(JtJ, Jtr); if (!s) break; cx -= s[0]; cy -= s[1]; r -= s[2];
      if (abs(s[0]) + abs(s[1]) + abs(s[2]) < 1e-4) break;
    }
    let ss = 0, maxd = 0; for (const p of pts) { const d = abs(dist(p, [cx, cy]) - r); ss += d * d; if (d > maxd) maxd = d; }
    return { cx, cy, r: abs(r), rms: Math.sqrt(ss / pts.length), maxd };
  }

  function fitEllipse(pts) { // PCA based ellipse estimate + radial refinement
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0; for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(th), s = Math.sin(th);
    const loc = pts.map((p) => { const dx = p[0] - mx, dy = p[1] - my; return [dx * c + dy * s, -dx * s + dy * c]; });
    let a = 0, b = 0; for (const q of loc) { a = Math.max(a, abs(q[0])); b = Math.max(b, abs(q[1])); }
    // least squares for 1/a², 1/b² : x²A + y²B = 1
    let s11 = 0, s12 = 0, s22 = 0, r1 = 0, r2 = 0;
    for (const q of loc) { const X = q[0] * q[0], Y = q[1] * q[1]; s11 += X * X; s12 += X * Y; s22 += Y * Y; r1 += X; r2 += Y; }
    const sol = solveLinear([[s11, s12], [s12, s22]], [r1, r2]);
    if (sol && sol[0] > 0 && sol[1] > 0) { a = 1 / Math.sqrt(sol[0]); b = 1 / Math.sqrt(sol[1]); }
    let ss = 0, maxd = 0;
    for (const q of loc) { const t = Math.atan2(q[1] / b, q[0] / a); const e = [a * Math.cos(t), b * Math.sin(t)]; const d = dist(q, e); ss += d * d; maxd = Math.max(maxd, d); }
    return { cx: mx, cy: my, rx: a, ry: b, rot: th, rms: Math.sqrt(ss / pts.length), maxd };
  }

  // Schneider bezier fitting -------------------------------------------
  function bezierPt(b, t) { const mt = 1 - t; const a = mt * mt * mt, c = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t; return [a * b[0][0] + c * b[1][0] + d * b[2][0] + e * b[3][0], a * b[0][1] + c * b[1][1] + d * b[2][1] + e * b[3][1]]; }
  function normalize(v) { const l = hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
  function fitCubic(pts, tHat1, tHat2, err, out, depth) {
    const n = pts.length;
    if (n === 2) { const d = dist(pts[0], pts[1]) / 3; out.push([pts[0], [pts[0][0] + tHat1[0] * d, pts[0][1] + tHat1[1] * d], [pts[1][0] + tHat2[0] * d, pts[1][1] + tHat2[1] * d], pts[1]]); return; }
    let u = chordParam(pts); let bez = genBez(pts, u, tHat1, tHat2);
    let [maxE, split] = maxErr(pts, bez, u);
    if (maxE < err) { out.push(bez); return; }
    if (maxE < err * 4) for (let i = 0; i < 6; i++) { u = reparam(pts, u, bez); bez = genBez(pts, u, tHat1, tHat2); [maxE, split] = maxErr(pts, bez, u); if (maxE < err) { out.push(bez); return; } }
    if (depth > 12) { out.push(bez); return; }
    split = clamp(split, 1, n - 2);
    const tc = normalize(sub(pts[split - 1], pts[split + 1]));
    fitCubic(pts.slice(0, split + 1), tHat1, tc, err, out, depth + 1);
    fitCubic(pts.slice(split), [-tc[0], -tc[1]], tHat2, err, out, depth + 1);
  }
  function chordParam(pts) { const u = [0]; for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + dist(pts[i], pts[i - 1])); const L = u[u.length - 1] || 1; return u.map((v) => v / L); }
  function genBez(pts, u, t1, t2) {
    const n = pts.length, p0 = pts[0], p3 = pts[n - 1]; let C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0;
    for (let i = 0; i < n; i++) {
      const t = u[i], mt = 1 - t, b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
      const A1 = [t1[0] * b1, t1[1] * b1], A2 = [t2[0] * b2, t2[1] * b2];
      C00 += A1[0] * A1[0] + A1[1] * A1[1]; C01 += A1[0] * A2[0] + A1[1] * A2[1]; C11 += A2[0] * A2[0] + A2[1] * A2[1];
      const tmp = [pts[i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3)), pts[i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3))];
      X0 += A1[0] * tmp[0] + A1[1] * tmp[1]; X1 += A2[0] * tmp[0] + A2[1] * tmp[1];
    }
    const det = C00 * C11 - C01 * C01; let a1 = 0, a2 = 0;
    if (abs(det) > 1e-12) { a1 = (X0 * C11 - X1 * C01) / det; a2 = (C00 * X1 - C01 * X0) / det; }
    const segL = dist(p0, p3), eps = 1e-6 * segL;
    if (a1 < eps || a2 < eps || a1 > segL * 2 || a2 > segL * 2) { a1 = a2 = segL / 3; }
    return [p0, [p0[0] + t1[0] * a1, p0[1] + t1[1] * a1], [p3[0] + t2[0] * a2, p3[1] + t2[1] * a2], p3];
  }
  function maxErr(pts, bez, u) { let m = 0, s = (pts.length / 2) | 0; for (let i = 1; i < pts.length - 1; i++) { const d = dist(bezierPt(bez, u[i]), pts[i]); if (d > m) { m = d; s = i; } } return [m, s]; }
  function reparam(pts, u, b) {
    return u.map((t, i) => {
      const q = bezierPt(b, t), mt = 1 - t;
      const q1 = [3 * (mt * mt * (b[1][0] - b[0][0]) + 2 * mt * t * (b[2][0] - b[1][0]) + t * t * (b[3][0] - b[2][0])), 3 * (mt * mt * (b[1][1] - b[0][1]) + 2 * mt * t * (b[2][1] - b[1][1]) + t * t * (b[3][1] - b[2][1]))];
      const q2 = [6 * (mt * (b[2][0] - 2 * b[1][0] + b[0][0]) + t * (b[3][0] - 2 * b[2][0] + b[1][0])), 6 * (mt * (b[2][1] - 2 * b[1][1] + b[0][1]) + t * (b[3][1] - 2 * b[2][1] + b[1][1]))];
      const num = (q[0] - pts[i][0]) * q1[0] + (q[1] - pts[i][1]) * q1[1], den = q1[0] * q1[0] + q1[1] * q1[1] + (q[0] - pts[i][0]) * q2[0] + (q[1] - pts[i][1]) * q2[1];
      return abs(den) < 1e-12 ? t : clamp(t - num / den, 0, 1);
    });
  }
  function fitBeziers(pts, err) {
    if (pts.length < 2) return [];
    const n = pts.length, k = Math.min(3, n - 1);
    const t1 = normalize(sub(pts[k], pts[0])), t2 = normalize(sub(pts[n - 1 - k], pts[n - 1]));
    const out = []; fitCubic(pts, t1, t2, err, out, 0); return out;
  }

  // classify one open piece (between corners)
  function classifyPiece(p, sw, scale, glyph) {
    const L = pathLen(p), a = p[0], b = p[p.length - 1];
    const line = fitLine(p);
    const lineTol = Math.max(2.2, 0.55 * sw, 0.022 * L) * scale;
    if (line.maxd < lineTol * 1.6 && line.rms < lineTol * 0.6) return { t: 'L' };
    const c = glyph ? null : fitCircle(p);
    if (c && c.r < 4000) {
      const sweep = L / c.r;
      if (sweep > 0.45 && c.rms < Math.max(1.1, 0.014 * c.r) * scale && c.maxd < Math.max(2.8, 0.035 * c.r) * scale) {
        // direction (sweep sign) from cross product
        const mid = p[(p.length / 2) | 0]; const cr = (mid[0] - a[0]) * (b[1] - a[1]) - (mid[1] - a[1]) * (b[0] - a[0]);
        return { t: 'A', cx: c.cx, cy: c.cy, r: c.r, mid: mid.slice() };
      }
    }
    const bz = fitBeziers(p, Math.max(1.5, 0.45 * sw) * scale);
    return { t: 'C', beziers: bz };
  }

  // analyse a chain of centre-line points → element(s)
  function analyseStroke(chain, sw, opts) {
    const scale = opts.tolScale || 1;
    const step = Math.max(1, Math.min(2, sw / 3));
    let p = resample(chain.pts, step, chain.closed);
    if (p.length < 3) return null;
    p = smooth(p, Math.max(1, Math.round(sw / 2 / step)), chain.closed, 2);
    const L = pathLen(p);
    if (chain.closed) {
      const c = fitCircle(p);
      if (c && c.rms < Math.max(1.4, 0.045 * c.r) * scale && c.maxd < Math.max(3, 0.12 * c.r) * scale)
        return { shape: 'circle', cx: c.cx, cy: c.cy, r: c.r };
      const corners = findCorners(p, step, sw, true);
      if (corners.length < 2) {
        const e = fitEllipse(p);
        if (e.rms < Math.max(1.6, 0.04 * Math.min(e.rx, e.ry)) * scale * 1.3 && e.maxd < Math.max(4, 0.12 * Math.min(e.rx, e.ry)) * scale) {
          let rot = e.rot; const deg = ((rot * 180) / PI + 360) % 180;
          if (deg < 5 || deg > 175) rot = 0; else if (abs(deg - 90) < 5) rot = PI / 2;
          return { shape: 'ellipse', cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, rot };
        }
      }
      return piecewise(p, corners, true, sw, scale, step);
    }
    const corners = findCorners(p, step, sw, false);
    return piecewise(p, corners, false, sw, scale, step);
  }

  // corner indices → path {verts, segs, closed}
  function piecewise(p, corners, closed, sw, scale, step, glyph) {
    const n = p.length; let idx;
    if (closed) { if (!corners.length) { const c = fitCircle(p); return { shape: 'path', verts: [p[0]], segs: [{ t: 'C', beziers: fitBeziers(p.concat([p[0]]), Math.max(1.5, 0.45 * sw) * scale) }], closed: true }; } idx = corners.slice(); }
    else idx = [0].concat(corners, [n - 1]);
    const pieces = [];
    const cnt = closed ? idx.length : idx.length - 1;
    for (let s = 0; s < cnt; s++) {
      const i0 = idx[s], i1 = closed ? idx[(s + 1) % idx.length] : idx[s + 1];
      const seg = []; let i = i0; for (;;) { seg.push(p[i]); if (i === i1) break; i = (i + 1) % n; if (seg.length > n + 1) break; }
      pieces.push(seg);
    }
    let verts = idx.map((i) => p[i].slice());
    let segs = pieces.map((seg) => classifyPiece(seg, sw, scale, glyph));
    if (!glyph) {
      // (1) drop mild corners between two curved pieces → one smooth curve
      for (let v = 0; v < idx.length; v++) {
        const prev = closed ? (v - 1 + segs.length) % segs.length : v - 1;
        if (prev < 0 || v >= segs.length || prev === v) continue;
        if (segs[prev].t === 'L' || segs[v].t === 'L') continue;
        const i = idx[v], kk = Math.max(3, Math.round((3 * sw) / step));
        const t = turnAt(p, i, Math.min(kk, Math.floor(pieces[v].length / 2), Math.floor(pieces[prev].length / 2)) || 1, closed);
        if (t < (40 * PI) / 180) {
          const nc = corners.filter((c) => c !== i);
          if (nc.length !== corners.length) return piecewise(p, nc, closed, sw, scale, step, glyph);
        }
      }
      // (2) curved piece that is really 2–3 straight strokes (wobbly hand-drawn polyline)
      const nv = [verts[0]], ns = [], np = [];
      for (let k = 0; k < segs.length; k++) {
        const seg = pieces[k]; let repl = null;
        if (segs[k].t === 'C' && seg.length > 8) {
          const lt = Math.max(2.2, 0.55 * sw);
          const d = dp(seg, lt * 1.4);
          if (d.length >= 3 && d.length <= 4) {
            const idxs = d.map((q) => seg.indexOf(q));
            const subs = []; let ok = true;
            for (let j = 0; j < d.length - 1; j++) { const sp = seg.slice(idxs[j], idxs[j + 1] + 1); const L = fitLine(sp); if (L.maxd > Math.max(lt * 1.6, 0.03 * pathLen(sp)) || pathLen(sp) < 3 * sw) ok = false; subs.push(sp); }
            for (let j = 1; j < d.length - 1 && ok; j++) if (abs(angDiff(angOf(sub(d[j + 1], d[j])), angOf(sub(d[j], d[j - 1])))) < 0.3) ok = false;
            if (ok) repl = subs;
          }
        }
        if (repl) { repl.forEach((sp, j) => { if (j > 0) nv.push(sp[0].slice()); ns.push({ t: 'L' }); np.push(sp); }); }
        else { ns.push(segs[k]); np.push(seg); }
        if (k < segs.length - 1 || !closed) nv.push(verts[(k + 1) % verts.length]);
      }
      if (ns.length !== segs.length) { verts = closed ? nv.slice(0, ns.length) : nv; segs = ns; pieces.length = 0; pieces.push(...np); }
    }
    // refine vertices: where two lines meet → intersection
    const lineFits = pieces.map((seg, k) => (segs[k].t === 'L' ? fitLine(seg) : null));
    const vcount = verts.length;
    for (let v = 0; v < vcount; v++) {
      const prev = closed ? (v - 1 + segs.length) % segs.length : v - 1, next = v;
      if (prev < 0 || next >= segs.length) { // open endpoints: project onto own line
        const k = prev < 0 ? next : prev; if (lineFits[k]) verts[v] = projOnLine(lineFits[k], verts[v]);
        continue;
      }
      if (lineFits[prev] && lineFits[next]) {
        const X = intersect(lineFits[prev], lineFits[next]);
        if (X && dist(X, verts[v]) < (glyph ? 2.5 : Math.max(12, 4 * sw))) verts[v] = X;
      } else if (lineFits[prev]) verts[v] = projOnLine(lineFits[prev], verts[v]);
      else if (lineFits[next]) verts[v] = projOnLine(lineFits[next], verts[v]);
    }
    // re-anchor bezier ends to vertices
    segs.forEach((s, k) => { if (s.t === 'C' && s.beziers.length) { const a = verts[k], b = verts[(k + 1) % verts.length]; s.beziers[0][0] = a; s.beziers[s.beziers.length - 1][3] = b; } });
    const allLines = segs.every((s) => s.t === 'L');
    let shape = 'path';
    if (allLines) shape = closed ? (verts.length === 3 ? 'triangle' : verts.length === 4 ? 'quad' : 'polygon') : verts.length === 2 ? 'line' : 'polyline';
    else if (!closed && segs.length === 1 && segs[0].t === 'A') shape = 'arc';
    else if (!closed && segs.length === 1) shape = 'curve';
    return { shape, verts, segs, closed };
  }
  function intersect(L1, L2) {
    const det = L1.dx * L2.dy - L1.dy * L2.dx; if (abs(det) < 0.08) return null;
    const t = ((L2.mx - L1.mx) * L2.dy - (L2.my - L1.my) * L2.dx) / det;
    return [L1.mx + t * L1.dx, L1.my + t * L1.dy];
  }
  function intersectPts(a1, a2, b1, b2) {
    const d1 = sub(a2, a1), d2 = sub(b2, b1), det = d1[0] * d2[1] - d1[1] * d2[0];
    if (abs(det) < 1e-9) return null;
    const t = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / det;
    return [a1[0] + t * d1[0], a1[1] + t * d1[1]];
  }

  // ------------------------------------------------- 6. outlines (filled regions / glyphs)
  // trace pixel-edge boundaries; inside on the left. returns loops of lattice points
  function traceOutlines(bm) {
    const { m, w, h } = bm; const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? m[y * w + x] : 0);
    // directed edges stored by start vertex; vertex id = y*(w+1)+x
    const W1 = w + 1; const out = new Map();
    const add = (x0, y0, x1, y1) => { const k = y0 * W1 + x0; if (!out.has(k)) out.set(k, []); out.get(k).push([x1, y1]); };
    for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) {
      // horizontal edge between pixel (x,y-1) above and (x,y) below, spanning x..x+1
      if (x < w) { const a = at(x, y - 1), b = at(x, y); if (b && !a) add(x + 1, y, x, y); else if (a && !b) add(x, y, x + 1, y); }
      if (y < h) { const l = at(x - 1, y), r = at(x, y); if (r && !l) add(x, y, x, y + 1); else if (l && !r) add(x, y + 1, x, y); }
    }
    const loops = [];
    for (const [k, list] of out) {
      while (list.length) {
        const sx = k % W1, sy = (k / W1) | 0; const loop = [[sx, sy]];
        let [cx, cy] = list.pop(); let px = sx, py = sy;
        for (let guard = 0; guard < 4 * w * h; guard++) {
          if (cx === sx && cy === sy) break;
          loop.push([cx, cy]);
          const L = out.get(cy * W1 + cx); if (!L || !L.length) break;
          let pick = 0;
          if (L.length > 1) { // ambiguous: prefer right turn (keeps diagonal pixels separate)
            const din = [cx - px, cy - py];
            let best = -9; L.forEach((q, i) => { const dq = [q[0] - cx, q[1] - cy]; const cr = din[0] * dq[1] - din[1] * dq[0]; const sc = cr > 0 ? 2 : cr === 0 ? 1 : 0; if (sc > best) { best = sc; pick = i; } });
          }
          const nx = L.splice(pick, 1)[0]; px = cx; py = cy; cx = nx[0]; cy = nx[1];
        }
        if (loop.length >= 4) loops.push(loop);
      }
    }
    return loops;
  }
  function dp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    let md = 0, mi = 0; const a = pts[0], b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) { const pr = projSeg(pts[i], a, b) || { d: dist(pts[i], a) }; if (pr.d > md) { md = pr.d; mi = i; } }
    if (md <= eps) return [a, b];
    return dp(pts.slice(0, mi + 1), eps).slice(0, -1).concat(dp(pts.slice(mi), eps));
  }
  function dpClosed(loop, eps) { // split at farthest point from start
    let fi = 0; for (let i = 0; i < loop.length; i++) if (dist(loop[i], loop[0]) > dist(loop[fi], loop[0])) fi = i;
    const A = dp(loop.slice(0, fi + 1), eps), B = dp(loop.slice(fi).concat([loop[0]]), eps);
    return A.slice(0, -1).concat(B.slice(0, -1));
  }
  function loopArea(l) { let a = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

  function analyseOutline(loop, sw, opts, isGlyph) {
    const scale = opts.tolScale || 1;
    const step = 1;
    let p = resample(loop.concat([loop[0]]), step, true);
    if (p.length < 6) return null;
    p = smooth(p, 1, true, isGlyph ? 1 : 2);
    const area = abs(loopArea(p));
    const c = fitCircle(p);
    if (c && c.rms < Math.max(0.9, 0.025 * c.r) * scale && c.maxd < Math.max(2.2, 0.07 * c.r) * scale) return { shape: 'circle', cx: c.cx, cy: c.cy, r: c.r, area };
    const ew = isGlyph ? 1.2 : 2.2;
    const corners = findCorners(p, step, ew, true, isGlyph ? 40 : 30);
    if (!isGlyph && corners.length < 2) {
      const e = fitEllipse(p);
      if (e.rms < Math.max(1, 0.03 * Math.min(e.rx, e.ry)) * scale && e.maxd < Math.max(2.5, 0.08 * Math.min(e.rx, e.ry)) * scale) return { shape: 'ellipse', cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, rot: e.rot, area };
    }
    const r = piecewise(p, corners, true, ew, isGlyph ? 0.6 * scale : scale, step, isGlyph);
    if (r.verts && r.verts.length < 3) { // thin/tiny loop: fall back to a simplified polygon of the raw outline
      const poly = dpClosed(loop, 0.75);
      if (poly.length >= 3) return { shape: 'polygon', verts: poly, segs: poly.map(() => ({ t: 'L' })), closed: true, area };
    }
    r.area = area; return r;
  }

  // ------------------------------------------------- 7. beautify (global)
  function snapAngle(theta, opts) {
    const deg = ((theta * 180) / PI) % 180; const d = deg < 0 ? deg + 180 : deg;
    const targets = [[0, 6], [90, 6], [180, 6], [45, 3.5], [135, 3.5], [30, 2.5], [60, 2.5], [120, 2.5], [150, 2.5]];
    for (const [t, tol] of targets) if (abs(d - t) < tol * (opts.snapStrength || 1)) return (t * PI) / 180 * (theta < 0 && false ? -1 : 1);
    return null;
  }

  function beautify(els, sw, opts) {
    const weldTol = Math.max(7, 2.6 * sw) * (opts.snapStrength || 1);
    // (a) angle snap for straight lines + rectangles/regular shapes
    for (const e of els) {
      if (e.shape === 'line') {
        const [a, b] = e.verts; const th = angOf(sub(b, a)); const L = dist(a, b);
        const s = snapAngle(th, opts);
        if (s !== null) {
          const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; let dir = [Math.cos(s), Math.sin(s)];
          if (dir[0] * (b[0] - a[0]) + dir[1] * (b[1] - a[1]) < 0) dir = [-dir[0], -dir[1]];
          e.verts = [[m[0] - (dir[0] * L) / 2, m[1] - (dir[1] * L) / 2], [m[0] + (dir[0] * L) / 2, m[1] + (dir[1] * L) / 2]];
        }
      }
      if ((e.shape === 'quad') && e.segs.every((s) => s.t === 'L')) rectify(e, opts);
      if (e.shape === 'triangle' && opts.regularize !== false) regularTriangle(e);
      if (e.shape === 'ellipse' && abs(e.rx - e.ry) / Math.max(e.rx, e.ry) < 0.06) { const r = (e.rx + e.ry) / 2; Object.assign(e, { shape: 'circle', r }); }
      if (e.shape === 'polyline' || e.shape === 'polygon') for (let k = 0; k < e.segs.length; k++) snapPolySeg(e, k, opts);
    }
    if (opts.weld === false) return;
    // (b) collect open ends
    const ends = [];
    for (const e of els) {
      if (e.kind !== 'stroke' || e.closed || !e.verts) continue;
      ends.push({ e, i: 0, p: e.verts[0] }); ends.push({ e, i: e.verts.length - 1, p: e.verts[e.verts.length - 1] });
    }
    // cluster ends
    const used = new Set();
    for (let i = 0; i < ends.length; i++) {
      if (used.has(i)) continue; const cl = [i];
      for (let j = i + 1; j < ends.length; j++) if (!used.has(j) && cl.some((k) => dist(ends[k].p, ends[j].p) < weldTol)) cl.push(j);
      if (cl.length < 2) continue; cl.forEach((k) => used.add(k));
      const lines = cl.filter((k) => ends[k].e.shape === 'line' || adjacentIsLine(ends[k]));
      let P = null;
      if (lines.length >= 2) {
        // intersection of two longest lines (most reliable directions)
        const sorted = lines.map((k) => ({ k, L: adjLen(ends[k]) })).sort((x, y) => y.L - x.L);
        const A = ends[sorted[0].k], B = ends[sorted[1].k];
        const X = intersectPts(...adjSeg(A), ...adjSeg(B));
        const cen = centroid(cl.map((k) => ends[k].p));
        if (X && dist(X, cen) < weldTol * 2.2) P = X;
      }
      if (!P) P = centroid(cl.map((k) => ends[k].p));
      for (const k of cl) moveEnd(ends[k], P);
    }
    // (c) T-junctions & touching circles: free ends near other shapes
    for (let i = 0; i < ends.length; i++) {
      if (used.has(i)) continue; const en = ends[i]; let best = null, bd = weldTol;
      for (const o of els) {
        if (o === en.e) continue;
        if (o.shape === 'circle') {
          const dc = dist(en.p, [o.cx, o.cy]);
          if (dc < bd) { bd = dc; best = [o.cx, o.cy]; }
          const dr = abs(dc - o.r); if (dr < bd) { bd = dr; const u = normalize(sub(en.p, [o.cx, o.cy])); best = lineCircleSnap(en, o) || [o.cx + u[0] * o.r, o.cy + u[1] * o.r]; }
          continue;
        }
        if (!o.verts) continue;
        const segCount = o.closed ? o.verts.length : o.verts.length - 1;
        for (let s = 0; s < segCount; s++) {
          if (o.segs && o.segs[s] && o.segs[s].t !== 'L') continue;
          const a = o.verts[s], b = o.verts[(s + 1) % o.verts.length];
          const pr = projSeg(en.p, a, b); if (!pr) continue;
          if (pr.d < bd) {
            bd = pr.d;
            // keep direction of own line: intersect own line with target segment
            let X = null; if (en.e.shape === 'line' || adjacentIsLine(en)) X = intersectPts(...adjSeg(en), a, b);
            best = X && dist(X, en.p) < weldTol * 2 ? X : pr.q;
            // perpendicular snap (altitudes, normals): if nearly perpendicular make it exact
            if (en.e.shape === 'line') {
              const other = en.e.verts[en.i === 0 ? 1 : 0];
              const ang = abs(angDiff(angOf(sub(b, a)), angOf(sub(en.p, other))));
              if (abs(ang - PI / 2) < (6 * PI) / 180) { const f = projSeg(other, a, b, true); if (f) best = f.q; }
            }
          }
        }
        for (const v of o.verts) { const d = dist(v, en.p); if (d < bd * 0.9) { bd = d; best = v.slice(); } }
      }
      if (best) moveEnd(en, best);
    }
  }
  function lineCircleSnap(en, c) {
    if (en.e.shape !== 'line') return null;
    const [a, b] = adjSeg(en); const d = normalize(sub(b, a)); const f = sub(a, [c.cx, c.cy]);
    const B = 2 * (f[0] * d[0] + f[1] * d[1]), C = f[0] * f[0] + f[1] * f[1] - c.r * c.r, disc = B * B - 4 * C;
    if (disc < 0) return null; const s = Math.sqrt(disc);
    const cands = [(-B - s) / 2, (-B + s) / 2].map((t) => [a[0] + t * d[0], a[1] + t * d[1]]);
    return cands.sort((x, y) => dist(x, en.p) - dist(y, en.p))[0];
  }
  function centroid(ps) { let x = 0, y = 0; for (const p of ps) { x += p[0]; y += p[1]; } return [x / ps.length, y / ps.length]; }
  function adjacentIsLine(en) { const e = en.e; if (!e.segs) return false; const k = en.i === 0 ? 0 : e.segs.length - 1; return e.segs[k] && e.segs[k].t === 'L'; }
  function adjSeg(en) { const v = en.e.verts; return en.i === 0 ? [v[1], v[0]] : [v[v.length - 2], v[v.length - 1]]; }
  function adjLen(en) { const [a, b] = adjSeg(en); return dist(a, b); }
  function projSeg(p, a, b, infinite) {
    const d = sub(b, a), L2 = d[0] * d[0] + d[1] * d[1]; if (L2 < 1e-9) return null;
    let t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L2;
    if (!infinite) { if (t < -0.02 || t > 1.02) return null; t = clamp(t, 0, 1); }
    const q = [a[0] + t * d[0], a[1] + t * d[1]]; return { q, d: dist(p, q), t };
  }
  function moveEnd(en, P) {
    const e = en.e, old = e.verts[en.i], dx = P[0] - old[0], dy = P[1] - old[1];
    e.verts[en.i] = P.slice(); en.p = e.verts[en.i];
    if (!e.segs) return;
    const k = en.i === 0 ? 0 : e.segs.length - 1, s = e.segs[k];
    if (s && s.t === 'C' && s.beziers.length) {
      if (en.i === 0) { const b = s.beziers[0]; b[0] = P.slice(); b[1] = [b[1][0] + dx, b[1][1] + dy]; }
      else { const b = s.beziers[s.beziers.length - 1]; b[3] = P.slice(); b[2] = [b[2][0] + dx, b[2][1] + dy]; }
    }
  }
  function snapPolySeg(e, k, opts) {
    // snap individual polyline/polygon edges to H/V when very close (keeps others)
    const n = e.verts.length; const a = e.verts[k], b = e.verts[(k + 1) % n]; if (!b) return;
    const th = angOf(sub(b, a)); const deg = (((th * 180) / PI) % 180 + 180) % 180;
    if (deg < 3 || deg > 177) { const y = (a[1] + b[1]) / 2; a[1] = y; b[1] = y; }
    else if (abs(deg - 90) < 3) { const x = (a[0] + b[0]) / 2; a[0] = x; b[0] = x; }
  }
  function rectify(e, opts) {
    const v = e.verts; const ang = [];
    for (let i = 0; i < 4; i++) { const p = v[(i + 3) % 4], q = v[i], r = v[(i + 1) % 4]; ang.push(abs(angDiff(angOf(sub(r, q)), angOf(sub(p, q))))); }
    if (ang.every((a) => abs(a - PI / 2) < (14 * PI) / 180)) {
      // best-fit rectangle: orientation from averaged edge angles (mod 90°)
      let sx = 0, sy = 0;
      for (let i = 0; i < 4; i++) { const t = angOf(sub(v[(i + 1) % 4], v[i])) * 4; const L = dist(v[i], v[(i + 1) % 4]); sx += Math.cos(t) * L; sy += Math.sin(t) * L; }
      let th = Math.atan2(sy, sx) / 4; const sn = snapAngle(th, opts); if (sn !== null) th = sn % (PI / 2);
      const c = centroid(v), u = [Math.cos(th), Math.sin(th)], w = [-u[1], u[0]];
      const pu = v.map((p) => (p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1]), pw = v.map((p) => (p[0] - c[0]) * w[0] + (p[1] - c[1]) * w[1]);
      const hu = (abs(pu[0]) + abs(pu[1]) + abs(pu[2]) + abs(pu[3])) / 4, hw = (abs(pw[0]) + abs(pw[1]) + abs(pw[2]) + abs(pw[3])) / 4;
      e.verts = v.map((p, i) => { const su = Math.sign(pu[i]) || 1, sw2 = Math.sign(pw[i]) || 1; return [c[0] + su * hu * u[0] + sw2 * hw * w[0], c[1] + su * hu * u[1] + sw2 * hw * w[1]]; });
      e.shape = abs(hu - hw) / Math.max(hu, hw) < 0.04 ? 'square' : 'rect'; e.rot = th;
      if (e.shape === 'square') { const s = (hu + hw) / 2; e.verts = e.verts.map((p, i) => { const su = Math.sign(pu[i]) || 1, sw2 = Math.sign(pw[i]) || 1; return [c[0] + su * s * u[0] + sw2 * s * w[0], c[1] + su * s * u[1] + sw2 * s * w[1]]; }); }
    } else {
      for (let k = 0; k < 4; k++) snapPolySeg(e, k, opts);
    }
  }
  function regularTriangle(e) {
    const v = e.verts, L = [dist(v[0], v[1]), dist(v[1], v[2]), dist(v[2], v[0])];
    const mx = Math.max(...L), mn = Math.min(...L);
    if ((mx - mn) / mx < 0.05) { // equilateral
      const c = centroid(v), R = (L[0] + L[1] + L[2]) / 3 / Math.sqrt(3); const a0 = angOf(sub(v[0], c));
      let base = a0; const sn = snapAngle(a0 + PI / 2, {}); if (sn !== null) base = sn - PI / 2;
      e.verts = [0, 1, 2].map((i) => [c[0] + R * Math.cos(base + (i * 2 * PI) / 3 * Math.sign(loopArea(v) || 1)), c[1] + R * Math.sin(base + (i * 2 * PI) / 3 * Math.sign(loopArea(v) || 1))]);
      e.shape = 'triangle'; e.equilateral = true; return;
    }
    // horizontal base snap
    for (let i = 0; i < 3; i++) { const a = v[i], b = v[(i + 1) % 3]; const deg = abs(((angOf(sub(b, a)) * 180) / PI) % 180); if (deg < 4 || deg > 176) { const y = (a[1] + b[1]) / 2; a[1] = b[1] = y; } else if (abs(deg - 90) < 4) { const x = (a[0] + b[0]) / 2; a[0] = b[0] = x; } }
  }


  function elemLen(e) { if (!e.verts) return 0; let L = 0; for (let i = 1; i < e.verts.length; i++) L += dist(e.verts[i - 1], e.verts[i]); return L; }
  function splitHairpins(els, sw) {
    const barbMax = Math.max(12 * sw, 50), out = [];
    for (const e of els) {
      if (e.kind !== 'stroke' || !e.verts || e.closed || e.verts.length < 3 || !e.segs.every((s) => s.t === 'L')) { out.push(e); continue; }
      let v = e.verts; const pieces = [];
      const turnSharp = (a, b, c) => abs(angDiff(angOf(sub(a, b)), angOf(sub(c, b)))) < 0.9;
      // first and last pieces only
      if (turnSharp(v[0], v[1], v[2]) && dist(v[0], v[1]) < barbMax) { pieces.push([v[0], v[1]]); v = v.slice(1); }
      if (v.length >= 3 && turnSharp(v[v.length - 3], v[v.length - 2], v[v.length - 1]) && dist(v[v.length - 2], v[v.length - 1]) < barbMax) { pieces.push([v[v.length - 2], v[v.length - 1]]); v = v.slice(0, -1); }
      if (!pieces.length) { out.push(e); continue; }
      const main = Object.assign({}, e, { verts: v.map((p) => p.slice()), segs: v.slice(1).map(() => ({ t: 'L' })) }); main.shape = v.length === 2 ? 'line' : 'polyline';
      out.push(main);
      for (const p of pieces) out.push(Object.assign({}, e, { verts: p.map((q) => q.slice()), segs: [{ t: 'L' }], shape: 'line', arrows: undefined }));
    }
    return out;
  }
  function detectArrowsGeometric(els, sw, mask, w, h) {
    const barbMax = Math.max(12 * sw, 50), near = 2.8 * sw + 4;
    const remove = new Set();
    const inkAt = (x, y) => { let c = 0, t = 0; const r = Math.max(1, Math.round(sw * 0.6)); for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = Math.round(x + dx), yy = Math.round(y + dy); if (xx >= 0 && yy >= 0 && xx < w && yy < h) { t++; c += mask[yy * w + xx]; } } return t ? c / t : 0; };
    const cands = els.filter((e) => e.kind === 'stroke' && e.verts && !e.closed && elemLen(e) < barbMax && e.segs.every((s) => s.t === 'L'));
    for (const E of els) {
      if (E.kind !== 'stroke' || !E.verts || E.closed || remove.has(E)) continue;
      const EL = elemLen(E); if (EL < 2.2 * barbMax * 0.5) continue;
      for (const i of [0, E.verts.length - 1]) {
        if (E.arrows && E.arrows[i === 0 ? 'start' : 'end']) continue;
        const P = E.verts[i], inner = E.verts[i === 0 ? 1 : E.verts.length - 2];
        // direction pointing back into the shaft (use bezier control if curve)
        let back = normalize(sub(inner, P));
        const sg = E.segs[i === 0 ? 0 : E.segs.length - 1];
        if (sg.t === 'C' && sg.beziers.length) { const b = i === 0 ? sg.beziers[0] : sg.beziers[sg.beziers.length - 1]; back = normalize(sub(i === 0 ? b[1] : b[2], P)); }
        const left = [], right = []; let tip = P.slice(), tipT = 0;
        for (const c of cands) {
          if (c === E || remove.has(c)) continue;
          const v = c.verts, a = v[0], b = v[v.length - 1];
          const da = dist(a, P), db = dist(b, P); const nearEnd = da < db ? a : b, farEnd = da < db ? b : a;
          if (Math.min(da, db) > near) continue;
          const d = sub(farEnd, P), L = hypot(d[0], d[1]); if (L < 1.5 * sw) continue;
          if (els.some((o) => o !== c && o !== E && o.verts && o.verts.some((q) => dist(q, farEnd) < near))) continue; // far end must be free
          const ang = angDiff(angOf(d), angOf(back));
          if (abs(ang) < 0.18 || abs(ang) > 1.3) continue;
          (ang > 0 ? left : right).push({ c, L: L * Math.cos(ang), spread: abs(ang) });
          for (const q of v) { const t = -((q[0] - P[0]) * back[0] + (q[1] - P[1]) * back[1]); if (t > tipT && dist(q, P) < near * 1.5) { tipT = t; tip = q.slice(); } }
        }
        if (!left.length && !right.length) continue;
        if (!left.length || !right.length) { // one barb visible: check for mirrored ink on the other side
          const one = (left[0] || right[0]); const fe = one.c.verts.reduce((m, q) => (dist(q, P) > dist(m, P) ? q : m), one.c.verts[0]);
          const rel = sub(fe, P), along = rel[0] * back[0] + rel[1] * back[1], perp = [rel[0] - along * back[0], rel[1] - along * back[1]];
          let hits = 0; for (let t = 0.35; t <= 1.0001; t += 0.13) { const q = [P[0] + (along * back[0] - perp[0]) * t, P[1] + (along * back[1] - perp[1]) * t]; if (inkAt(q[0], q[1]) > 0.3) hits++; }
          if (hits < 3) continue;
          if (!left.length) left.push(Object.assign({}, one, { c: null })); else right.push(Object.assign({}, one, { c: null }));
        }
        const l = left.sort((x, y) => y.L - x.L)[0], r = right.sort((x, y) => y.L - x.L)[0];
        if (l.c) remove.add(l.c); if (r.c) remove.add(r.c);
        E.arrows = E.arrows || {}; E.arrows[i === 0 ? 'start' : 'end'] = { size: (l.L + r.L) / 2 + tipT, spread: (l.spread + r.spread) / 2 };
        if (tipT > 0) { const fw = [-back[0], -back[1]]; moveEnd({ e: E, i, p: P }, [P[0] + fw[0] * tipT, P[1] + fw[1] * tipT]); }
      }
    }
    return els.filter((e) => !remove.has(e));
  }
  // join collinear line pieces of the same colour separated by a small gap or by crossing ink of another colour
  function bridgeGaps(els, sw, mask, w, h) {
    let changed = true, guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      const lines = els.filter((e) => e.kind === 'stroke' && e.shape === 'line' && !e.dash);
      outer: for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
        const A = lines[i], B = lines[j]; if (A.color !== B.color) continue;
        const ta = angOf(sub(A.verts[1], A.verts[0])), tb = angOf(sub(B.verts[1], B.verts[0]));
        if (abs(Math.sin(ta - tb)) > 0.12) continue;
        let best = null;
        for (const ia of [0, 1]) for (const ib of [0, 1]) { const d = dist(A.verts[ia], B.verts[ib]); if (!best || d < best[0]) best = [d, ia, ib]; }
        const [gap, ia, ib] = best; if (gap > Math.max(6 * sw, 30)) continue;
        const pA = A.verts[1 - ia], pB = B.verts[1 - ib];
        const LF = fitLine([A.verts[0], A.verts[1], B.verts[0], B.verts[1]]);
        if (LF.maxd > Math.max(4, 1.5 * sw)) continue;
        // gap must be (mostly) inked or tiny
        let ink = 0, tot = 0; const a = A.verts[ia], b = B.verts[ib];
        for (let t = 0; t <= 1; t += 1 / Math.max(2, gap)) { const x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t); if (x >= 0 && y >= 0 && x < w && y < h) { tot++; ink += mask[y * w + x]; } }
        if (!(gap < 1.6 * sw || ink / Math.max(1, tot) > 0.55)) continue;
        A.verts = [pA.slice(), pB.slice()]; A.segs = [{ t: 'L' }];
        if (B.arrows) { A.arrows = Object.assign({}, A.arrows || {}); for (const k in B.arrows) A.arrows[ib === 0 ? 'end' : 'end'] = B.arrows[k]; }
        if (A.arrows && ia === 0 && A.arrows.start) { /* start arrow belonged to the end we joined → drop */ delete A.arrows.start; }
        els = els.filter((e) => e !== B); changed = true; break outer;
      }
    }
    return els;
  }
  // dashed line detection: many short collinear segments
  function mergeDashes(els, sw) {
    const lines = els.filter((e) => e.kind === 'stroke' && e.shape === 'line');
    const short = lines.filter((e) => dist(e.verts[0], e.verts[1]) < Math.max(40, 14 * sw));
    const parent = new Map(short.map((e) => [e, e]));
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    for (let i = 0; i < short.length; i++) for (let j = i + 1; j < short.length; j++) {
      const A = short[i], B = short[j]; const ta = angOf(sub(A.verts[1], A.verts[0])), tb = angOf(sub(B.verts[1], B.verts[0]));
      if (abs(Math.sin(ta - tb)) > 0.1) continue;
      const la = dist(A.verts[0], A.verts[1]), lb = dist(B.verts[0], B.verts[1]);
      const gap = Math.min(dist(A.verts[0], B.verts[0]), dist(A.verts[0], B.verts[1]), dist(A.verts[1], B.verts[0]), dist(A.verts[1], B.verts[1]));
      if (gap > 2.5 * Math.max(la, lb) + 2 * sw) continue;
      const pr = projSeg(B.verts[0], A.verts[0], A.verts[1], true); const pr2 = projSeg(B.verts[1], A.verts[0], A.verts[1], true);
      if (pr.d > Math.max(3, sw) || pr2.d > Math.max(3, sw)) continue;
      parent.set(find(A), find(B));
    }
    const groups = new Map(); for (const e of short) { const r = find(e); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e); }
    const remove = new Set(); const add = [];
    for (const g of groups.values()) {
      if (g.length < 3) continue;
      const pts = g.flatMap((e) => e.verts); const L = fitLine(pts);
      const ts = pts.map((p) => (p[0] - L.mx) * L.dx + (p[1] - L.my) * L.dy); const t0 = Math.min(...ts), t1 = Math.max(...ts);
      const dash = g.reduce((s, e) => s + dist(e.verts[0], e.verts[1]), 0) / g.length;
      const gapAvg = Math.max(sw, (t1 - t0 - dash * g.length) / Math.max(1, g.length - 1));
      let a = [L.mx + t0 * L.dx, L.my + t0 * L.dy], b = [L.mx + t1 * L.dx, L.my + t1 * L.dy];
      const s = snapAngle(angOf(sub(b, a)), {}); if (s !== null) { const m = centroid([a, b]), Lh = dist(a, b) / 2; let d = [Math.cos(s), Math.sin(s)]; a = [m[0] - d[0] * Lh, m[1] - d[1] * Lh]; b = [m[0] + d[0] * Lh, m[1] + d[1] * Lh]; }
      g.forEach((e) => remove.add(e));
      add.push(Object.assign({}, g[0], { verts: [a, b], segs: [{ t: 'L' }], dash: [dash, gapAvg] }));
    }
    return els.filter((e) => !remove.has(e)).concat(add);
  }


  // ------------------------------------------------- 0. smart pre-processing (perspective, deskew)
  function dominantSkew(els) {
    const segs = [];
    for (const e of els) {
      if (e.kind !== 'stroke' || !e.verts || !e.segs) continue;
      const n = e.closed ? e.verts.length : e.verts.length - 1;
      for (let k = 0; k < n; k++) if (e.segs[k] && e.segs[k].t === 'L') { const a = e.verts[k], b = e.verts[(k + 1) % e.verts.length], L = dist(a, b); if (L < 25) continue; let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / PI; deg = ((deg % 90) + 135) % 90 - 45; segs.push({ deg, L }); }
    }
    const total = segs.reduce((s2, q) => s2 + q.L, 0); if (total < 300 || segs.length < 3) return null;
    let best = null;
    for (let t = -15; t <= 15; t += 0.25) {
      const inWin = segs.filter((q) => abs(q.deg - t) <= 1.5); const wgt = inWin.reduce((s2, q) => s2 + q.L, 0);
      if (!best || wgt > best.w) best = { t, w: wgt, n: inWin.length, list: inWin };
    }
    const zero = segs.filter((q) => abs(q.deg) <= 0.6).reduce((s2, q) => s2 + q.L, 0);
    if (!best || best.n < 2 || best.w / total < 0.45 || best.w < 1.5 * zero) return null;
    const th = best.list.reduce((s2, q) => s2 + q.deg * q.L, 0) / best.w;
    return abs(th) < 0.8 ? null : th;
  }
  function paperColor(rgba, w, h) {
    const v = [[], [], []];
    for (let i = 0; i < w * h; i += 13) { const g = rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]; v[0].push([g, i]); }
    v[0].sort((a, b) => a[0] - b[0]); const i = v[0][Math.floor(v[0].length * 0.85)][1];
    return [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
  }
  function sampleBilinear(rgba, w, h, x, y, out, o, fill) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) { out[o] = fill[0]; out[o + 1] = fill[1]; out[o + 2] = fill[2]; out[o + 3] = 255; return; }
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0;
    for (let c = 0; c < 3; c++) {
      const a = rgba[(y0 * w + x0) * 4 + c], b = rgba[(y0 * w + x1) * 4 + c], cc = rgba[(y1 * w + x0) * 4 + c], d = rgba[(y1 * w + x1) * 4 + c];
      out[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
    }
    out[o + 3] = 255;
  }
  function rotateImage(rgba, w, h, deg) {
    const t = (deg * PI) / 180, c = Math.cos(t), s2 = Math.sin(t);
    const W = Math.round(abs(w * c) + abs(h * s2)), H = Math.round(abs(w * s2) + abs(h * c));
    const out = new Uint8ClampedArray(W * H * 4), fill = paperColor(rgba, w, h);
    const cx = w / 2, cy = h / 2, CX = W / 2, CY = H / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x - CX, dy = y - CY; // inverse rotation
      sampleBilinear(rgba, w, h, cx + dx * c + dy * s2, cy - dx * s2 + dy * c, out, (y * W + x) * 4, fill);
    }
    return { rgba: out, w: W, h: H };
  }
  function findPaper(rgba, w, h) {
    const k = Math.min(1, 420 / Math.max(w, h)), sw = Math.max(8, Math.round(w * k)), sh = Math.max(8, Math.round(h * k));
    const g = new Uint8Array(sw * sh), hist = new Uint32Array(256);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = (Math.min(h - 1, Math.round(y / k)) * w + Math.min(w - 1, Math.round(x / k))) * 4;
      const v = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0; g[y * sw + x] = v; hist[v]++;
    }
    const t = otsu(hist, sw * sh);
    // paper must be clearly brighter than surroundings
    let mb = 0, nb = 0, md = 0, nd = 0; for (let i = 0; i < sw * sh; i++) { if (g[i] > t) { mb += g[i]; nb++; } else { md += g[i]; nd++; } }
    if (!nb || !nd || mb / nb - md / nd < 45) return null;
    const m = new Uint8Array(sw * sh); for (let i = 0; i < sw * sh; i++) m[i] = g[i] > t ? 1 : 0;
    // close small dark holes (the drawing itself) so the paper is one blob
    const { comps } = components4(m, sw, sh); if (!comps.length) return null;
    const big = comps.reduce((a, b) => (b.area > a.area ? b : a));
    const ratio = big.area / (sw * sh); if (ratio < 0.18 || ratio > 0.97) return null;
    let TL = null, TR = null, BR = null, BL = null, vTL = 1e9, vTR = -1e9, vBR = -1e9, vBL = 1e9;
    for (const p of big.pix) { const x = p % sw, y = (p / sw) | 0; if (x + y < vTL) { vTL = x + y; TL = [x, y]; } if (x + y > vBR) { vBR = x + y; BR = [x, y]; } if (x - y > vTR) { vTR = x - y; TR = [x, y]; } if (x - y < vBL) { vBL = x - y; BL = [x, y]; } }
    const q = [TL, TR, BR, BL]; const qa = abs(loopArea(q));
    // area of blob incl. holes ≈ bbox-filled area: compare with quad
    const filled = (() => { const ff = new Uint8Array(sw * sh); for (const p of big.pix) ff[p] = 1; const inv = new Uint8Array(sw * sh); for (let i = 0; i < sw * sh; i++) inv[i] = ff[i] ? 0 : 1; const c2 = components4(inv, sw, sh).comps; let a = big.area; for (const c of c2) if (!(c.minx === 0 || c.miny === 0 || c.maxx === sw - 1 || c.maxy === sh - 1)) a += c.area; return a; })();
    if (qa / filled < 0.88 || qa / filled > 1.1) return null;
    const nearCorner = q.every((p, i) => dist(p, [[0, 0], [sw - 1, 0], [sw - 1, sh - 1], [0, sh - 1]][i]) < 0.03 * Math.max(sw, sh));
    if (nearCorner) return null;
    return q.map((p) => [p[0] / k, p[1] / k]);
  }
  function homography(src, dst) { // maps src[i] → dst[i]
    const A = [], b = [];
    for (let i = 0; i < 4; i++) { const [x, y] = src[i], [u, v] = dst[i]; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
    const hh = solveLinear(A, b); return hh ? hh.concat([1]) : null;
  }
  function warpPaper(rgba, w, h, quad) {
    const c = centroid(quad); const q = quad.map((p) => [p[0] + (c[0] - p[0]) * 0.012, p[1] + (c[1] - p[1]) * 0.012]);
    let W = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, H = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
    const k = Math.min(1, 1800 / Math.max(W, H)); W = Math.round(W * k); H = Math.round(H * k);
    const Hm = homography([[0, 0], [W, 0], [W, H], [0, H]], q); if (!Hm) return null;
    const out = new Uint8ClampedArray(W * H * 4), fill = [255, 255, 255];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const zz = Hm[6] * x + Hm[7] * y + 1;
      sampleBilinear(rgba, w, h, (Hm[0] * x + Hm[1] * y + Hm[2]) / zz, (Hm[3] * x + Hm[4] * y + Hm[5]) / zz, out, (y * W + x) * 4, fill);
    }
    return { rgba: out, w: W, h: H };
  }
  // full pipeline: perspective → deskew → vectorize. Returns {res, image, fixes}
  function smartVectorize(rgba, w, h, opts) {
    opts = opts || {}; const fixes = []; let img = { rgba, w, h };
    if (opts.perspective !== false) {
      const q = findPaper(rgba, w, h);
      if (q) { const wp = warpPaper(rgba, w, h, q); if (wp) { img = wp; fixes.push('perspective'); } }
    }
    if (opts.deskew !== false) {
      const r0 = vectorize(img.rgba, img.w, img.h, Object.assign({}, opts, { detectSkew: true }));
      if (typeof r0.needDeskew === 'number') { img = rotateImage(img.rgba, img.w, img.h, -r0.needDeskew); fixes.push('deskew:' + r0.needDeskew.toFixed(1)); }
      else { r0.fixes = fixes; return { res: r0, image: img, fixes }; }
    }
    const res = vectorize(img.rgba, img.w, img.h, opts);
    if (res.faint) fixes.push('faint');
    res.fixes = fixes;
    return { res, image: img, fixes };
  }

  // ------------------------------------------------- 8. main
  function rgbHex(c) { return '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''); }
  function standardColor(c, opts) {
    const mx = Math.max(...c), mn = Math.min(...c), lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    if (mx - mn < 40 && opts.pureBlack !== false) return [0, 0, 0];
    if (mx - mn < 30) return [Math.min(lum, 90), Math.min(lum, 90), Math.min(lum, 90)];
    // colour: keep hue, make it a clear, saturated pen colour (faint scans become crisp)
    let [r, g, b] = c.map((v) => v / 255); const M = Math.max(r, g, b), m = Math.min(r, g, b); let hh = 0; const dd = M - m;
    if (dd) { if (M === r) hh = ((g - b) / dd) % 6; else if (M === g) hh = (b - r) / dd + 2; else hh = (r - g) / dd + 4; hh *= 60; if (hh < 0) hh += 360; }
    let L = (M + m) / 2, S = dd / (1 - abs(2 * L - 1) || 1);
    if (opts.vivid !== false) { S = Math.max(S, 0.65); L = clamp(L, 0.3, 0.5); if (hh > 40 && hh < 70) L = Math.max(L, 0.46); }
    const C = (1 - abs(2 * L - 1)) * S, X2 = C * (1 - abs(((hh / 60) % 2) - 1)), m2 = L - C / 2;
    const [r1, g1, b1] = hh < 60 ? [C, X2, 0] : hh < 120 ? [X2, C, 0] : hh < 180 ? [0, C, X2] : hh < 240 ? [0, X2, C] : hh < 300 ? [X2, 0, C] : [C, 0, X2];
    return [(r1 + m2) * 255, (g1 + m2) * 255, (b1 + m2) * 255];
  }

  function vectorize(rgba, w, h, opts) {
    opts = Object.assign({ sensitivity: 0, tolScale: 1, snapStrength: 1, uniformStroke: true, monochrome: false, minNoise: 0 }, opts || {});
    const t0 = Date.now();
    const norm = normalizeImage(rgba, w, h, opts);
    const inkInfo = inkMask(norm, w, h, opts); const { mask, T } = inkInfo;
    const layers = colorLayers(norm, mask, w * h, opts);
    { // merge layers that standardise to (nearly) the same colour
      const std = layers.centers.map((c) => standardColor(c, opts)); const canon = std.map((_, i) => i);
      for (let i = 0; i < std.length; i++) for (let j = 0; j < i; j++) if (canon[j] === j && hypot(std[i][0] - std[j][0], std[i][1] - std[j][1], std[i][2] - std[j][2]) < 70) { canon[i] = j; break; }
      if (canon.some((c, i) => c !== i)) {
        const keep = [...new Set(canon)], remap = canon.map((c) => keep.indexOf(c));
        for (let i = 0; i < w * h; i++) if (layers.labels[i] >= 0) layers.labels[i] = remap[layers.labels[i]];
        layers.centers = keep.map((k) => layers.centers[k]);
      }
    }
    const minArea = Math.max(6, Math.round(w * h * 0.000012)) + (opts.minNoise || 0);
    const comps = [];
    // per-layer components
    for (let c = 0; c < layers.centers.length; c++) {
      const lm = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) if (layers.labels[i] === c) lm[i] = 1;
      const cc = components(lm, w, h, minArea);
      for (const k of cc.comps) { k.layer = c; comps.push(k); }
    }
    // measure stroke widths
    const infos = [];
    for (const c of comps) {
      const bm = cropComp(c, w, 2);
      const sw0 = 0; fillSmallHoles(bm, Math.max(4, Math.round(c.area * 0.002)));
      const d = edt(bm); const sk = thin(bm);
      const skv = []; let skN = 0; let maxD = 0;
      for (let i = 0; i < sk.length; i++) { if (sk[i]) { skN++; skv.push(d[i]); } if (d[i] > maxD) maxD = d[i]; }
      const width = 2 * median(skv) - 1;
      let area = 0; for (let i = 0; i < bm.m.length; i++) area += bm.m[i];
      infos.push({ c, bm, d, sk, skN, width: Math.max(1, width), maxD, area });
    }
    // global stroke width (length-weighted median of thin comps)
    const ws = []; for (const f of infos) if (f.width < 25) for (let i = 0; i < f.skN; i += 4) ws.push(f.width);
    const sw = clamp(median(ws) || 3, 1, 40);
    const glyphMax = Math.max(18, Math.min(w, h) * 0.07, 10 * sw);
    const els = [];
    const colorOf = (c) => standardColor(layers.centers[c.layer], opts);
    for (const f of infos) {
      const c = f.c, bw = c.maxx - c.minx + 1, bh = c.maxy - c.miny + 1;
      const color = rgbHex(colorOf(c));
      const avgW = f.area / Math.max(1, f.skN);
      const isFilled = f.maxD * 2 > Math.max(4.2 * sw, sw + 8) && avgW > 2.4 * sw;
      const small = Math.max(bw, bh) < glyphMax;
      if (avgW < 1.3 && layers.centers.length > 1 && f.width < 1.6 && Math.max(bw, bh) < 3 * glyphMax) continue; // antialias sliver
      if (isFilled || small) {
        // outline mode
        const loops = traceOutlines(f.bm).filter((l) => abs(loopArea(l)) > 3);
        loops.sort((a, b) => abs(loopArea(b)) - abs(loopArea(a)));
        const parts = [];
        for (const l of loops) {
          const r = analyseOutline(l.map((p) => [p[0] + f.bm.ox, p[1] + f.bm.oy]), sw, opts, small && !isFilled);
          if (r) parts.push(r);
        }
        if (!parts.length) continue;
        if (parts.length === 1 && parts[0].shape !== 'path' && parts[0].shape !== 'polygon') {
          els.push(Object.assign(parts[0], { kind: 'fill', color, glyph: small && !isFilled }));
        } else if (small && !isFilled && parts.length >= 1 && isRing(parts, sw)) {
          // hollow small circle like "O" or a node ring drawn as stroke
          const o = parts[0]; els.push(Object.assign(o.shape === 'circle' ? o : parts[0], { kind: 'fill', color, glyph: true, holes: parts.slice(1) }));
        } else {
          els.push({ kind: 'fill', shape: 'compound', parts, color, glyph: small && !isFilled });
        }
        continue;
      }
      // stroke mode
      const G = skeletonGraph(f.sk, f.bm.w, f.bm.h);
      const { chains, arrowPts } = simplifyGraph(G, f.width);
      const width = opts.uniformStroke && abs(f.width - sw) / sw < 0.45 ? sw : f.width;
      const made = [];
      for (const ch of chains) {
        if (pathLen(ch.pts) < Math.max(3, 1.2 * f.width) && chains.length > 1) continue;
        const pts = ch.pts.map((p) => [p[0] + f.bm.ox, p[1] + f.bm.oy]);
        const r = analyseStroke({ pts, closed: ch.closed }, f.width, opts);
        if (!r) continue;
        Object.assign(r, { kind: 'stroke', color, width });
        if (r.shape === 'circle' || r.shape === 'ellipse') r.closed = true;
        made.push(r); els.push(r);
      }
      for (const a of arrowPts) {
        const P = [a.x + f.bm.ox, a.y + f.bm.oy]; let best = null, bd = 3 * f.width + 6;
        for (const e of made) { if (!e.verts || e.closed) continue; for (const i of [0, e.verts.length - 1]) { const d = dist(e.verts[i], P); if (d < bd) { bd = d; best = [e, i]; } } }
        if (best) {
          const [e, i] = best; e.arrows = e.arrows || {}; e.arrows[i === 0 ? 'start' : 'end'] = { size: a.size, spread: a.spread };
          const T = [a.tip[0] + f.bm.ox, a.tip[1] + f.bm.oy];
          if (e.shape === 'line') { // extend along line direction to the tip
            const o = e.verts[i === 0 ? 1 : 0], d = normalize(sub(e.verts[i], o)); const t = (T[0] - o[0]) * d[0] + (T[1] - o[1]) * d[1];
            if (t > 0) e.verts[i] = [o[0] + d[0] * t, o[1] + d[1] * t];
          }
        }
      }
    }
    if (opts.detectSkew) {
      const th = dominantSkew(els);
      if (th !== null) return { needDeskew: th };
    }
    if (inkInfo.faint) for (const e of els) if (e.kind === 'stroke') e.width *= 0.72;
    let out = detectArrowsGeometric(splitHairpins(els, sw).filter((e) => !(e.verts && !e.closed && elemLen(e) < Math.max(2, 0.8 * sw))), sw, mask, w, h);
    out = bridgeGaps(out, sw, mask, w, h);
    out = mergeDashes(out, sw);
    beautify(out, sw, opts);
    if (opts.uniformStroke) { // unify arrowheads
      const sizes = []; out.forEach((e) => e.arrows && Object.values(e.arrows).forEach((a) => sizes.push(a.size)));
      const ms = median(sizes); out.forEach((e) => e.arrows && Object.values(e.arrows).forEach((a) => { a.size = ms; a.spread = 0.42; }));
    }
    // order: fills first (big to small), then strokes, then glyphs
    out.sort((a, b) => rank(a) - rank(b));
    out.forEach((e, i) => (e.id = 'el' + i));
    const stats = {};
    out.forEach((e) => { const k = e.glyph ? 'text/symbol' : e.shape; stats[k] = (stats[k] || 0) + 1; });
    return { faint: !!inkInfo.faint, width: w, height: h, strokeWidth: sw, elements: out, stats, colors: layers.centers.map((c) => rgbHex(standardColor(c, opts))), ms: Date.now() - t0, threshold: T };
  }
  function rank(e) { if (e.kind === 'fill' && !e.glyph) return 0 - (e.area || 0) * 1e-9; if (e.kind === 'stroke') return 1; return 2; }
  function isRing(parts, sw) { return parts.length === 2 && parts[0].shape === 'circle' && parts[1].shape === 'circle'; }
  function isStraight(f, sw) {
    const pts = []; for (let i = 0; i < f.sk.length; i++) if (f.sk[i]) pts.push([i % f.bm.w, (i / f.bm.w) | 0]);
    if (pts.length < 4) return false; const L = fitLine(pts); return L.maxd < Math.max(2, 0.6 * sw);
  }

  // ------------------------------------------------- 9. geometry → path commands
  // returns list of subpaths [{cmds:[['M',x,y],['L',x,y],['C',x1,y1,x2,y2,x,y]...], closed}]
  function arcToBeziers(cx, cy, r, a0, a1, P0, P1) {
    let da = a1 - a0; const n = Math.max(1, Math.ceil(abs(da) / (PI / 2) - 1e-6)); const step = da / n; const out = [];
    const k = (4 / 3) * Math.tan(step / 4);
    for (let i = 0; i < n; i++) {
      const s = a0 + i * step, e = s + step;
      const p0 = i === 0 && P0 ? P0 : [cx + r * Math.cos(s), cy + r * Math.sin(s)];
      const p3 = i === n - 1 && P1 ? P1 : [cx + r * Math.cos(e), cy + r * Math.sin(e)];
      out.push(['C', p0[0] - k * r * Math.sin(s), p0[1] + k * r * Math.cos(s), p3[0] + k * r * Math.sin(e), p3[1] - k * r * Math.cos(e), p3[0], p3[1]]);
    }
    return out;
  }
  function ellipsePath(cx, cy, rx, ry, rot) {
    const k = 0.5522847498, c = Math.cos(rot || 0), s = Math.sin(rot || 0);
    const T = (x, y) => [cx + x * c - y * s, cy + x * s + y * c];
    const P = [T(rx, 0), T(rx, k * ry), T(k * rx, ry), T(0, ry), T(-k * rx, ry), T(-rx, k * ry), T(-rx, 0), T(-rx, -k * ry), T(-k * rx, -ry), T(0, -ry), T(k * rx, -ry), T(rx, -k * ry)];
    return { cmds: [['M', ...P[0]], ['C', ...P[1], ...P[2], ...P[3]], ['C', ...P[4], ...P[5], ...P[6]], ['C', ...P[7], ...P[8], ...P[9]], ['C', ...P[10], ...P[11], ...P[0]]], closed: true };
  }
  function shapeToSubpaths(e) {
    if (e.shape === 'circle') return [ellipsePath(e.cx, e.cy, e.r, e.r, 0)].concat((e.holes || []).flatMap(shapeToSubpaths));
    if (e.shape === 'ellipse') return [ellipsePath(e.cx, e.cy, e.rx, e.ry, e.rot)];
    if (e.shape === 'compound') return e.parts.flatMap(shapeToSubpaths);
    const v = e.verts, cmds = [['M', v[0][0], v[0][1]]];
    const n = e.closed ? v.length : v.length - 1;
    for (let k = 0; k < n; k++) {
      const a = v[k], b = v[(k + 1) % v.length], s = (e.segs && e.segs[k]) || { t: 'L' };
      if (s.t === 'L') cmds.push(['L', b[0], b[1]]);
      else if (s.t === 'A') {
        const a0 = Math.atan2(a[1] - s.cy, a[0] - s.cx); let a1 = Math.atan2(b[1] - s.cy, b[0] - s.cx);
        const TW = 2 * PI, md = s.mid ? Math.atan2(s.mid[1] - s.cy, s.mid[0] - s.cx) : a0 + 0.1;
        const pos = (((a1 - a0) % TW) + TW) % TW, mpos = (((md - a0) % TW) + TW) % TW;
        const da = mpos <= pos ? pos : pos - TW; // go the way that passes through the midpoint
        cmds.push(...arcToBeziers(s.cx, s.cy, s.r, a0, a0 + da, a, b));
      } else if (s.t === 'C') for (const bz of s.beziers) cmds.push(['C', bz[1][0], bz[1][1], bz[2][0], bz[2][1], bz[3][0], bz[3][1]]);
    }
    return [{ cmds, closed: !!e.closed }];
  }
  function arrowHeads(e) {
    if (!e.arrows || !e.verts) return [];
    const res = []; const sub2 = shapeToSubpaths(e)[0].cmds;
    for (const which of Object.keys(e.arrows)) {
      const A = e.arrows[which]; const size = Math.max(A.size, 3 * (e.width || 2)), spread = A.spread || 0.42;
      let tip, from;
      if (which === 'end') { const last = sub2[sub2.length - 1]; tip = last.slice(-2); from = last[0] === 'C' ? [last[3], last[4]] : sub2.length > 1 ? sub2[sub2.length - 2].slice(-2) : sub2[0].slice(1); }
      else { tip = sub2[0].slice(1); const f = sub2[1]; from = f[0] === 'C' ? [f[1], f[2]] : f.slice(-2); }
      if (dist(tip, from) < 1e-6) continue;
      const ang = angOf(sub(tip, from));
      const p1 = [tip[0] - size * Math.cos(ang - spread), tip[1] - size * Math.sin(ang - spread)], p2 = [tip[0] - size * Math.cos(ang + spread), tip[1] - size * Math.sin(ang + spread)];
      const back = [tip[0] - size * 0.78 * Math.cos(ang), tip[1] - size * 0.78 * Math.sin(ang)];
      res.push({ cmds: [['M', ...tip], ['L', ...p1], ['L', ...back], ['L', ...p2]], closed: true, which });
    }
    return res;
  }


  // ------------------------------------------------- 10. labels (glyph groups) & text elements
  function elementBBox(e) {
    if (e.kind === 'text') return [e.x, e.y - e.size * 0.75, e.x + e.size * 0.6 * textLen(e.runs), e.y + e.size * 0.25];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const sp of shapeToSubpaths(e)) for (const c of sp.cmds) for (let i = 1; i < c.length; i += 2) { x0 = Math.min(x0, c[i]); x1 = Math.max(x1, c[i]); y0 = Math.min(y0, c[i + 1]); y1 = Math.max(y1, c[i + 1]); }
    return [x0, y0, x1, y1];
  }
  const textLen = (runs) => runs.reduce((s, r) => s + String(r.t || '').length * (r.sub || r.sup ? 0.7 : 1), 0);
  function glyphGroups(res) {
    const gl = res.elements.filter((e) => e.glyph).map((e) => ({ e, b: elementBBox(e) }));
    const par = gl.map((_, i) => i); const find = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    for (let i = 0; i < gl.length; i++) for (let j = i + 1; j < gl.length; j++) {
      const a = gl[i].b, b = gl[j].b, ha = a[3] - a[1], hb = b[3] - b[1], H = Math.max(ha, hb);
      const vov = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      const gap = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
      if (vov > -0.25 * Math.min(ha, hb) && gap < 0.75 * H && Math.max(ha, hb) / Math.max(1, Math.min(ha, hb)) < 3.5) par[find(i)] = find(j);
    }
    const groups = new Map();
    gl.forEach((g, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(g); });
    let k = 0; const out = [];
    for (const list of groups.values()) {
      const b = [Math.min(...list.map((g) => g.b[0])), Math.min(...list.map((g) => g.b[1])), Math.max(...list.map((g) => g.b[2])), Math.max(...list.map((g) => g.b[3]))];
      out.push({ id: 'g' + ++k, bbox: b, members: list.map((g) => g.e.id) });
    }
    return out.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  }
  // build a text element that sits in a glyph group's box
  function makeTextElement(group, runs, color, italic) {
    const ASC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZbdfhklt0123456789()[]{}/|\\!?%&#$@ΔΣΠΩΘΦΨΛΓ∫√∑', DESC = 'gjpqyβμ(),;[]{}';
    let asc = 0.52, desc = 0;
    for (const r of runs) for (const ch of String(r.t || '')) {
      const a = ASC.includes(ch) ? 0.72 : /[α-ω]/.test(ch) ? 0.52 : ch === ' ' ? 0 : '+-=<>→←⇌~×÷·'.includes(ch) ? 0.45 : 0.52;
      const dd = DESC.includes(ch) ? 0.21 : 0;
      if (r.sub) { asc = Math.max(asc, a * 0.7 - 0.18); desc = Math.max(desc, dd * 0.7 + 0.18); }
      else if (r.sup) { asc = Math.max(asc, a * 0.7 + 0.33); desc = Math.max(desc, dd * 0.7 - 0.33); }
      else { asc = Math.max(asc, a); desc = Math.max(desc, dd); }
    }
    const [x0, y0, x1, y1] = group.bbox, H = Math.max(4, y1 - y0);
    const size = clamp(H / (asc + desc), 6, 400);
    return { kind: 'text', shape: 'text', runs, size, x: x0, y: y1 - desc * size, color, italic: !!italic, fitWidth: x1 - x0 };
  }
  const api = { thinBitmap: thin, _dbg: { skeletonGraph, thin, cropComp, components, edt }, vectorize, smartVectorize, glyphGroups, makeTextElement, elementBBox, shapeToSubpaths, arrowHeads, _internal: { fitCircle, fitLine, fitBeziers, findCorners } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VecEngine = api;
})(typeof window !== 'undefined' ? window : this);
