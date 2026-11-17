// One-page text PDF (Helvetica, A4) without a dependency: enough for a weekly timesheet table.
// shortcut: WinAnsi text only (non-Latin-1 characters print as '?'), one page; move to a PDF
// library if timesheets need other scripts, logos or more than ~60 lines.

export type PdfLine = { text: string; x?: number; size?: number; bold?: boolean; gap?: number };

const esc = (t: string) => t.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, '\\$&');

export function textPdf(lines: PdfLine[]): Buffer {
  let y = 800;
  const ops: string[] = [];
  for (const l of lines) {
    y -= l.gap ?? 16;
    ops.push(`BT /${l.bold ? 'F2' : 'F1'} ${l.size ?? 10} Tf ${l.x ?? 50} ${y} Td (${esc(l.text)}) Tj ET`);
  }
  const content = Buffer.from(ops.join('\n'), 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
