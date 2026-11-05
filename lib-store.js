// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Andrea Di Leo — Leggio, https://github.com/Andreadileo/leggio
/**
 * Leggio — archiviazione dati e cifratura.
 * - Cartella dati configurabile (LEGGIO_DATA_DIR): istanze diverse non condividono nulla.
 * - Scrittura atomica: un'interruzione non lascia mai un file JSON a metà.
 * - Password della console sempre obbligatoria (impronta scrypt).
 * - Chiave dati (AES-256-GCM) facoltativamente protetta dalla stessa password: "blocco al riavvio".
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveDataDir(appDir) {
  if (process.env.LEGGIO_DATA_DIR) return path.resolve(process.env.LEGGIO_DATA_DIR);
  const base = process.env.APPDATA || process.env.HOME || os.homedir() || appDir;
  return path.join(base, 'Leggio');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Scrive su un file temporaneo e poi rinomina: o il file nuovo c'è tutto, o resta quello vecchio.
function writeAtomic(file, data, mode) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'w', mode || 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode || 0o600); } catch (_) {}
}

function readJson(file, def) {
  if (!fs.existsSync(file)) return def;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return def;
  return JSON.parse(raw);
}
const writeJson = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 2));

// ---------- Chiave dati ----------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const MIN_MASTER_LEN = 10;

class KeyVault {
  constructor(dataDir) {
    this.plainFile = path.join(dataDir, '.secret.key');
    this.wrappedFile = path.join(dataDir, 'key.json');
    this.key = null;
    if (fs.existsSync(this.wrappedFile) && fs.existsSync(this.plainFile)) {
      // Un'attivazione o disattivazione del blocco si è interrotta a metà: la chiave in chiaro c'è ancora,
      // quindi il blocco non proteggerebbe niente. Si riparte senza blocco (la console lo mostra).
      this.key = fs.readFileSync(this.plainFile);
      try { fs.unlinkSync(this.wrappedFile); } catch (_) {}
    } else if (fs.existsSync(this.wrappedFile)) {
      this.key = null; // protetta: serve la password della console
    } else if (fs.existsSync(this.plainFile)) {
      this.key = fs.readFileSync(this.plainFile);
    } else {
      this.key = crypto.randomBytes(32);
      writeAtomic(this.plainFile, this.key);
    }
  }
  hasMaster() { return fs.existsSync(this.wrappedFile); }
  isLocked() { return this.key === null; }

  static derive(password, salt) {
    return crypto.scryptSync(String(password).normalize('NFC'), salt, 32, SCRYPT);
  }
  // Prova la password senza cambiare lo stato. Restituisce la chiave o null.
  tryUnwrap(password) {
    try {
      const w = readJson(this.wrappedFile, null);
      const kek = KeyVault.derive(password, Buffer.from(w.salt, 'hex'));
      const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(w.iv, 'hex'));
      d.setAuthTag(Buffer.from(w.tag, 'hex'));
      return Buffer.concat([d.update(Buffer.from(w.ct, 'hex')), d.final()]);
    } catch (_) { return null; }
  }
  unlock(password) {
    const k = this.tryUnwrap(password);
    if (!k) return false;
    this.key = k;
    return true;
  }
  // Attiva il blocco al riavvio (o ricifra con una password nuova). La chiave dati resta la stessa:
  // le password delle caselle non vanno ricifrate.
  setMaster(newPassword) {
    if (this.isLocked()) throw new Error('locked');
    if (typeof newPassword !== 'string' || newPassword.length < MIN_MASTER_LEN) {
      throw new Error(`La password deve avere almeno ${MIN_MASTER_LEN} caratteri`);
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const kek = KeyVault.derive(newPassword, salt);
    const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
    const ct = Buffer.concat([c.update(this.key), c.final()]);
    writeJson(this.wrappedFile, {
      v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
      salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex'),
    });
    // Solo dopo che la versione protetta è salvata, elimina la chiave in chiaro.
    if (fs.existsSync(this.plainFile)) {
      try { fs.writeFileSync(this.plainFile, crypto.randomBytes(32)); } catch (_) {}
      fs.unlinkSync(this.plainFile);
    }
  }
  // Toglie il blocco al riavvio: la chiave torna su disco senza protezione.
  removeMaster() {
    if (this.isLocked()) throw new Error('locked');
    writeAtomic(this.plainFile, this.key);
    if (fs.existsSync(this.wrappedFile)) fs.unlinkSync(this.wrappedFile);
  }
  encrypt(text) {
    if (this.isLocked()) throw new Error('locked');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
  }
  decrypt(p) {
    if (this.isLocked()) throw new Error('locked');
    const [ivH, tagH, dataH] = p.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivH, 'hex'));
    d.setAuthTag(Buffer.from(tagH, 'hex'));
    return Buffer.concat([d.update(Buffer.from(dataH, 'hex')), d.final()]).toString('utf8');
  }
}

// ---------- Password della console ----------
// Sempre obbligatoria: senza, nessuno (persona o agente sulla stessa macchina) entra nella console.
// Salvata solo come impronta scrypt.
// Codici "dalla finestra": li vede solo chi ha davanti il terminale di Leggio.
//  - codice di primo avvio: conferma che sei tu a scegliere la password;
//  - codice di emergenza: ti fa entrare anche quando qualcuno ha bloccato la console sbagliando apposta.
// 12 caratteri senza simboli ambigui (~59 bit): impossibili da indovinare, quindi non serve limitare i tentativi.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newWindowCode() {
  let c = '';
  for (let i = 0; i < 12; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8);
}
function sameCode(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const norm = (x) => x.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const a = Buffer.from(norm(given)), b = Buffer.from(norm(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
class ConsoleAuth {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'console.json');
    this.setupCode = this.isSetUp() ? null : newWindowCode();
    this.emergencyCode = null;
  }
  isSetUp() { return fs.existsSync(this.file); }
  checkSetupCode(code) { return sameCode(code, this.setupCode); }
  // Creato la prima volta che la console viene bloccata; resta valido finché Leggio è acceso.
  ensureEmergencyCode() { if (!this.emergencyCode) this.emergencyCode = newWindowCode(); return this.emergencyCode; }
  checkEmergencyCode(code) { return sameCode(code, this.emergencyCode); }
  static validate(password) {
    if (typeof password !== 'string' || password.length < MIN_MASTER_LEN) {
      throw new Error(`La password deve avere almeno ${MIN_MASTER_LEN} caratteri`);
    }
  }
  set(password) {
    ConsoleAuth.validate(password);
    const salt = crypto.randomBytes(16);
    const hash = KeyVault.derive(password, salt);
    writeJson(this.file, { v: 1, kdf: 'scrypt', salt: salt.toString('hex'), hash: hash.toString('hex') });
    this.setupCode = null;
  }
  verify(password) {
    if (typeof password !== 'string' || !password) return false;
    try {
      const c = readJson(this.file, null);
      const h = KeyVault.derive(password, Buffer.from(c.salt, 'hex'));
      const ref = Buffer.from(c.hash, 'hex');
      return h.length === ref.length && crypto.timingSafeEqual(h, ref);
    } catch (_) { return false; }
  }
}

// ---------- Log accessi con rotazione ----------
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
function makeAudit(file) {
  return function audit(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > AUDIT_MAX_BYTES) {
        fs.renameSync(file, file + '.1'); // tiene un solo archivio precedente
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (_) {}
  };
}
function readAuditTail(file, n) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).reverse();
  return lines.filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

module.exports = { resolveDataDir, ensureDir, writeAtomic, readJson, writeJson, KeyVault, ConsoleAuth, MIN_MASTER_LEN, makeAudit, readAuditTail };
