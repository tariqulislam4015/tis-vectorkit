/* VectorKit exporters: SVG (native shapes), PDF and Illustrator .ai (PDF-compatible) */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.VecEngine;
  const f2 = (v) => (Math.round(v * 100) / 100).toString();

  // stroke path for an element, with ends pulled back under arrowheads
  function strokeSubpaths(e) {
    const subs = E.shapeToSubpaths(e);
    if (!e.arrows) return subs;
    const heads = E.arrowHeads(e); const s = subs[0].cmds.map((c) => c.slice());
    for (const h of heads) {
      const tip = h.cmds[0].slice(1), back = h.cmds[2].slice(1);
      if (h.which === 'end') { const last = s[s.length - 1]; last[last.length - 2] = back[0]; last[last.length - 1] = back[1]; }
      else { s[0][1] = back[0]; s[0][2] = back[1]; }
    }
    return [{ cmds: s, closed: subs[0].closed }];
  }
  function cmdsToD(subs) {
    return subs.map((sp) => sp.cmds.map((c) => c[0] + c.slice(1).map(f2).join(' ')).join(' ') + (sp.closed ? ' Z' : '')).join(' ');
  }

  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function textSVG(e, id) {
    const sp = e.runs.map((r) => r.sub ? `<tspan font-size="${f2(e.size * 0.7)}" dy="${f2(e.size * 0.18)}">${esc(r.t)}</tspan><tspan dy="${f2(-e.size * 0.18)}"></tspan>` : r.sup ? `<tspan font-size="${f2(e.size * 0.7)}" dy="${f2(-e.size * 0.33)}">${esc(r.t)}</tspan><tspan dy="${f2(e.size * 0.33)}"></tspan>` : `<tspan>${esc(r.t)}</tspan>`).join('');
    return `<text${id} x="${f2(e.x)}" y="${f2(e.y)}" font-family="Arial, Helvetica, sans-serif" font-size="${f2(e.size)}"${e.italic ? ' font-style="italic"' : ''} fill="${e.color}" xml:space="preserve">${sp}</text>`;
  }
  function elementSVG(e, opt) {
    const id = opt && opt.ids ? ` id="${e.id}" data-shape="${e.shape}"` : '';
    if (e.kind === 'text') return textSVG(e, id);
    if (e.kind === 'fill') {
      const fr = e.shape === 'compound' || e.holes ? ' fill-rule="evenodd"' : '';
      if (e.shape === 'circle' && !e.holes) return `<circle${id} cx="${f2(e.cx)}" cy="${f2(e.cy)}" r="${f2(e.r)}" fill="${e.color}"/>`;
      return `<path${id} d="${cmdsToD(E.shapeToSubpaths(e))}" fill="${e.color}"${fr}/>`;
    }
    const st = `fill="none" stroke="${e.color}" stroke-width="${f2(e.width)}" stroke-linecap="round" stroke-linejoin="round"` + (e.dash ? ` stroke-dasharray="${f2(e.dash[0])} ${f2(e.dash[1])}" stroke-linecap="butt"` : '');
    let s;
    if (e.shape === 'circle') s = `<circle${id} cx="${f2(e.cx)}" cy="${f2(e.cy)}" r="${f2(e.r)}" ${st}/>`;
    else if (e.shape === 'ellipse') s = `<ellipse${id} cx="${f2(e.cx)}" cy="${f2(e.cy)}" rx="${f2(e.rx)}" ry="${f2(e.ry)}"${e.rot ? ` transform="rotate(${f2((e.rot * 180) / Math.PI)} ${f2(e.cx)} ${f2(e.cy)})"` : ''} ${st}/>`;
    else if ((e.shape === 'rect' || e.shape === 'square') && Math.abs(e.rot || 0) < 1e-6) {
      const xs = e.verts.map((v) => v[0]), ys = e.verts.map((v) => v[1]);
      s = `<rect${id} x="${f2(Math.min(...xs))}" y="${f2(Math.min(...ys))}" width="${f2(Math.max(...xs) - Math.min(...xs))}" height="${f2(Math.max(...ys) - Math.min(...ys))}" ${st}/>`;
    } else if (e.shape === 'line' && !e.arrows) s = `<line${id} x1="${f2(e.verts[0][0])}" y1="${f2(e.verts[0][1])}" x2="${f2(e.verts[1][0])}" y2="${f2(e.verts[1][1])}" ${st}/>`;
    else if (['triangle', 'quad', 'polygon', 'rect', 'square'].includes(e.shape)) s = `<polygon${id} points="${e.verts.map((v) => f2(v[0]) + ',' + f2(v[1])).join(' ')}" ${st}/>`;
    else if (e.shape === 'polyline' && !e.arrows) s = `<polyline${id} points="${e.verts.map((v) => f2(v[0]) + ',' + f2(v[1])).join(' ')}" ${st}/>`;
    else s = `<path${id} d="${cmdsToD(strokeSubpaths(e))}" ${st}/>`;
    if (e.arrows) {
      const heads = E.arrowHeads(e).map((h) => `<path d="${cmdsToD([h])}" fill="${e.color}"/>`).join('');
      return `<g${id}>${s.replace(id, '')}${heads}</g>`;
    }
    return s;
  }

  function toSVG(res, opt) {
    opt = opt || {};
    const fills = res.elements.filter((e) => e.kind === 'fill' && !e.glyph), strokes = res.elements.filter((e) => e.kind === 'stroke'), glyphs = res.elements.filter((e) => e.glyph || e.kind === "text");
    const g = (name, list) => (list.length ? `<g id="${name}">${list.map((e) => elementSVG(e, opt)).join('\n')}</g>\n` : '');
    const bg = opt.background ? `<rect width="100%" height="100%" fill="${opt.background}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${res.width}" height="${res.height}" viewBox="0 0 ${res.width} ${res.height}">\n${bg}${g('Filled_Shapes', fills)}${g('Lines_and_Shapes', strokes)}${g('Labels', glyphs)}</svg>`;
  }

  // ------------------------------------------------------------- PDF
  function hexToRGB(h) { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  function pdfPath(subs, H) {
    const out = [];
    for (const sp of subs) {
      for (const c of sp.cmds) {
        const p = c.slice(1).map((v, i) => f2(i % 2 ? H - v : v));
        if (c[0] === 'M') out.push(`${p[0]} ${p[1]} m`); else if (c[0] === 'L') out.push(`${p[0]} ${p[1]} l`); else out.push(`${p.join(' ')} c`);
      }
      if (sp.closed) out.push('h');
    }
    return out.join('\n');
  }
  // WinAnsi-encodable chars stay in Helvetica; Greek & math symbols go to the standard Symbol font
  const SYM = { 'α': 0x61, 'β': 0x62, 'χ': 0x63, 'δ': 0x64, 'ε': 0x65, 'φ': 0x66, 'γ': 0x67, 'η': 0x68, 'ι': 0x69, 'κ': 0x6B, 'λ': 0x6C, 'μ': 0x6D, 'ν': 0x6E, 'ο': 0x6F, 'π': 0x70, 'θ': 0x71, 'ρ': 0x72, 'σ': 0x73, 'τ': 0x74, 'υ': 0x75, 'ω': 0x77, 'ξ': 0x78, 'ψ': 0x79, 'ζ': 0x7A,
    'Δ': 0x44, 'Φ': 0x46, 'Γ': 0x47, 'Λ': 0x4C, 'Π': 0x50, 'Θ': 0x51, 'Σ': 0x53, 'Ω': 0x57, 'Ψ': 0x59, '→': 0xAE, '←': 0xAC, '↑': 0xAD, '↓': 0xAF, '↔': 0xAB, '⇌': 0xAB, '⇒': 0xDE, '≤': 0xA3, '≥': 0xB3, '≠': 0xB9, '≈': 0xBB, '∞': 0xA5, '√': 0xD6, '∫': 0xF2, '∑': 0xE5, '∂': 0xB6, '∠': 0xD0, '⊥': 0x5E, '∴': 0x5C, '∈': 0xCE, '∝': 0xB5, '·': 0xD7, '−': 0x2D, '′': 0xA2 };
  const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94 };
  function pdfStr(codes) { return '(' + codes.map((c) => (c === 40 || c === 41 || c === 92 ? '\\' + String.fromCharCode(c) : c < 32 || c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c))).join('') + ')'; }
  function textPDF(e, H) {
    const [r, g, b] = hexToRGB(e.color).map(f2); const out = [`${r} ${g} ${b} rg`, 'BT'];
    const font = e.italic ? '/F2' : '/F1';
    out.push(`1 0 0 1 ${f2(e.x)} ${f2(H - e.y)} Tm`);
    for (const run of e.runs) {
      const sz = run.sub || run.sup ? e.size * 0.7 : e.size, rise = run.sub ? -e.size * 0.18 : run.sup ? e.size * 0.33 : 0;
      // split run into font chunks
      let cur = null, codes = [];
      const flush = () => { if (codes.length) out.push(`${cur} ${f2(sz)} Tf ${f2(rise)} Ts ${pdfStr(codes)} Tj`); codes = []; };
      for (const ch of String(run.t)) {
        let f, c; const cp = ch.codePointAt(0);
        if (SYM[ch] !== undefined) { f = '/F3'; c = SYM[ch]; } else if (WIN[ch] !== undefined) { f = font; c = WIN[ch]; } else if (cp < 256) { f = font; c = cp; } else { f = font; c = 63; }
        if (f !== cur) { flush(); cur = f; } codes.push(c);
      }
      flush();
    }
    out.push('0 Ts ET'); return out.join('\n');
  }
  function toPDF(res, opt) {
    opt = opt || {}; const H = res.height; const ops = [];
    ops.push('1 J 1 j');
    const order = [...res.elements.filter((e) => e.kind === 'fill' && !e.glyph), ...res.elements.filter((e) => e.kind === 'stroke'), ...res.elements.filter((e) => e.glyph || e.kind === 'text')];
    for (const e of order) {
      const [r, g, b] = hexToRGB(e.color).map(f2);
      ops.push('q');
      if (e.kind === 'text') { ops.push(textPDF(e, H)); ops.push('Q'); continue; }
      if (e.kind === 'fill') {
        ops.push(`${r} ${g} ${b} rg`); ops.push(pdfPath(E.shapeToSubpaths(e), H)); ops.push(e.shape === 'compound' || e.holes ? 'f*' : 'f');
      } else {
        ops.push(`${r} ${g} ${b} RG ${f2(e.width)} w`);
        if (e.dash) ops.push(`0 J [${f2(e.dash[0])} ${f2(e.dash[1])}] 0 d`);
        ops.push(pdfPath(strokeSubpaths(e), H)); ops.push('S');
        if (e.arrows) { ops.push(`${r} ${g} ${b} rg`); for (const h of E.arrowHeads(e)) { ops.push(pdfPath([h], H)); ops.push('f'); } }
      }
      ops.push('Q');
    }
    const content = ops.join('\n');
    const now = new Date(); const pad = (n) => String(n).padStart(2, '0');
    const date = `D:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const title = (opt.title || 'VectorKit drawing').replace(/[()\\]/g, '');
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${res.width} ${res.height}] /TrimBox [0 0 ${res.width} ${res.height}] /ArtBox [0 0 ${res.width} ${res.height}] /Contents 4 0 R /Resources << /Font << /F1 6 0 R /F2 7 0 R /F3 8 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      `<< /Title (${title}) /Creator (TIS Diagram Pro) /Producer (TIS Diagram Pro) /CreationDate (${date}) >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
    ];
    let pdf = '%PDF-1.5\n%\xE2\xE3\xCF\xD3\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(pdf.length); for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 255;
    return bytes;
  }

  function pdfEncodable(str) { for (const ch of String(str)) { const cp = ch.codePointAt(0); if (!(cp < 256 || SYM[ch] !== undefined || WIN[ch] !== undefined)) return false; } return true; }
  const api = { pdfEncodable, toSVG, toPDF, elementSVG, cmdsToD, strokeSubpaths };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VecExport = api;
})(typeof window !== 'undefined' ? window : this);
