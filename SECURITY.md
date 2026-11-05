# Security policy

Leggio handles mailbox passwords and private email, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting instead: go to the **Security** tab of this repository and click **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply as soon as possible. If the report is confirmed, it will be fixed and you'll be credited in the release notes (unless you'd rather not be).

## What counts

These break Leggio's promises and are the most important to report:

- any way to change a mailbox (send, move, delete, flag) through Leggio;
- reading mail without a valid token, or outside a token's mailbox scope;
- reaching the console from another machine, from another website in the browser, or without the console password (this includes an agent running on the same machine);
- getting mailbox passwords, the bot token or the encryption key out of Leggio;
- making the Telegram bot answer, or send mail content to, a chat other than the paired one.

Out of scope: a program running as the same operating-system user as Leggio can read its data folder directly. This is documented in the README and isn't a vulnerability.

A specific email that slips past the prompt-injection detector is useful to know about, but it's an improvement to the heuristic, not a vulnerability. Open a normal issue for those, and leave out any real personal data.

## Supported versions

Only the latest release receives security fixes.

---

**Italiano.** Per segnalare una vulnerabilità non aprire una issue pubblica: usa **Security → Report a vulnerability** in questo repository. Puoi scrivere in italiano.
