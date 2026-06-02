-- Opt-in TOFU for headless scheduled runs: when set, the OS-registered task is
-- invoked with `--accept-ssh-hosts`, auto-accepting an unknown SSH host key on
-- first contact (otherwise such a run fails safe).
ALTER TABLE scheduled_backups ADD COLUMN accept_ssh_hosts INTEGER NOT NULL DEFAULT 0;
