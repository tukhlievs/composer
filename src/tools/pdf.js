// PDF report generation with pdf-lib. The standard PDF fonts (Helvetica, etc.)
// have no Cyrillic glyphs, so we embed a Unicode TTF (Noto Sans) via fontkit.
// This makes Russian / Uzbek reports render correctly.

import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { fetchWithTimeout } from "../utils/http.js";

// Memoise font bytes for the lifetime of the isolate to avoid re-downloading.
const fontCache = new Map();

async function loadFont(url) {
  if (fontCache.has(url)) return fontCache.get(url);
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`Font download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  fontCache.set(url, bytes);
  return bytes;
}

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 56;

export async function makePdf(config, { title, content }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const [regularBytes, boldBytes] = await Promise.all([
    loadFont(config.pdf.fontUrl),
    loadFont(config.pdf.fontBoldUrl),
  ]);
  const regular = await doc.embedFont(regularBytes, { subset: true });
  const bold = await doc.embedFont(boldBytes, { subset: true });

  const maxWidth = A4.w - MARGIN * 2;
  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;

  const newPage = () => {
    page = doc.addPage([A4.w, A4.h]);
    y = A4.h - MARGIN;
  };
  const ensure = (lineHeight) => {
    if (y - lineHeight < MARGIN) newPage();
  };

  const drawWrapped = (text, { font = regular, size = 11, gap = 4, color = rgb(0.1, 0.1, 0.12), indent = 0 } = {}) => {
    const words = String(text).split(/\s+/);
    let line = "";
    const lineHeight = size + gap;
    const flush = () => {
      ensure(lineHeight);
      page.drawText(line, { x: MARGIN + indent, y: y - size, size, font, color });
      y -= lineHeight;
      line = "";
    };
    for (const word of words) {
      const trial = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(trial, size) > maxWidth - indent && line) {
        flush();
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) flush();
  };

  // Title block
  drawWrapped(title || "Report", { font: bold, size: 20, gap: 6 });
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 1, color: rgb(0.8, 0.8, 0.82) });
  y -= 16;

  // Body: light markdown handling.
  const lines = String(content || "").replace(/\r/g, "").split("\n");
  for (const raw of lines) {
    const lineText = raw.trimEnd();
    if (lineText === "") {
      y -= 6;
      continue;
    }
    if (/^#{1,2}\s+/.test(lineText)) {
      y -= 6;
      drawWrapped(lineText.replace(/^#{1,2}\s+/, ""), { font: bold, size: 14, gap: 5 });
      continue;
    }
    if (/^#{3,}\s+/.test(lineText)) {
      drawWrapped(lineText.replace(/^#{3,}\s+/, ""), { font: bold, size: 12, gap: 4 });
      continue;
    }
    if (/^[-*]\s+/.test(lineText)) {
      drawWrapped("•  " + lineText.replace(/^[-*]\s+/, ""), { size: 11, indent: 10 });
      continue;
    }
    drawWrapped(lineText, { size: 11 });
  }

  // Footer with generator + date on every page.
  const stamp = `${config.bot.name} • ${new Date().toISOString().slice(0, 10)}`;
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`${stamp} • ${i + 1}/${pages.length}`, {
      x: MARGIN,
      y: MARGIN / 2,
      size: 8,
      font: regular,
      color: rgb(0.55, 0.55, 0.58),
    });
  });

  return await doc.save();
}
