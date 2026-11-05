// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Andrea Di Leo — Leggio, https://github.com/Andreadileo/leggio
/**
 * Leggio — pulizia del contenuto delle email.
 * - fixMojibake: ripara il testo UTF-8 letto come Latin-1/Windows-1252 ("CecÃ­lia" -> "Cecília").
 * - textFromHtml: ricava il testo leggibile quando la mail ha solo la parte HTML.
 */
const { convert } = require('html-to-text');

// Caratteri Windows-1252 nell'intervallo 0x80-0x9F e il byte che rappresentano.
const CP1252 = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89,
  'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const CONT = '[\\u0080-\\u00BF' + Object.keys(CP1252).join('') + ']';
// Un carattere "di testa" UTF-8 (byte C2-F4) seguito dal giusto numero di byte di continuazione.
const MOJIBAKE_RE = new RegExp(
  `[\\u00C2-\\u00DF]${CONT}|[\\u00E0-\\u00EF]${CONT}{2}|[\\u00F0-\\u00F4]${CONT}{3}`, 'g');

function charToByte(ch) {
  if (CP1252[ch] !== undefined) return CP1252[ch];
  const c = ch.charCodeAt(0);
  return c <= 0xff ? c : -1;
}

function decodeSegment(seg) {
  const bytes = [];
  for (const ch of seg) {
    const b = charToByte(ch);
    if (b < 0) return null;
    bytes.push(b);
  }
  const out = Buffer.from(bytes).toString('utf8');
  if (out.includes('�')) return null; // non era UTF-8 valido: lascia com'era
  return out;
}

function fixMojibake(s) {
  if (typeof s !== 'string' || !s) return s;
  let fixed = 0;
  let out = s.replace(MOJIBAKE_RE, (seg) => {
    const d = decodeSegment(seg);
    if (d === null) return seg;
    fixed++;
    return d;
  });
  // "Ã" seguito da spazio: di solito era "à" con lo spazio non separabile perso per strada.
  // Lo correggo solo se nel testo c'erano già altri errori dello stesso tipo.
  if (fixed > 0) out = out.replace(/Ã(?=[ \t]|$)/gm, 'à');
  return out;
}

function textFromHtml(html) {
  if (!html) return '';
  try {
    return convert(html, {
      wordwrap: false,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'a', options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } },
        { selector: 'style', format: 'skip' },
        { selector: 'script', format: 'skip' },
      ],
    }).replace(/\n{3,}/g, '\n\n').trim();
  } catch (_) {
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

// La mail sorgente ha una vera parte text/plain? (mailparser inventa un testo dall'HTML
// anche quando non c'è, quindi parsed.text da solo non basta a saperlo.)
function hasPlainPart(raw) {
  if (!raw) return true;
  const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  if (/^content-type:\s*text\/plain/im.test(s)) return true;
  // Nessun Content-Type nell'intestazione principale = testo semplice per definizione (RFC 2045).
  const head = s.split(/\r?\n\r?\n/)[0];
  return !/^content-type:/im.test(head);
}

// Testo "migliore" per una mail: parte testuale se c'è, altrimenti ricavato dall'HTML.
function bestText(parsed, raw) {
  const plain = (parsed.text || '').trim();
  if (plain && (!parsed.html || hasPlainPart(raw))) return { text: fixMojibake(parsed.text), text_source: 'plain' };
  if (parsed.html) return { text: fixMojibake(textFromHtml(parsed.html)), text_source: 'html' };
  return { text: '', text_source: 'none' };
}

module.exports = { fixMojibake, textFromHtml, bestText };
