# Changelog

## Unreleased

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
