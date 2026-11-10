// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Andrea Di Leo — Leggio, https://github.com/Andreadileo/leggio
/**
 * Leggio — accesso email di sola lettura per agenti AI
 * REST + Bearer token · IMAP read-only · token revocabili e con scadenza · audit log
 * · flag anti-injection · console con password, solo locale · blocco al riavvio facoltativo
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { scanContent, wrapForAgent } = require('./lib-security');
const { fixMojibake, bestText } = require('./lib-mail');
const store = require('./lib-store');

const VERSION = require('./package.json').version;
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '127.0.0.1'; // default sicuro: solo locale
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const API_ONLY_LOCAL = LOOPBACK_HOSTS.includes(HOST);
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || (API_ONLY_LOCAL ? PORT : PORT + 1);
const MAX_ACCOUNTS = 50;
const PROCESSED_CAP = 5000; // UID ricordati per casella e per token

// ---------- Dati ----------
const DATA_DIR = store.resolveDataDir(__dirname);
store.ensureDir(DATA_DIR);
// Migrazione dalle versioni che salvavano nella cartella dell'app (solo per la cartella dati predefinita).
if (!process.env.LEGGIO_DATA_DIR) {
  for (const f of ['accounts.json', 'tokens.json', '.secret.key', 'audit.log']) {
    try {
      const legacy = path.join(__dirname, f), dest = path.join(DATA_DIR, f);
      if (fs.existsSync(legacy) && !fs.existsSync(dest)) { fs.copyFileSync(legacy, dest); fs.unlinkSync(legacy); } // sposta, non copia: niente chiavi doppie
    } catch (_) {}
  }
}
const FILES = {
  accounts: path.join(DATA_DIR, 'accounts.json'),
  tokens: path.join(DATA_DIR, 'tokens.json'),
  processed: path.join(DATA_DIR, 'processed.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  audit: path.join(DATA_DIR, 'audit.log'),
};
const vault = new store.KeyVault(DATA_DIR);
const consoleAuth = new store.ConsoleAuth(DATA_DIR);
const audit = store.makeAudit(FILES.audit);
const { TelegramBot } = require('./lib-telegram');

const loadAccounts = () => store.readJson(FILES.accounts, []);
const saveAccounts = (a) => store.writeJson(FILES.accounts, a);
const loadTokens = () => store.readJson(FILES.tokens, []);
const saveTokens = (t) => store.writeJson(FILES.tokens, t);
const publicAccount = ({ passwordEnc, ...rest }) => rest;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- Registro "già elaborate" per token ----------
// { [tokenId]: { [mailboxId]: { uidvalidity: "123", uids: [..] } } }
function loadProcessed() { return store.readJson(FILES.processed, {}); }
function processedSet(all, tokenId, mailboxId, uidvalidity) {
  const rec = all[tokenId] && all[tokenId][mailboxId];
  if (!rec || (uidvalidity && rec.uidvalidity && rec.uidvalidity !== uidvalidity)) return new Set();
  return new Set(rec.uids);
}

// ---------- IMAP (sola lettura) ----------
const uidValidityCache = new Map(); // mailboxId -> ultima UIDVALIDITY vista

function makeClient(a) {
  return guard(new ImapFlow({
    host: a.host, port: a.port, secure: a.secure !== false,
    auth: { user: a.user, pass: vault.decrypt(a.passwordEnc) },
    logger: false, socketTimeout: 30000,
  }));
}
// Senza un listener, un errore di rete dopo la connessione ("error" di ImapFlow) chiuderebbe tutto il processo.
function guard(c) { c.on('error', () => {}); return c; }
async function testConnection(a) {
  const c = guard(new ImapFlow({
    host: a.host, port: a.port, secure: a.secure !== false,
    auth: { user: a.user, pass: a.password }, logger: false, socketTimeout: 20000,
  }));
  try {
    await c.connect();
    // Verifica anche che la INBOX si apra in sola lettura, non solo il login.
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    lock.release();
    await c.logout();
  } catch (err) { try { c.close(); } catch (_) {} throw err; }
}
function friendlyImapError(err) {
  const msg = (err && (err.responseText || err.message)) || String(err);
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|LOGIN failed/i.test(msg)) {
    return msg + ' — controlla utente e password (Gmail, iCloud e Yahoo vogliono una "password per le app").';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return msg + ' — il server IMAP non esiste o manca la rete.';
  if (/ETIMEDOUT|timeout/i.test(msg)) return msg + ' — il server non risponde: controlla server e porta.';
  if (/Command failed/i.test(msg)) return msg + ' — su Aruba succede con le caselle nuove: cambia la password dalla webmail al primo accesso.';
  return msg;
}
async function fetchInbox(a, limit) {
  let c; const messages = [];
  try {
    c = makeClient(a);
    await c.connect();
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uidvalidity = c.mailbox.uidValidity != null ? String(c.mailbox.uidValidity) : null;
      uidValidityCache.set(a.id, uidvalidity);
      const total = c.mailbox.exists;
      if (total > 0) {
        const start = Math.max(1, total - limit + 1);
        for await (const m of c.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
          const env = m.envelope || {}; const from = (env.from && env.from[0]) || {};
          messages.push({
            mailbox_id: a.id, mailbox_name: a.name, uid: m.uid, uidvalidity,
            subject: fixMojibake(env.subject || ''),
            from_name: fixMojibake(from.name || from.address || ''),
            from_address: from.address || '',
            date: env.date ? new Date(env.date).toISOString() : null,
            seen: m.flags ? m.flags.has('\\Seen') : false,
          });
        }
      }
    } finally { lock.release(); }
    await c.logout();
  } catch (err) {
    try { c && c.close(); } catch (_) {}
    return { error: friendlyImapError(err), messages: [] };
  }
  return { messages };
}
async function fetchMessage(a, uid) {
  const c = makeClient(a);
  try {
    await c.connect();
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      // BODY.PEEK su una casella aperta con EXAMINE: il flag "letto" non cambia.
      const { content } = await c.download(String(uid), undefined, { uid: true });
      const chunks = [];
      for await (const ch of content) chunks.push(ch);
      const raw = Buffer.concat(chunks);
      const parsed = await simpleParser(raw);
      const { text, text_source } = bestText(parsed, raw);
      const security = scanContent(text, parsed.html || '');
      const subject = fixMojibake(parsed.subject || '');
      const from = fixMojibake(parsed.from ? parsed.from.text : '');
      return {
        mailbox_id: a.id, uid: Number(uid),
        uidvalidity: c.mailbox.uidValidity != null ? String(c.mailbox.uidValidity) : null,
        subject, from, to: parsed.to ? parsed.to.text : '',
        date: parsed.date ? parsed.date.toISOString() : null,
        text, text_source, html: parsed.html || null,
        text_for_agent: wrapForAgent(text, { from, subject }),
        attachments: (parsed.attachments || []).map(x => ({ filename: x.filename, size: x.size, contentType: x.contentType })),
        security, // { level, score, flags, link_mismatches }
      };
    } finally { lock.release(); await c.logout(); }
  } catch (err) { try { c.close(); } catch (_) {} throw err; }
}
async function inboxFor(accs, limit) {
  const results = await Promise.all(accs.map(a => fetchInbox(a, limit)));
  const data = results.flatMap(r => r.messages).sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0));
  const errors = results.map((r, i) => r.error ? { mailbox: accs[i].name, mailbox_id: accs[i].id, error: r.error } : null).filter(Boolean);
  return { data, errors };
}

// ---------- Bot Telegram ----------
const telegram = new TelegramBot({
  dataDir: DATA_DIR, vault, audit,
  accounts: () => loadAccounts(),
  inbox: inboxFor,
  message: fetchMessage,
});

// ---------- Rate limit in memoria ----------
function makeLimiter(windowMs, max) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const rec = hits.get(key) || { count: 0, reset: now + windowMs };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
    rec.count++; hits.set(key, rec);
    return rec.count <= max;
  };
}
const tokenLimit = makeLimiter(60000, 120);
const authFailLimit = makeLimiter(60000, 20);
// Accessi SBAGLIATI alla console: dopo 5 in un minuto serve anche il codice di emergenza dalla finestra di Leggio.
const failures = new Map();
const tooManyFailures = (ip) => { const r = failures.get(ip); return !!r && Date.now() < r.reset && r.count >= 5; };
const recordFailure = (ip) => {
  const now = Date.now(); const r = failures.get(ip);
  if (!r || now > r.reset) failures.set(ip, { count: 1, reset: now + 60000 }); else r.count++;
};

// ---------- Header di sicurezza ----------
function securityHeaders(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // La console non esegue script esterni o in linea. Le mail HTML si vedono in un iframe
  // "sandbox" che eredita questa policy: niente script e niente immagini remote (pixel spia).
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'");
  next();
}
function hostOf(req) { return (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''); }

// ================= API AGENTI (/v1, richiede token) =================
const api = express.Router();
api.use('/v1', express.json({ limit: '64kb' }));

function bearer(req, res, next) {
  if (vault.isLocked()) return res.status(503).json({ error: 'locked', detail: 'Leggio è bloccato dopo il riavvio: entra nella console per sbloccarlo.' });
  const ip = req.socket.remoteAddress || '';
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'missing_token' });
  const hash = sha256(m[1].trim());
  const tokens = loadTokens();
  const tok = tokens.find(t => t.hash === hash && !t.revoked);
  if (!tok) {
    if (!authFailLimit(ip)) return res.status(429).json({ error: 'rate_limited' });
    audit({ event: 'auth_fail', ip });
    return res.status(401).json({ error: 'invalid_token' });
  }
  if (tok.expiresAt && Date.now() > Date.parse(tok.expiresAt)) {
    audit({ event: 'auth_expired', tokenId: tok.id, ip });
    return res.status(401).json({ error: 'token_expired' });
  }
  if (!tokenLimit(tok.id)) return res.status(429).json({ error: 'rate_limited' });
  // Aggiorna "ultimo uso" al massimo una volta al minuto: niente riscrittura a ogni chiamata.
  if (!tok.lastUsed || Date.now() - Date.parse(tok.lastUsed) > 60000) {
    tok.lastUsed = new Date().toISOString();
    try { saveTokens(tokens); } catch (_) {}
  }
  req.token = tok;
  audit({ event: 'api', tokenId: tok.id, method: req.method, path: req.path, ip });
  next();
}
function visibleAccounts(tok) {
  const all = loadAccounts();
  if (!tok.mailboxes || tok.mailboxes.length === 0) return all;
  return all.filter(a => tok.mailboxes.includes(a.id));
}

api.get('/health', (req, res) => res.json({ ok: true, service: 'leggio-api', version: VERSION, locked: vault.isLocked() }));

api.get('/v1/mailboxes', bearer, (req, res) => {
  res.json({ data: visibleAccounts(req.token).map(a => ({ id: a.id, name: a.name, email: a.email })) });
});

api.get('/v1/messages', bearer, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const accs = visibleAccounts(req.token).filter(a => !req.query.mailbox || a.id === req.query.mailbox);
  if (accs.length === 0) return res.json({ data: [], errors: [] });
  const out = await inboxFor(accs, limit);
  const proc = loadProcessed();
  for (const m of out.data) m.processed = processedSet(proc, req.token.id, m.mailbox_id, m.uidvalidity).has(m.uid);
  if (req.query.unprocessed === '1' || req.query.unprocessed === 'true') out.data = out.data.filter(m => !m.processed);
  res.json(out);
});

api.get('/v1/messages/:mailboxId/:uid', bearer, async (req, res) => {
  if (!/^[0-9]{1,10}$/.test(req.params.uid)) return res.status(400).json({ error: 'invalid_uid' });
  const a = visibleAccounts(req.token).find(x => x.id === req.params.mailboxId);
  if (!a) return res.status(404).json({ error: 'mailbox_not_found' });
  try { res.json({ data: await fetchMessage(a, req.params.uid) }); }
  catch (err) { res.status(502).json({ error: 'imap_error', detail: friendlyImapError(err) }); }
});

// Segna come "elaborate" per QUESTO token. Scrive solo nel registro di Leggio:
// la casella email non viene toccata (resta sola lettura).
api.post('/v1/processed', bearer, (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 500) : null;
  if (!items) return res.status(400).json({ error: 'items_required', detail: 'Corpo atteso: {"items":[{"mailbox_id":"...","uid":123}]}' });
  const allowed = new Set(visibleAccounts(req.token).map(a => a.id));
  const all = loadProcessed();
  const mine = all[req.token.id] || (all[req.token.id] = {});
  let saved = 0;
  for (const it of items) {
    const uid = Number(it && it.uid);
    if (!it || !allowed.has(it.mailbox_id) || !Number.isInteger(uid) || uid <= 0) continue;
    const uv = it.uidvalidity != null ? String(it.uidvalidity) : (uidValidityCache.get(it.mailbox_id) || null);
    let rec = mine[it.mailbox_id];
    if (!rec || (uv && rec.uidvalidity && rec.uidvalidity !== uv)) rec = mine[it.mailbox_id] = { uidvalidity: uv, uids: [] };
    if (!rec.uidvalidity && uv) rec.uidvalidity = uv;
    if (!rec.uids.includes(uid)) { rec.uids.push(uid); saved++; }
    if (rec.uids.length > PROCESSED_CAP) rec.uids = rec.uids.sort((x, y) => x - y).slice(-PROCESSED_CAP);
  }
  store.writeJson(FILES.processed, all);
  res.json({ ok: true, saved });
});

api.use('/v1', (req, res) => res.status(404).json({ error: 'not_found' }));

// ================= CONSOLE (solo locale) =================
const admin = express.Router();
const sessions = new Map(); // id -> scadenza
const SESSION_MS = 12 * 60 * 60 * 1000;

// La sessione viaggia nell'intestazione X-Leggio-Session, non in un cookie: i cookie di localhost
// valgono per TUTTE le porte, quindi qualunque altro programma con una pagina su localhost:XXXX
// potrebbe usarli o riceverli. L'intestazione la può mandare solo la pagina della console.
function sessionId(req) { const v = req.headers['x-leggio-session']; return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null; }
function hasSession(req) {
  const id = sessionId(req);
  const exp = id && sessions.get(id);
  if (!exp || Date.now() > exp) { if (id) sessions.delete(id); return false; }
  sessions.set(id, Date.now() + SESSION_MS);
  return true;
}
function newSession() {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, Date.now() + SESSION_MS);
  return id;
}
function endAllSessions() { for (const k of sessions.keys()) sessions.delete(k); }

// La console risponde solo a richieste dirette dalla stessa macchina e dalla sua stessa pagina:
// niente proxy (che farebbe sembrare "locale" chiunque), niente altri siti o altre porte nel browser.
function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress || '';
  const isLoop = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const proxied = req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-real-ip'];
  if (!isLoop || proxied) return res.status(403).json({ error: 'admin_local_only' });
  if (!LOOPBACK_HOSTS.includes(hostOf(req))) return res.status(403).json({ error: 'forbidden_host' });
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'forbidden_origin' });
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'forbidden_origin' });
  next();
}
// La console vuole SEMPRE una sessione, ottenuta con la password della console.
function adminAuth(req, res, next) {
  if (!consoleAuth.isSetUp()) return res.status(401).json({ error: 'setup_required' });
  if (vault.isLocked()) return res.status(423).json({ error: 'locked' });
  if (!hasSession(req)) return res.status(401).json({ error: 'login_required' });
  next();
}

admin.use(localOnly);
admin.use('/admin/backup/import', express.json({ limit: '20mb' })); // un backup può essere grande
admin.use('/admin', express.json({ limit: '256kb' }));

admin.get('/admin/status', (req, res) => {
  const setupRequired = !consoleAuth.isSetUp();
  const loggedIn = !setupRequired && !vault.isLocked() && hasSession(req);
  const out = { version: VERSION, setupRequired, locked: vault.isLocked(), loggedIn };
  // Il resto solo a chi è entrato nella console.
  if (loggedIn) Object.assign(out, { dataDir: DATA_DIR, lockOnRestart: vault.hasMaster(), accounts: loadAccounts().length, apiBase: API_ONLY_LOCAL ? null : `${HOST}:${PORT}` });
  res.json(out);
});

// Primo avvio: serve il codice mostrato nella finestra di Leggio.
admin.post('/admin/setup', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (consoleAuth.isSetUp()) return res.status(409).json({ error: 'La password della console è già stata scelta.' });
  const { code, password } = req.body || {};
  if (!consoleAuth.checkSetupCode(code)) { audit({ event: 'setup_fail', ip }); return res.status(403).json({ error: 'Codice di primo avvio sbagliato: lo trovi nella finestra di Leggio.' }); }
  try { store.ConsoleAuth.validate(password); } catch (err) { return res.status(400).json({ error: err.message }); }
  // Dati di una versione precedente con la chiave protetta: la stessa password deve aprirla,
  // e diventa la password della console. Si controlla PRIMA di salvare qualsiasi cosa.
  if (vault.hasMaster()) {
    const key = vault.tryUnwrap(password);
    if (!key) return res.status(401).json({ error: 'Questa cartella dati è protetta da una master password: usa quella.' });
    if (vault.isLocked()) vault.unlock(password);
  }
  try { consoleAuth.set(password); } catch (err) { return res.status(400).json({ error: err.message }); }
  audit({ event: 'console_setup', ip });
  telegram.start();
  res.json({ ok: true, session: newSession() });
});

// Accesso alla console. Se Leggio è bloccato dopo un riavvio, la stessa password lo sblocca.
admin.post('/admin/login', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!consoleAuth.isSetUp()) return res.status(401).json({ error: 'setup_required' });
  const { password, code } = req.body || {};
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Inserisci la password.' });
  if (tooManyFailures(ip) && !consoleAuth.checkEmergencyCode(code)) {
    const fresh = !consoleAuth.emergencyCode;
    const c = consoleAuth.ensureEmergencyCode();
    if (fresh) console.log(`\n  Troppi tentativi sbagliati sulla console. Per entrare subito usa questo codice di emergenza: ${c}\n`);
    return res.status(429).json({ error: 'Troppi tentativi sbagliati. Aspetta un minuto, oppure inserisci anche il codice di emergenza che trovi nella finestra di Leggio.', needCode: true });
  }
  const okConsole = consoleAuth.verify(password);
  // Se un cambio password si era interrotto a metà, la chiave dei dati ha già la password nuova: la si accetta e si riallinea.
  const okKey = !okConsole && vault.hasMaster() && !!vault.tryUnwrap(password);
  if (!okConsole && !okKey) { recordFailure(ip); audit({ event: 'login_fail', ip }); return res.status(401).json({ error: 'Password sbagliata.' }); }
  if (okKey) consoleAuth.set(password);
  if (vault.isLocked()) {
    if (!vault.unlock(password)) { audit({ event: 'unlock_fail', ip }); return res.status(500).json({ error: 'La password è giusta ma non apre la chiave dei dati: la cartella dati è incoerente.' }); }
    audit({ event: 'unlock', ip });
    telegram.start(); // il token del bot si può decifrare solo ora
  }
  failures.delete(ip);
  audit({ event: 'login', ip });
  res.json({ ok: true, session: newSession() });
});
admin.post('/admin/logout', (req, res) => {
  const id = sessionId(req); if (id) sessions.delete(id);
  res.json({ ok: true });
});

admin.use('/admin', adminAuth);

// Cambio password (serve quella attuale). Prima si ricifra la chiave, poi si salva la password:
// se qualcosa si interrompe in mezzo, l'accesso con la password nuova riallinea tutto (vedi /admin/login).
admin.post('/admin/password', (req, res) => {
  const { current, password } = req.body || {};
  if (!consoleAuth.verify(current)) return res.status(401).json({ error: 'La password attuale non è corretta.' });
  try {
    store.ConsoleAuth.validate(password);
    if (vault.hasMaster()) vault.setMaster(password);
    consoleAuth.set(password);
  } catch (err) { return res.status(400).json({ error: err.message }); }
  audit({ event: 'password_changed', ip: req.socket.remoteAddress });
  endAllSessions();
  res.json({ ok: true, session: newSession() });
});

// Blocco al riavvio: la chiave dei dati viene cifrata con la password della console.
// Utile sul PC; sconsigliato su un server che si riavvia da solo (resterebbe fermo finché qualcuno entra).
admin.post('/admin/lock-on-restart', (req, res) => {
  const { enabled, password } = req.body || {};
  if (!consoleAuth.verify(password)) return res.status(401).json({ error: 'Password sbagliata.' });
  try { if (enabled) vault.setMaster(password); else vault.removeMaster(); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  audit({ event: enabled ? 'lock_on' : 'lock_off', ip: req.socket.remoteAddress });
  res.json({ ok: true, lockOnRestart: vault.hasMaster() });
});

// ---------- Backup cifrato: portare tutto su un altro computer ----------
// Esporta caselle (con le password, ricifrate con la password del backup), token, registro
// delle elaborate e bot Telegram. Serve la password della console per confermare.
admin.post('/admin/backup/export', (req, res) => {
  const { password, backupPassword } = req.body || {};
  if (!consoleAuth.verify(password)) return res.status(401).json({ error: 'Password della console sbagliata.' });
  let file;
  try {
    const accounts = loadAccounts().map(({ passwordEnc, ...a }) => ({ ...a, password: vault.decrypt(passwordEnc) }));
    const tg = telegram.config();
    const telegramOut = tg.botTokenEnc ? { ...tg, botTokenEnc: undefined, botToken: telegram.token() } : null;
    file = store.sealBackup({ accounts, tokens: loadTokens(), processed: loadProcessed(), telegram: telegramOut },
      backupPassword, { createdAt: new Date().toISOString(), leggio: VERSION, counts: { mailboxes: accounts.length } });
  } catch (err) { return res.status(400).json({ error: err.message }); }
  audit({ event: 'backup_export', ip: req.socket.remoteAddress });
  res.json(file);
});

// Importa un backup. Le caselle mantengono il loro id (i registri degli agenti restano validi),
// i token restano gli stessi. Ciò che c'è già non viene sovrascritto.
admin.post('/admin/backup/import', (req, res) => {
  const { backup, backupPassword } = req.body || {};
  let data;
  try { data = store.openBackup(backup, backupPassword); } catch (err) { return res.status(400).json({ error: err.message }); }
  const accounts = loadAccounts();
  const have = new Set(accounts.map(a => a.id));
  const sameBox = (a) => accounts.some(x => x.host === a.host && x.user === a.user);
  let addedBoxes = 0, skippedBoxes = 0;
  for (const a of Array.isArray(data.accounts) ? data.accounts : []) {
    if (!a || typeof a.id !== 'string' || typeof a.password !== 'string' || have.has(a.id) || sameBox(a)) { skippedBoxes++; continue; }
    if (accounts.length >= MAX_ACCOUNTS) { skippedBoxes++; continue; }
    const { password, ...rest } = a;
    accounts.push({ ...rest, passwordEnc: vault.encrypt(password) });
    have.add(a.id); addedBoxes++;
  }
  saveAccounts(accounts);

  const tokens = loadTokens();
  const haveTok = new Set(tokens.map(t => t.id));
  let addedTokens = 0;
  for (const t of Array.isArray(data.tokens) ? data.tokens : []) {
    if (!t || typeof t.id !== 'string' || typeof t.hash !== 'string' || haveTok.has(t.id) || tokens.some(x => x.hash === t.hash)) continue;
    tokens.push(t); haveTok.add(t.id); addedTokens++;
  }
  saveTokens(tokens);

  if (data.processed && typeof data.processed === 'object') {
    const proc = loadProcessed();
    for (const [tok, boxes] of Object.entries(data.processed)) if (!proc[tok]) proc[tok] = boxes;
    store.writeJson(FILES.processed, proc);
  }

  let telegramImported = false;
  if (data.telegram && data.telegram.botToken && !telegram.config().botTokenEnc) {
    const { botToken, ...cfg } = data.telegram;
    telegram.save({ ...cfg, botTokenEnc: vault.encrypt(botToken) });
    telegram.restart();
    telegramImported = true;
  }
  audit({ event: 'backup_import', ip: req.socket.remoteAddress, mailboxes: addedBoxes });
  res.json({ ok: true, addedBoxes, skippedBoxes, addedTokens, telegramImported });
});

// ---------- Avviso di aggiornamento ----------
// Una volta al giorno chiede a GitHub qual è l'ultima versione pubblicata. Non invia nessun dato
// tuo: solo una richiesta pubblica, come aprire la pagina delle release. Si può spegnere.
const UPDATE_URL = process.env.LEGGIO_UPDATE_URL || 'https://api.github.com/repos/Andreadileo/leggio/releases/latest';
const RELEASES_PAGE = 'https://github.com/Andreadileo/leggio/releases';
let updateInfo = null; // { latest, url, checkedAt }
const loadSettings = () => store.readJson(FILES.settings, {});
const updateCheckEnabled = () => process.env.LEGGIO_UPDATE_CHECK !== '0' && loadSettings().updateCheck !== false;
const semver = (v) => String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
const isNewer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkForUpdate(force) {
  if (!updateCheckEnabled()) return null;
  if (!force && updateInfo && Date.now() - updateInfo.checkedAt < 24 * 3600 * 1000) return updateInfo;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(UPDATE_URL, { headers: { 'User-Agent': 'Leggio/' + VERSION, Accept: 'application/vnd.github+json' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const url = typeof j.html_url === 'string' && j.html_url.startsWith(RELEASES_PAGE) ? j.html_url : RELEASES_PAGE;
    updateInfo = { latest: String(j.tag_name || '').replace(/^v/, ''), url, checkedAt: Date.now() };
  } catch (_) { updateInfo = { latest: null, url: RELEASES_PAGE, checkedAt: Date.now() }; }
  return updateInfo;
}
admin.get('/admin/update', async (req, res) => {
  const enabled = updateCheckEnabled();
  const info = enabled ? await checkForUpdate(false) : null;
  res.json({ enabled, current: VERSION, latest: info && info.latest, newer: !!(info && info.latest && isNewer(info.latest, VERSION)), url: (info && info.url) || RELEASES_PAGE });
});
admin.post('/admin/update', (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  store.writeJson(FILES.settings, { ...loadSettings(), updateCheck: enabled });
  if (!enabled) updateInfo = null;
  res.json({ ok: true, enabled: updateCheckEnabled() });
});

admin.get('/admin/accounts', (req, res) => res.json(loadAccounts().map(publicAccount)));
admin.post('/admin/accounts', async (req, res) => {
  const { name, email, host, port, secure, user, password, provider } = req.body || {};
  if (!name || !host || !user || !password) return res.status(400).json({ error: 'Campi obbligatori: nome, server, utente, password' });
  if (!/^[a-z0-9.-]+$/i.test(String(host))) return res.status(400).json({ error: 'Server IMAP non valido' });
  const accounts = loadAccounts();
  if (accounts.length >= MAX_ACCOUNTS) return res.status(400).json({ error: `Massimo ${MAX_ACCOUNTS} caselle` });
  const cfg = { host: String(host).trim(), port: Number(port) || 993, secure: secure !== false, user: String(user).trim(), password };
  if (accounts.some(a => a.host === cfg.host && a.user === cfg.user)) return res.status(400).json({ error: 'Questa casella è già collegata' });
  try { await testConnection(cfg); }
  catch (err) { return res.status(400).json({ error: 'Connessione IMAP fallita: ' + friendlyImapError(err) }); }
  const account = {
    id: crypto.randomUUID(), name: String(name).trim(), email: String(email || user).trim(),
    host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, provider: provider || null,
    passwordEnc: vault.encrypt(password), createdAt: new Date().toISOString(),
  };
  accounts.push(account); saveAccounts(accounts);
  audit({ event: 'mailbox_added', mailbox: account.email, ip: req.socket.remoteAddress });
  res.json(publicAccount(account));
});
admin.delete('/admin/accounts/:id', (req, res) => {
  const accounts = loadAccounts(); const gone = accounts.find(a => a.id === req.params.id);
  if (!gone) return res.status(404).json({ error: 'not_found' });
  saveAccounts(accounts.filter(a => a.id !== req.params.id));
  audit({ event: 'mailbox_removed', mailbox: gone.email, ip: req.socket.remoteAddress });
  res.json({ ok: true });
});

// Token: la stringa in chiaro si mostra UNA sola volta alla creazione
admin.get('/admin/tokens', (req, res) => res.json(loadTokens().map(({ hash, ...t }) => t)));
admin.post('/admin/tokens', (req, res) => {
  const { label, mailboxes, days } = req.body || {};
  const accIds = new Set(loadAccounts().map(a => a.id));
  // Una lista di caselle non vuota che non contiene caselle valide NON deve diventare "tutte".
  if (Array.isArray(mailboxes) && mailboxes.length && !mailboxes.some(id => accIds.has(id))) {
    return res.status(400).json({ error: 'Le caselle scelte non esistono più: ricarica la pagina.' });
  }
  const secret = 'lg_live_' + crypto.randomBytes(24).toString('hex');
  const d = Number(days);
  const tokens = loadTokens();
  const tok = {
    id: crypto.randomUUID(), label: String(label || 'senza nome').slice(0, 80),
    hash: sha256(secret), prefix: secret.slice(0, 14),
    mailboxes: Array.isArray(mailboxes) ? mailboxes.filter(id => accIds.has(id)) : [],
    createdAt: new Date().toISOString(),
    expiresAt: d > 0 ? new Date(Date.now() + d * 86400000).toISOString() : null,
    lastUsed: null, revoked: false,
  };
  tokens.push(tok); saveTokens(tokens);
  audit({ event: 'token_created', tokenId: tok.id, ip: req.socket.remoteAddress });
  const { hash, ...pub } = tok;
  res.json({ ...pub, token: secret });
});
admin.delete('/admin/tokens/:id', (req, res) => {
  const tokens = loadTokens(); const tok = tokens.find(t => t.id === req.params.id);
  if (!tok) return res.status(404).json({ error: 'not_found' });
  tok.revoked = true; saveTokens(tokens);
  audit({ event: 'token_revoked', tokenId: tok.id, ip: req.socket.remoteAddress });
  res.json({ ok: true });
});
admin.get('/admin/audit', (req, res) => res.json({ data: store.readAuditTail(FILES.audit, 300) }));

// Telegram
admin.get('/admin/telegram', (req, res) => res.json(telegram.publicState()));
admin.post('/admin/telegram', async (req, res) => {
  const b = req.body || {};
  try {
    const accIds = new Set(loadAccounts().map(a => a.id));
    if (Array.isArray(b.mailboxes) && b.mailboxes.length && !b.mailboxes.some(id => accIds.has(id))) {
      return res.status(400).json({ error: 'Le caselle scelte non esistono più: ricarica la pagina.' });
    }
    if (b.botToken) await telegram.setToken(b.botToken);
    telegram.update({
      enabled: b.enabled, alerts: b.alerts, intervalMin: b.intervalMin, digestHour: b.digestHour,
      mailboxes: Array.isArray(b.mailboxes) ? b.mailboxes.filter(id => accIds.has(id)) : undefined,
    });
  } catch (err) { return res.status(400).json({ error: 'Telegram: ' + err.message }); }
  audit({ event: 'telegram_config', ip: req.socket.remoteAddress });
  telegram.restart();
  res.json(telegram.publicState());
});
admin.post('/admin/telegram/pair', (req, res) => {
  if (!telegram.config().botTokenEnc) return res.status(400).json({ error: 'Prima inserisci il token del bot.' });
  telegram.newPairing();
  if (!telegram.running) { telegram.update({ enabled: true }); telegram.start(); }
  res.json(telegram.publicState());
});
admin.post('/admin/telegram/test', async (req, res) => {
  try { await telegram.send('🔔 Messaggio di prova da Leggio. Il collegamento funziona.'); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: 'Invio non riuscito: ' + err.message }); }
});
admin.post('/admin/telegram/unlink', (req, res) => { telegram.unlink(); audit({ event: 'telegram_unlinked' }); res.json(telegram.publicState()); });
admin.delete('/admin/telegram', (req, res) => { telegram.remove(); audit({ event: 'telegram_removed' }); res.json(telegram.publicState()); });

// Vista posta per la console
admin.get('/admin/inbox', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const accounts = loadAccounts();
  if (accounts.length === 0) return res.json({ data: [], errors: [] });
  res.json(await inboxFor(accounts, limit));
});
admin.get('/admin/message/:mailboxId/:uid', async (req, res) => {
  if (!/^[0-9]{1,10}$/.test(req.params.uid)) return res.status(400).json({ error: 'invalid_uid' });
  const a = loadAccounts().find(x => x.id === req.params.mailboxId);
  if (!a) return res.status(404).json({ error: 'mailbox_not_found' });
  try { res.json(await fetchMessage(a, req.params.uid)); }
  catch (err) { res.status(502).json({ error: 'imap_error', detail: friendlyImapError(err) }); }
});
admin.use('/admin', (req, res) => res.status(404).json({ error: 'not_found' }));
admin.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ================= Avvio =================
function openBrowser(url) {
  const { execFile } = require('child_process');
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
}
function makeApp(routers) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  // In modalità solo-locale blocca il DNS rebinding anche per l'API.
  if (API_ONLY_LOCAL) app.use((req, res, next) => LOOPBACK_HOSTS.includes(hostOf(req)) ? next() : res.status(403).json({ error: 'forbidden_host' }));
  routers.forEach(r => app.use(r));
  app.use((err, req, res, next) => { // JSON malformato e simili: niente stack trace verso l'esterno
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.type === 'entity.parse.failed' ? 'invalid_json' : 'server_error' });
  });
  return app;
}
function listen(app, port, host, label, attempt, onReady) {
  const server = app.listen(port, host, () => onReady(port));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) { console.log(`Porta ${port} occupata, provo ${port + 1}...`); listen(app, port + 1, host, label, attempt + 1, onReady); }
    else { console.error(`Avvio ${label} fallito:`, err.message); process.exit(1); }
  });
}

function start() {
  const showUrl = (p) => `http://localhost:${p}`;
  const announceConsole = (p) => {
    console.log(`Console di amministrazione: ${showUrl(p)}`);
    console.log(`Cartella dati: ${DATA_DIR}`);
    let open = showUrl(p);
    if (!consoleAuth.isSetUp()) {
      console.log('');
      console.log('  PRIMO AVVIO — codice per scegliere la password della console: ' + consoleAuth.setupCode);
      console.log('  (serve a dimostrare che sei tu, davanti a questa finestra; vale finché Leggio resta acceso)');
      console.log('');
      open += '/#setup=' + consoleAuth.setupCode.replace(/-/g, ''); // il frammento dopo # non viene mai inviato al server
    } else if (vault.isLocked()) {
      console.log('Stato: BLOCCATO dopo il riavvio — entra nella console con la tua password per sbloccarlo.');
    }
    if (process.pkg || process.env.OPEN_BROWSER === '1') openBrowser(open);
  };
  if (API_ONLY_LOCAL && ADMIN_PORT === PORT) {
    listen(makeApp([api, admin]), PORT, HOST, 'Leggio', 0, (p) => {
      console.log(`Leggio ${VERSION} in ascolto su ${showUrl(p)} (solo locale)`);
      announceConsole(p);
    });
  } else {
    listen(makeApp([api]), PORT, HOST, 'API', 0, (p) => console.log(`API Leggio ${VERSION} su ${HOST}:${p} — usala solo dietro HTTPS`));
    listen(makeApp([admin]), ADMIN_PORT, '127.0.0.1', 'console', 0, announceConsole);
  }
  telegram.start(); // parte solo se configurato, attivo e non bloccato
}

// Rete di sicurezza: un errore imprevisto viene registrato, non spegne Leggio.
process.on('unhandledRejection', (err) => { console.error('Errore non gestito:', err && err.message ? err.message : err); });

if (require.main === module) start();
module.exports = { start, _internals: { vault, DATA_DIR } };
