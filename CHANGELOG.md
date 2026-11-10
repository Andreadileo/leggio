# Changelog

Leggio was created by Andrea Di Leo in Rome in **July 2026**. It started under the name *Relvane*, and became open source as *Leggio* in November 2026.

*Leggio è stato creato da Andrea Di Leo a Roma nel **luglio 2026**. È nato con il nome Relvane ed è diventato open source come Leggio nel novembre 2026.*

## 1.0.0 — 2026-11-05 · Leggio

First public, open-source release (AGPL-3.0), renamed from Relvane.

- Console always behind a password; first run confirmed with a one-time code shown in the terminal; emergency code if someone locks the console with wrong attempts
- Optional lock on restart (the data key is protected by the console password)
- Session sent in a header instead of a cookie, and only accepted from the console's own page
- Requires Node.js 20.19 or newer
- English and Italian README, website, security policy, contributing guide, 74 end-to-end tests

## Relvane 5 — 2026-10-16

- Telegram bot: new-mail alerts (sender and subject only), read-only commands, daily digest
- Master password, console restricted to the same machine, token expiry, per-token "processed" log
- Prompt-injection detector v2 (hidden HTML text, invisible characters, look-alike links)
- HTML-only mail converted to text, broken encodings repaired, atomic writes

## Relvane 1 — July 2026

- First version: IMAP mailboxes exposed read-only through a local REST API with revocable tokens, prompt-injection flags and an access log
- Built for a real client: an agent that reads a hotel's mailboxes without being able to change them
