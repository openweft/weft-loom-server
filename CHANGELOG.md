# Changelog

## v0.5.0

### Security
- The embedded NATS broker now requires authorization. loom-server
  authenticates with an nkey whose seed is given by reference
  (`WEFT_LOOM_NATS_NKEY_SEED_FROM`); every workspace VM receives its own
  generated credential whose permissions cover only its own subjects
  (`weft.mounts.<vmID>`, `weft.containers.<vmID>`, `weft.exec.<vmID>.>`,
  `weft.heartbeat.<vmID>`, `weft.agent.<vmID>.>`), and JetStream consumers only
  on its own subject. The credential is revoked when the VM exits.
- The embedded broker refuses to start without a seed unless
  `WEFT_LOOM_NATS_ALLOW_NOAUTH=1` is set (development only, logged as an error).
- The JetStream store moves out of `/tmp/weft-loom-nats` to a state directory
  (`WEFT_LOOM_NATS_STORE_DIR`, else `$STATE_DIRECTORY/nats`, else
  `<user cache>/weft-loom/nats`), created or tightened to mode 0700. Streams
  `weft-mounts` and `weft-containers` are now created by the broker.

### Changed
- Upgrade note: an embedded-broker deployment must set
  `WEFT_LOOM_NATS_NKEY_SEED_FROM` (or the dev flag) before upgrading. Data in
  the old `/tmp/weft-loom-nats` is not migrated.
- All loom-server NATS connections use the configured nkey when one is set,
  including connections to an external broker.

## v0.4.1

### Added
- `WEFT_LOOM_SMTP_PASS_FROM` and `WEFT_CUBEFS_ACCESS_KEY_FROM`, same rules as
  below; the plaintext variables are deprecated and warn.

## v0.4.0

### Added
- `WEFT_CUBEFS_SECRET_KEY_FROM` and `ANTHROPIC_API_KEY_FROM`: take the secret
  as a github.com/go-authn/secretsource reference (`systemd-creds:`,
  `keychain:`, `keepassxc:`, `file:`).

### Deprecated
- Plaintext `WEFT_CUBEFS_SECRET_KEY` and `ANTHROPIC_API_KEY` still work this
  release and print a warning on stderr naming `_FROM`. Setting both forms is
  an error.

### Security
- The secrets are read once at start-up and removed from the process
  environment, so child processes no longer inherit them.
