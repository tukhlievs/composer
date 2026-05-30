// PDF report generation with pdf-lib. Designed to look like a polished report,
// not a plain text dump:
//   - a dark title band with brand kicker, title and date
//   - styled H1/H2/H3 headings with rules
//   - inline **bold** and `code` runs, real word-wrapping with mixed fonts
//   - fenced ```code``` blocks in a bordered monospace panel
//   - "> " callouts with an accent bar
//   - disc bullets and numbered lists, horizontal rules
//   - page footer with brand, date and page numbers
//
// Standard PDF fonts have no Cyrillic, so we embed Noto Sans (regular/bold) and
// Noto Sans Mono via fontkit. Emoji/pictographs are NOT in those fonts and
// would render as ".notdef" boxes ("tofu"), so all text is sanitized to strip
// them before drawing.

import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { fetchWithTimeout } from "../utils/http.js";

const fontCache = new Map();
async function loadFont(url) {
  if (fontCache.has(url)) return fontCache.get(url);
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`Font download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  fontCache.set(url, bytes);
  return bytes;
}

export async function makePdf(config, { title, content }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const [reg, bold, mono] = await Promise.all([
    loadFont(config.pdf.fontUrl),
    loadFont(config.pdf.fontBoldUrl),
    loadFont(config.pdf.fontMonoUrl),
  ]);
  const fonts = {
    regular: await doc.embedFont(reg, { subset: true }),
    bold: await doc.embedFont(bold, { subset: true }),
    mono: await doc.embedFont(mono, { subset: true }),
  };

  renderReport(doc, fonts, { title, content, brand: config.bot.name });
  return await doc.save();
}

// Strip characters the embedded fonts lack (emoji, pictographs, variation
// selectors, ZWJ, regional indicators) so nothing renders as a tofu box.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;
const clean = (s) => String(s == null ? "" : s).replace(EMOJI, "").replace(/[ \t]+$/g, "");

// Split a line into styled runs: **bold** and `code`.
function tokenizeInline(text) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false, code: false });
    if (m[2] !== undefined) out.push({ text: m[2], bold: true, code: false });
    else out.push({ text: m[3], bold: false, code: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false, code: false });
  return out.length ? out : [{ text, bold: false, code: false }];
}

export function renderReport(doc, fonts, { title, content, brand = "Composer" }) {
  const W = 595.28;
  const H = 841.89;
  const M = 52;
  const maxX = W - M;
  const contentW = W - 2 * M;

  const white = rgb(1, 1, 1);
  const ink = rgb(0.13, 0.15, 0.18);
  const muted = rgb(0.46, 0.49, 0.54);
  const ruleColor = rgb(0.85, 0.87, 0.9);
  const bandBg = rgb(0.09, 0.11, 0.15);
  const accent = rgb(0.13, 0.42, 0.46);
  const codeBg = rgb(0.965, 0.975, 0.985);
  const codeBorder = rgb(0.87, 0.89, 0.93);
  const codeInk = rgb(0.16, 0.19, 0.24);
  const calloutBg = rgb(0.95, 0.97, 0.99);

  let page;
  let y;
  const addPage = (top) => {
    page = doc.addPage([W, H]);
    y = top ? H : H - M;
  };
  const ensure = (h) => {
    if (y - h < M + 30) addPage(false);
  };

  const widthOf = (t, f, s) => f.widthOfTextAtSize(t, s);

  // Word-wrap a list of styled runs, drawing each word in its run's font/colour.
  const drawRuns = (runs, { size = 10.5, leading = 5, indent = 0, color = ink } = {}) => {
    const fontFor = (r) => (r.code ? fonts.mono : r.bold ? fonts.bold : fonts.regular);
    const colorFor = (r) => (r.code ? accent : color);
    const sizeFor = (r) => (r.code ? size - 0.5 : size);
    const left = M + indent;
    const lineH = size + leading;

    const words = [];
    for (const r of runs) {
      for (const p of r.text.split(/(\s+)/)) {
        if (p.length) words.push({ t: p, r, space: /^\s+$/.test(p) });
      }
    }

    let line = [];
    let curW = left;
    const flush = () => {
      ensure(lineH);
      let cx = left;
      for (const w of line) {
        const f = fontFor(w.r);
        const s = sizeFor(w.r);
        page.drawText(w.t, { x: cx, y: y - size, size: s, font: f, color: colorFor(w.r) });
        cx += widthOf(w.t, f, s);
      }
      y -= lineH;
      line = [];
      curW = left;
    };
    for (const w of words) {
      const f = fontFor(w.r);
      const s = sizeFor(w.r);
      const ww = widthOf(w.t, f, s);
      if (w.space && line.length === 0) continue; // no leading space
      if (curW + ww > maxX && line.length) flush();
      if (w.space && line.length === 0) continue;
      line.push(w);
      curW += ww;
    }
    if (line.length) flush();
  };

  const drawHeading = (text, level) => {
    const size = level === 1 ? 17 : level === 2 ? 13.5 : 11.5;
    y -= level === 1 ? 14 : 10;
    ensure(size + 12);
    page.drawText(clean(text), { x: M, y: y - size, size, font: fonts.bold, color: level >= 3 ? accent : ink });
    y -= size + 4;
    if (level <= 2) {
      page.drawLine({ start: { x: M, y }, end: { x: maxX, y }, thickness: level === 1 ? 1.2 : 0.7, color: level === 1 ? accent : ruleColor });
      y -= 8;
    } else {
      y -= 2;
    }
  };

  const drawBullet = (text, ordinal) => {
    const size = 10.5;
    const lineH = size + 5;
    ensure(lineH);
    if (ordinal) {
      page.drawText(`${ordinal}.`, { x: M + 6, y: y - size, size, font: fonts.bold, color: accent });
    } else {
      page.drawCircle({ x: M + 9, y: y - size * 0.55, size: 1.8, color: accent });
    }
    drawRuns(tokenizeInline(clean(text)), { size, indent: 22 });
  };

  const wrapMono = (text, size, width) => {
    // character-aware wrap so long commands don't overflow the code panel
    const out = [];
    let cur = "";
    for (const ch of text) {
      const test = cur + ch;
      if (widthOf(test, fonts.mono, size) > width && cur) {
        out.push(cur);
        cur = ch;
      } else {
        cur = test;
      }
    }
    out.push(cur);
    return out.length ? out : [""];
  };

  const drawCodeBlock = (lines) => {
    const size = 9.5;
    const lineH = size + 4;
    const padX = 12;
    const padY = 9;
    const innerW = contentW - padX * 2;
    const wrapped = [];
    for (const ln of lines) for (const w of wrapMono(clean(ln) || " ", size, innerW)) wrapped.push(w);
    const boxH = wrapped.length * lineH + padY * 2;
    y -= 6;
    ensure(boxH + 6);
    const top = y;
    page.drawRectangle({ x: M, y: top - boxH, width: contentW, height: boxH, color: codeBg, borderColor: codeBorder, borderWidth: 0.8 });
    page.drawRectangle({ x: M, y: top - boxH, width: 3, height: boxH, color: accent });
    let ty = top - padY - size;
    for (const w of wrapped) {
      page.drawText(w, { x: M + padX, y: ty, size, font: fonts.mono, color: codeInk });
      ty -= lineH;
    }
    y = top - boxH - 8;
  };

  const drawCallout = (lines) => {
    const size = 10;
    const padX = 12;
    const padY = 8;
    // pre-wrap to compute height
    const para = lines.join(" ");
    const runs = tokenizeInline(clean(para));
    // rough height: measure by simulating wrap width
    const words = runs.flatMap((r) => r.text.split(/\s+/).filter(Boolean).map((t) => ({ t, r })));
    let rows = 1;
    let cw = 0;
    const innerW = contentW - padX * 2 - 6;
    for (const w of words) {
      const f = w.r.code ? fonts.mono : w.r.bold ? fonts.bold : fonts.regular;
      const ww = widthOf(w.t + " ", f, size);
      if (cw + ww > innerW) {
        rows++;
        cw = ww;
      } else cw += ww;
    }
    const boxH = rows * (size + 5) + padY * 2;
    y -= 4;
    ensure(boxH + 6);
    const top = y;
    page.drawRectangle({ x: M, y: top - boxH, width: contentW, height: boxH, color: calloutBg });
    page.drawRectangle({ x: M, y: top - boxH, width: 3, height: boxH, color: accent });
    y = top - padY;
    drawRuns(runs, { size, indent: padX + 4 });
    y = top - boxH - 8;
  };

  // ---- Title band -----------------------------------------------------------
  addPage(true);
  const bandH = 118;
  page.drawRectangle({ x: 0, y: H - bandH, width: W, height: bandH, color: bandBg });
  page.drawRectangle({ x: 0, y: H - bandH, width: W, height: 3, color: accent });
  page.drawText(clean(brand).toUpperCase(), { x: M, y: H - 40, size: 9, font: fonts.bold, color: rgb(0.62, 0.68, 0.76) });

  // title (up to 2 lines), white bold
  const titleSize = 23;
  const tWords = clean(title || "Отчёт").split(/\s+/);
  const tLines = [];
  let tl = "";
  for (const w of tWords) {
    const test = tl ? tl + " " + w : w;
    if (widthOf(test, fonts.bold, titleSize) > contentW && tl) {
      tLines.push(tl);
      tl = w;
    } else tl = test;
  }
  if (tl) tLines.push(tl);
  let ty = H - 62;
  for (const ln of tLines.slice(0, 2)) {
    page.drawText(ln, { x: M, y: ty, size: titleSize, font: fonts.bold, color: white });
    ty -= titleSize + 3;
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  page.drawText(dateStr, { x: M, y: H - bandH + 14, size: 9.5, font: fonts.regular, color: rgb(0.7, 0.75, 0.82) });

  y = H - bandH - 26;

  // ---- Body -----------------------------------------------------------------
  const lines = String(content || "").replace(/\r/g, "").split("\n");
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    drawRuns(tokenizeInline(clean(para.join(" "))), { size: 10.5, leading: 5 });
    y -= 4;
    para = [];
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");

    if (/^```/.test(line.trim())) {
      flushPara();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      drawCodeBlock(code);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const cl = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        cl.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      drawCallout(cl);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flushPara();
      const level = Math.min(3, line.match(/^#+/)[0].length);
      drawHeading(line.replace(/^#{1,6}\s+/, ""), level);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      drawBullet(line.replace(/^\s*[-*]\s+/, ""), null);
      i++;
      continue;
    }
    const num = line.match(/^\s*(\d+)\.\s+/);
    if (num) {
      flushPara();
      drawBullet(line.replace(/^\s*\d+\.\s+/, ""), num[1]);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushPara();
      y -= 6;
      ensure(10);
      page.drawLine({ start: { x: M, y }, end: { x: maxX, y }, thickness: 0.7, color: ruleColor });
      y -= 8;
      i++;
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      y -= 4;
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();

  // ---- Footer on every page -------------------------------------------------
  const pages = doc.getPages();
  pages.forEach((p, idx) => {
    p.drawLine({ start: { x: M, y: M - 8 }, end: { x: maxX, y: M - 8 }, thickness: 0.6, color: ruleColor });
    p.drawText(`${brand}`, { x: M, y: M - 20, size: 8, font: fonts.regular, color: muted });
    const pageLabel = `${idx + 1} / ${pages.length}`;
    p.drawText(pageLabel, {
      x: maxX - fonts.regular.widthOfTextAtSize(pageLabel, 8),
      y: M - 20,
      size: 8,
      font: fonts.regular,
      color: muted,
    });
  });
}
