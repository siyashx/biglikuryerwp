// +994-dan sonra 0-suz operatorlar, 0-dan sonra 0-lu variant
const OPS_NOZERO = '(10|50|51|55|70|77|99)';

// "+994 70 585 08 08" və "070 585 08 08"
const RE_SPACED = new RegExp(
  String.raw`\b(?:\+?994\s*${OPS_NOZERO}|0\s*${OPS_NOZERO})\s*\d{3}\s*\d{2}\s*\d{2}\b`,
  'g'
);

// "0554555008", "+994705850808", "994705850808"
const RE_COMPACT = new RegExp(
  String.raw`\b(?:\+?994${OPS_NOZERO}\d{7}|0${OPS_NOZERO}\d{7})\b`,
  'g'
);

export function normalizeTo994(input) {
  if (!input) return null;
  let s = String(input).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);           // +994... -> 994...
  if (new RegExp(`^0${OPS_NOZERO}\\d{7}$`).test(s)) {
    s = '994' + s.slice(1);                        // 070xxxxxxx -> 99470xxxxxxx
  }
  if (!new RegExp(`^994${OPS_NOZERO}\\d{7}$`).test(s)) return null;
  return s;                                        // 99470xxxxxxx
}

export function extractAllPhones(text) {
  if (!text) return [];
  const found = new Set();
  for (const re of [RE_SPACED, RE_COMPACT]) {
    for (const m of text.matchAll(re)) {
      const n = normalizeTo994(m[0]);
      if (n) found.add(n);
    }
  }
  return Array.from(found);
}
