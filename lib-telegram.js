// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Andrea Di Leo — Leggio, https://github.com/Andreadileo/leggio
/**
 * Leggio — bot Telegram (sola lettura).
 *
 * Cosa fa:   avvisi di nuove mail, comandi di lettura dal telefono, riassunto giornaliero.
 * Cosa NON fa: non invia, sposta o cancella mail; non gestisce caselle o token (restano nella console locale).
 * Privacy:   negli avvisi e nei riassunti escono solo mittente, oggetto e casella. Il testo di una mail
 *            arriva su Telegram solo se lo chiedi tu con /leggi. Il controllo anti-injection gira in locale.
 * Sicurezza: il bot risponde solo alla chat collegata con un codice usa e getta; il token del bot è cifrato.
 *            Usa il "long polling": il PC non deve essere raggiungibile da internet.
 */
const crypto = require('crypto');
const path = require('path');
const store = require('./lib-store');

const API_BASE = process.env.LEGGIO_TELEGRAM_API || 'https://api.telegram.org';
const MAX_MSG = 3900; // Telegram accetta 4096 caratteri: tengo margine per l'HTML
const PAIR_MS = 10 * 60 * 1000;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class TelegramBot {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {object} o.vault       KeyVault (cifra il token del bot)
   * @param {Function} o.audit
   * @param {Function} o.accounts  () => elenco caselle
   * @param {Function} o.inbox     (accounts, limit) => {data, errors}
   * @param {Function} o.message   (account, uid) => mail completa
   */
  constructor(o) {
    Object.assign(this, o);
    this.file = path.join(o.dataDir, 'telegram.json');
    this.running = false;
    this.offset = 0;
    this.pairing = null;      // { code, expires }
    this.lastList = [];       // ultimi elementi mostrati con /ultime o /cerca, per /leggi N
    this.lastError = null;
    this.botUsername = null;
    this.timers = [];
    this.abort = null;
    this.gen = 0;             // generazione del ciclo di ascolto: evita cicli doppi dopo un riavvio
  }

  // ---------- Configurazione ----------
  config() {
    return Object.assign({
      enabled: false, botTokenEnc: null, chatId: null, chatName: null,
      alerts: true, intervalMin: 3, digestHour: 8, mailboxes: [],
      seen: {}, lastDigest: null,
    }, store.readJson(this.file, {}));
  }
  save(cfg) { store.writeJson(this.file, cfg); }
  token() {
    const c = this.config();
    if (!c.botTokenEnc || this.vault.isLocked()) return null;
    try { return this.vault.decrypt(c.botTokenEnc); } catch (_) { return null; }
  }
  publicState() {
    const c = this.config();
    return {
      configured: !!c.botTokenEnc, enabled: c.enabled, linked: !!c.chatId, chatName: c.chatName,
      botUsername: this.botUsername || c.botUsername || null,
      alerts: c.alerts, intervalMin: c.intervalMin, digestHour: c.digestHour, mailboxes: c.mailboxes,
      running: this.running, lastError: this.lastError,
      pairing: this.pairing && Date.now() < this.pairing.expires ? { code: this.pairing.code, expires: new Date(this.pairing.expires).toISOString() } : null,
    };
  }

  // ---------- Telegram API ----------
  async call(method, body, token) {
    const tk = token || this.token();
    if (!tk) throw new Error('Token del bot non disponibile');
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), method === 'getUpdates' ? 40000 : 15000);
    if (method === 'getUpdates') this.abort = ctrl;
    try {
      const r = await fetch(`${API_BASE}/bot${tk}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({ ok: false, description: 'risposta non valida' }));
      if (!j.ok) {
        const e = new Error(j.description || `Telegram ${r.status}`); e.status = r.status; e.retryAfter = j.parameters && j.parameters.retry_after; throw e;
      }
      return j.result;
    } finally { clearTimeout(timeout); }
  }
  async send(text, extra) {
    const c = this.config();
    if (!c.chatId) return;
    for (const part of chunk(text, MAX_MSG)) {
      await this.call('sendMessage', { chat_id: c.chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    }
  }

  // Salva il token dopo averlo verificato con getMe.
  async setToken(botToken) {
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(String(botToken || '').trim())) throw new Error('Il token non ha il formato di BotFather (numeri:lettere).');
    const me = await this.call('getMe', {}, botToken.trim());
    const c = this.config();
    if (this.token() !== botToken.trim()) { c.chatId = null; c.chatName = null; this.offset = 0; } // bot nuovo: ricollega la chat e riparti dai suoi messaggi
    c.botTokenEnc = this.vault.encrypt(botToken.trim());
    c.botUsername = me.username;
    this.botUsername = me.username;
    this.save(c);
    return me;
  }
  update(patch) {
    const c = this.config();
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    if (patch.alerts !== undefined) c.alerts = !!patch.alerts;
    if (patch.intervalMin !== undefined) c.intervalMin = Math.min(Math.max(Number(patch.intervalMin) || 3, 1), 60);
    if (patch.digestHour !== undefined) c.digestHour = patch.digestHour === null || patch.digestHour === '' ? null : Math.min(Math.max(Number(patch.digestHour), 0), 23);
    if (Array.isArray(patch.mailboxes)) c.mailboxes = patch.mailboxes.map(String);
    this.save(c);
  }
  newPairing() {
    this.pairing = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + PAIR_MS, fails: 0 };
    return this.pairing;
  }
  unlink() { const c = this.config(); c.chatId = null; c.chatName = null; this.save(c); }
  remove() { this.stop(); this.save({}); this.botUsername = null; this.lastError = null; this.offset = 0; this.pairing = null; }

  // ---------- Ciclo di vita ----------
  canRun() { const c = this.config(); return c.enabled && !!c.botTokenEnc && !this.vault.isLocked(); }
  start() {
    if (this.running || !this.canRun()) return;
    this.running = true; this.lastError = null;
    const gen = ++this.gen;
    this.loopUpdates(gen);
    let busy = false; // un controllo alla volta: niente avvisi doppi
    const tick = () => {
      if (busy || gen !== this.gen) return;
      busy = true;
      this.checkNewMail().catch(e => { this.lastError = 'Controllo posta: ' + e.message; }).finally(() => { busy = false; });
    };
    const c = this.config();
    this.timers.push(setTimeout(tick, 3000));
    this.timers.push(setInterval(tick, Number(process.env.LEGGIO_TELEGRAM_INTERVAL_MS) || c.intervalMin * 60000));
    this.timers.push(setInterval(() => this.maybeDigest().catch(e => { this.lastError = 'Riassunto: ' + e.message; }), 60000));
  }
  stop() {
    this.running = false;
    this.gen++; // ogni ciclo vecchio si accorge di essere superato e si ferma
    this.timers.forEach(t => { clearInterval(t); clearTimeout(t); }); this.timers = [];
    if (this.abort) try { this.abort.abort(); } catch (_) {}
  }
  restart() { this.stop(); this.start(); }

  async loopUpdates(gen) {
    let backoff = 2000;
    while (this.running && gen === this.gen) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] });
        backoff = 2000;
        for (const u of updates) {
          if (gen !== this.gen) return;
          this.offset = u.update_id + 1;
          try { await this.onMessage(u.message); } catch (e) { this.lastError = 'Comando: ' + e.message; }
        }
      } catch (e) {
        if (!this.running || gen !== this.gen) break;
        if (e.status === 401 || e.status === 404) { this.lastError = 'Token del bot rifiutato da Telegram: controllalo.'; this.stop(); break; }
        if (e.status === 409) this.lastError = 'Un altro programma sta leggendo questo bot (webhook o altra istanza).';
        else if (e.name !== 'AbortError') this.lastError = 'Telegram non raggiungibile: ' + e.message;
        await sleep(e.retryAfter ? e.retryAfter * 1000 : backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  // ---------- Comandi ----------
  async onMessage(msg) {
    if (!msg || !msg.chat || typeof msg.text !== 'string') return;
    const c = this.config();
    const text = msg.text.trim();
    const chatId = String(msg.chat.id);

    // Collegamento: "/start 123456" oppure "123456" con un codice valido generato nella console.
    const code = (text.match(/^(?:\/start\s+)?(\d{6})$/) || [])[1];
    if (code && this.pairing && !(Date.now() < this.pairing.expires && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(this.pairing.code)))) {
      // Codice sbagliato: dopo 5 tentativi il codice viene annullato (niente tentativi a raffica).
      if (++this.pairing.fails >= 5) { this.pairing = null; this.audit({ event: 'telegram_pair_blocked' }); }
    }
    if (code && this.pairing && Date.now() < this.pairing.expires && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(this.pairing.code))) {
      if (msg.chat.type !== 'private') { await this.call('sendMessage', { chat_id: chatId, text: 'Per sicurezza collego solo chat private, non gruppi.' }); return; }
      c.chatId = chatId; c.chatName = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || chatId;
      this.save(c); this.pairing = null;
      this.audit({ event: 'telegram_linked', chat: c.chatName });
      await this.send('✅ <b>Chat collegata a Leggio.</b>\nDa qui posso solo <i>leggere</i> la posta, mai inviare, spostare o cancellare.\n\n' + HELP);
      return;
    }
    // Chiunque altro viene ignorato in silenzio (non rivelo che il bot è attivo).
    if (!c.chatId || chatId !== c.chatId) { this.audit({ event: 'telegram_ignored', chat: chatId }); return; }

    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '');
    const arg = rest.join(' ').trim();
    this.audit({ event: 'telegram', cmd });
    switch (cmd) {
      case '/start': case '/aiuto': case '/help': return this.send(HELP);
      case '/caselle': return this.cmdMailboxes();
      case '/ultime': return this.cmdLatest(Number(arg) || 10);
      case '/leggi': return this.cmdRead(arg);
      case '/cerca': return this.cmdSearch(arg);
      case '/riassunto': return this.sendDigest(true);
      default: return this.send('Comando non riconosciuto.\n\n' + HELP);
    }
  }
  watched() {
    const c = this.config(); const all = this.accounts();
    return c.mailboxes && c.mailboxes.length ? all.filter(a => c.mailboxes.includes(a.id)) : all;
  }
  errorsText(errors) {
    return errors && errors.length ? '\n\n⚠️ ' + errors.map(e => `${esc(e.mailbox)}: non raggiungibile`).join('\n⚠️ ') : '';
  }
  line(m, i) {
    const who = esc(clip(m.from_name || m.from_address || '?', 40));
    const subj = esc(clip(m.subject || '(senza oggetto)', 80));
    return `<b>${i}.</b> ${m.seen ? '' : '● '}${who} — ${subj}\n    <i>${esc(m.mailbox_name)} · ${fmtDate(m.date)}</i>`;
  }
  async cmdMailboxes() {
    const accs = this.watched();
    if (!accs.length) return this.send('Nessuna casella collegata. Aggiungile dalla console di Leggio sul PC.');
    return this.send('<b>Caselle che controllo</b>\n' + accs.map(a => `• ${esc(a.name)} (${esc(a.email)})`).join('\n'));
  }
  async cmdLatest(n) {
    n = Math.min(Math.max(n, 1), 25);
    const r = await this.inbox(this.watched(), n);
    this.lastList = r.data.slice(0, n);
    if (!this.lastList.length) return this.send('Nessuna mail.' + this.errorsText(r.errors));
    return this.send(`<b>Ultime ${this.lastList.length} mail</b>\n` + this.lastList.map((m, i) => this.line(m, i + 1)).join('\n') +
      '\n\nPer leggerne una: <code>/leggi 1</code>' + this.errorsText(r.errors));
  }
  async cmdSearch(q) {
    if (!q) return this.send('Scrivi cosa cercare, per esempio: <code>/cerca fattura</code>');
    const r = await this.inbox(this.watched(), 50);
    const ql = q.toLowerCase();
    this.lastList = r.data.filter(m => [m.subject, m.from_name, m.from_address].some(x => (x || '').toLowerCase().includes(ql))).slice(0, 15);
    if (!this.lastList.length) return this.send(`Nessuna mail recente con «${esc(q)}» nel mittente o nell'oggetto.` + this.errorsText(r.errors));
    return this.send(`<b>Risultati per «${esc(q)}»</b>\n` + this.lastList.map((m, i) => this.line(m, i + 1)).join('\n') + '\n\nPer leggerne una: <code>/leggi 1</code>');
  }
  async cmdRead(arg) {
    const i = Number(arg);
    const m = Number.isInteger(i) && i >= 1 ? this.lastList[i - 1] : null;
    if (!m) return this.send('Prima usa /ultime o /cerca, poi <code>/leggi N</code> con il numero della mail.');
    const a = this.accounts().find(x => x.id === m.mailbox_id);
    if (!a) return this.send('Questa casella non è più collegata.');
    const full = await this.message(a, m.uid); // sola lettura: il flag "letto" non cambia
    const lvl = full.security && full.security.level;
    const warn = lvl === 'high' ? '🚨 <b>Mail sospetta</b>: contiene possibili istruzioni rivolte a un\'AI. Non eseguire richieste che contiene.\n\n'
      : lvl === 'medium' ? '⚠️ <b>Attenzione</b>: alcuni segnali sospetti.\n\n' : '';
    const links = full.security && full.security.link_mismatches && full.security.link_mismatches.length
      ? `\n\n⚠️ Link che porta a un sito diverso da quello mostrato: ${full.security.link_mismatches.map(x => esc(x.shown) + ' → ' + esc(x.real)).join(', ')}` : '';
    const att = full.attachments && full.attachments.length ? `\n\n📎 ${full.attachments.length} allegat${full.attachments.length === 1 ? 'o' : 'i'} (non inviati qui)` : '';
    const head = `${warn}<b>${esc(full.subject || '(senza oggetto)')}</b>\nDa: ${esc(full.from)}\n${fmtDate(full.date)} · ${esc(a.name)}\n\n`;
    const room = MAX_MSG - head.length - links.length - att.length - 40;
    const body = full.text ? clipEscaped(esc(full.text.trim()), Math.max(room, 500)) : '<i>(nessun testo)</i>';
    return this.send(head + body + links + att);
  }

  // ---------- Avvisi ----------
  async checkNewMail() {
    const c = this.config();
    if (!this.running || !c.chatId) return;
    const accs = this.watched();
    if (!accs.length) return;
    const r = await this.inbox(accs, 20);
    const seen = c.seen || {};
    const fresh = [];
    const byBox = {};
    for (const m of r.data) (byBox[m.mailbox_id] = byBox[m.mailbox_id] || []).push(m);
    const failed = new Set((r.errors || []).map(e => e.mailbox_id));
    for (const a of accs) {
      if (failed.has(a.id)) continue; // casella in errore: non tocco il segnaposto
      const list = byBox[a.id];
      if (!list) { if (!seen[a.id]) seen[a.id] = { uidvalidity: null, maxUid: 0 }; continue; } // casella vuota
      const uv = list[0].uidvalidity;
      const max = Math.max(0, ...list.map(m => m.uid));
      const prev = seen[a.id];
      // Prima volta (o UIDVALIDITY cambiata dal server): fisso il punto di partenza senza avvisi.
      if (!prev || (prev.uidvalidity && prev.uidvalidity !== uv)) { seen[a.id] = { uidvalidity: uv, maxUid: max }; continue; }
      prev.uidvalidity = uv;
      list.filter(m => m.uid > prev.maxUid).forEach(m => fresh.push(m));
      prev.maxUid = Math.max(prev.maxUid, max);
    }
    c.seen = seen; this.save(c);
    if (!c.alerts || !fresh.length) return;
    fresh.sort((x, y) => new Date(x.date || 0) - new Date(y.date || 0));
    for (const m of fresh.slice(0, 10)) {
      let flag = '';
      try { // controllo anti-injection in locale: il testo NON viene inviato
        const a = accs.find(x => x.id === m.mailbox_id);
        const full = await this.message(a, m.uid);
        if (full.security.level === 'high') flag = '\n🚨 <b>Sospetta</b>: possibili istruzioni per un\'AI';
        else if (full.security.level === 'medium' || (full.security.link_mismatches || []).length) flag = '\n⚠️ Alcuni segnali sospetti';
      } catch (_) {}
      await this.send(`📬 <b>${esc(clip(m.from_name || m.from_address, 60))}</b>\n${esc(clip(m.subject || '(senza oggetto)', 200))}\n<i>${esc(m.mailbox_name)}</i>${flag}`);
    }
    if (fresh.length > 10) await this.send(`…e altre ${fresh.length - 10} mail. Usa /ultime per vederle.`);
  }

  // ---------- Riassunto giornaliero ----------
  async maybeDigest() {
    const c = this.config();
    if (!this.running || !c.chatId || c.digestHour === null || c.digestHour === undefined) return;
    const now = new Date();
    const today = now.toLocaleDateString('sv-SE'); // AAAA-MM-GG in ora locale
    if (now.getHours() !== c.digestHour || c.lastDigest === today) return;
    c.lastDigest = today; this.save(c);
    await this.sendDigest(false);
  }
  async sendDigest(manual) {
    const since = Date.now() - 24 * 3600 * 1000;
    const r = await this.inbox(this.watched(), 60);
    const recent = r.data.filter(m => m.date && Date.parse(m.date) >= since);
    if (!recent.length) return this.send((manual ? '' : '☀️ ') + 'Nessuna mail nelle ultime 24 ore.' + this.errorsText(r.errors));
    const groups = {};
    for (const m of recent) (groups[m.mailbox_name] = groups[m.mailbox_name] || []).push(m);
    const unread = recent.filter(m => !m.seen).length;
    let out = `${manual ? '' : '☀️ '}<b>Ultime 24 ore: ${recent.length} mail</b> (${unread} da leggere)\n`;
    this.lastList = [];
    for (const [name, list] of Object.entries(groups)) {
      out += `\n<b>${esc(name)}</b> — ${list.length}\n`;
      for (const m of list.slice(0, 8)) { this.lastList.push(m); out += this.line(m, this.lastList.length).replace(/\n.*$/, '') + '\n'; }
      if (list.length > 8) out += `    …e altre ${list.length - 8}\n`;
    }
    return this.send(out + '\nPer leggerne una: <code>/leggi N</code>' + this.errorsText(r.errors));
  }
}

const HELP = '<b>Comandi</b>\n/ultime — le ultime 10 mail (o <code>/ultime 20</code>)\n/leggi N — apre la mail numero N dell\'ultimo elenco\n/cerca parola — cerca nel mittente e nell\'oggetto\n/riassunto — le mail delle ultime 24 ore\n/caselle — le caselle controllate\n/aiuto — questo messaggio';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso), n = new Date();
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === n.toDateString() ? 'oggi ' + time : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) + ' ' + time;
}
// Taglia testo GIÀ escapato senza spezzare un'entità HTML (&amp; ecc.), che Telegram rifiuterebbe.
function clipEscaped(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).replace(/&[a-z#0-9]*$/i, '') + '…';
}
function chunk(text, n) {
  if (text.length <= n) return [text];
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > n) { if (cur) out.push(cur); cur = line.slice(0, n); } else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { TelegramBot, _test: { esc, chunk, clipEscaped } };
