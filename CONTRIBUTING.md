# Contributing to Leggio

Thanks for helping. Issues and pull requests are welcome in English or Italian (*si può scrivere anche in italiano*).

## The one rule

**Leggio never writes to a mailbox.** No feature may send, reply, move, delete, flag or mark mail as read, whether through the API, the console or the Telegram bot. Pull requests that add any of this will be declined, however useful they look. Leggio's own data, like the "processed" log, is fine to write.

## Good places to start

- An English translation of the console (`public/`)
- OAuth for Outlook / Microsoft 365
- Reading folders other than INBOX
- New prompt-injection patterns in `lib-security.js`. Please add a test with a fake example and keep false positives low; the tests include normal mail and newsletters for this reason.
- Provider presets in `public/app.js`

## Development

You need Node.js 20.19 or newer.

```bash
npm install
npm start          # console on http://localhost:4000
```

Use `LEGGIO_DATA_DIR=/tmp/leggio-dev npm start` to keep your experiments away from your real data.

### Tests

The tests need a throwaway IMAP server. On Linux:

```bash
sudo apt-get install -y dovecot-imapd
sudo test/setup-dovecot.sh
npm run test:local
```

**Never point the tests at a real mailbox:** they empty the test mailboxes and fill them with fake messages.

Every change to the API, the read-only behaviour or the bot should come with a test. CI runs the suite on Node 20, 22 and 24.

## Style

- Plain Node.js with CommonJS modules and no build step. Keep dependencies to a minimum.
- The console has no inline scripts (the Content-Security-Policy blocks them). Use `addEventListener` and escape every string that comes from an email.
- User-facing text is in Italian for now. Write it plainly: say what happened and what to do next.

## License

By contributing you agree that your contribution is licensed under the [AGPL-3.0](LICENSE).
