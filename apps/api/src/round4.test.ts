import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textPdf } from './pdf';
import { compileRegex } from './portal/policy.controller';

test('block-rule regex: the spec example with a scheme compiles to a URL rule', () => {
  assert.deepEqual(compileRegex('^https?://(www\\.)?reddit\\.com/r/.*'), ['reddit.com/r/']);
  assert.deepEqual(compileRegex('^(www\\.)?(a\\.com|b\\.com)/x.*$'), ['a.com/x', 'b.com/x']);
  assert.equal(compileRegex('^https?://.*'), null);
});

test('text PDF: valid header, xref offsets point at objects, text escaped', () => {
  const pdf = textPdf([{ text: 'Week (1) \\ total', bold: true }, { text: 'Zoë 日本' }]).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF'));
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1} offset`));
  assert.ok(pdf.includes('(Week \\(1\\) \\\\ total)') && pdf.includes('(Zoë ??)'));
});
