#!/usr/bin/env bash
# Avvia un server IMAP di PROVA (Dovecot, senza TLS, solo su 127.0.0.1:1143) con due caselle usa e getta.
# Serve ai test: `sudo test/setup-dovecot.sh` poi `npm run test:local`.
# Richiede Linux con dovecot-imapd installato (es. `sudo apt-get install -y dovecot-imapd`).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)/.dovecot"
mkdir -p "$D/mail" "$D/run"
id vmail >/dev/null 2>&1 || useradd -M -r -s /usr/sbin/nologin vmail
cat > "$D/dovecot.conf" <<CONF
protocols = imap
listen = 127.0.0.1
base_dir = $D/run
log_path = $D/dovecot.log
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
mail_location = maildir:$D/mail/%u
mail_uid = vmail
mail_gid = vmail
first_valid_uid = 1
passdb {
  driver = passwd-file
  args = scheme=PLAIN $D/users
}
userdb {
  driver = static
  args = uid=vmail gid=vmail home=$D/mail/%u
}
service imap-login {
  inet_listener imap {
    port = 1143
  }
  inet_listener imaps {
    port = 0
  }
  chroot =
}
service anvil {
  chroot =
}
CONF
printf 'personale@test.it:{PLAIN}pw-personale\nlavoro@test.it:{PLAIN}pw-lavoro\n' > "$D/users"
chown -R vmail:vmail "$D/mail"
chmod 755 "$D" "$(dirname "$D")"
dovecot -c "$D/dovecot.conf"
for i in $(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/1143) 2>/dev/null && { echo "Dovecot pronto su 127.0.0.1:1143"; exit 0; }; sleep 0.5; done
echo "Dovecot non è partito: vedi $D/dovecot.log" >&2; exit 1
