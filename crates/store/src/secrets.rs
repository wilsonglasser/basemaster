//! Secrets — encapsulates the OS keyring behind a simple API.
//!
//! Each password is stored in the native keyring (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux) under:
//!   service = "basemaster"
//!   account = `<connection_id>`
//!
//! In the future, this module will gain a "passphrase" variant for
//! portable export/import support — the public API doesn't change.

use uuid::Uuid;

use crate::StoreResult;

const SERVICE: &str = "basemaster";
const SERVICE_SSH: &str = "basemaster-ssh";
const SERVICE_SSH_KEY: &str = "basemaster-ssh-key-passphrase";
const SERVICE_SSH_JUMPS: &str = "basemaster-ssh-jumps";
const SERVICE_HTTP_PROXY: &str = "basemaster-http-proxy";
const SERVICE_MCP: &str = "basemaster-mcp";
// O token do MCP não é por conexão — é único do app. Conta fixa.
const MCP_TOKEN_ACCOUNT: &str = "token";

const SERVICE_AI: &str = "basemaster-ai-keys";

fn entry(service: &str, connection_id: Uuid) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(service, &connection_id.to_string())
}

pub fn set_password(connection_id: Uuid, password: &str) -> StoreResult<()> {
    entry(SERVICE, connection_id)?.set_password(password)?;
    Ok(())
}

pub fn get_password(connection_id: Uuid) -> StoreResult<Option<String>> {
    match entry(SERVICE, connection_id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_password(connection_id: Uuid) -> StoreResult<()> {
    match entry(SERVICE, connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// --- SSH password (separate entry so it doesn't collide with DB password) ---

pub fn set_ssh_password(connection_id: Uuid, password: &str) -> StoreResult<()> {
    entry(SERVICE_SSH, connection_id)?.set_password(password)?;
    Ok(())
}

pub fn get_ssh_password(connection_id: Uuid) -> StoreResult<Option<String>> {
    match entry(SERVICE_SSH, connection_id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_ssh_password(connection_id: Uuid) -> StoreResult<()> {
    match entry(SERVICE_SSH, connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// --- SSH private-key passphrase ---

pub fn set_ssh_key_passphrase(connection_id: Uuid, p: &str) -> StoreResult<()> {
    entry(SERVICE_SSH_KEY, connection_id)?.set_password(p)?;
    Ok(())
}

pub fn get_ssh_key_passphrase(connection_id: Uuid) -> StoreResult<Option<String>> {
    match entry(SERVICE_SSH_KEY, connection_id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_ssh_key_passphrase(connection_id: Uuid) -> StoreResult<()> {
    match entry(SERVICE_SSH_KEY, connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// --- SSH jump hosts secrets (stored as one JSON blob per connection) ---
//
// The blob is a JSON array aligned to the order of `ssh_jump_hosts` in
// the config. Each element has `password` and/or `key_passphrase` — both
// optional. Absent indices (past the array length) mean "no secret
// known, and the user didn't provide one". Stored as a single keyring
// entry to keep cleanup trivial (one service/account per connection).

pub fn set_ssh_jumps_secrets(connection_id: Uuid, blob: &str) -> StoreResult<()> {
    entry(SERVICE_SSH_JUMPS, connection_id)?.set_password(blob)?;
    Ok(())
}

pub fn get_ssh_jumps_secrets(connection_id: Uuid) -> StoreResult<Option<String>> {
    match entry(SERVICE_SSH_JUMPS, connection_id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_ssh_jumps_secrets(connection_id: Uuid) -> StoreResult<()> {
    match entry(SERVICE_SSH_JUMPS, connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// --- HTTP proxy password (basic auth on Proxy-Authorization) ---

pub fn set_http_proxy_password(connection_id: Uuid, password: &str) -> StoreResult<()> {
    entry(SERVICE_HTTP_PROXY, connection_id)?.set_password(password)?;
    Ok(())
}

pub fn get_http_proxy_password(connection_id: Uuid) -> StoreResult<Option<String>> {
    match entry(SERVICE_HTTP_PROXY, connection_id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_http_proxy_password(connection_id: Uuid) -> StoreResult<()> {
    match entry(SERVICE_HTTP_PROXY, connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// --- MCP server token ---
//
// O token Bearer do servidor MCP local. Único do app (não por conexão),
// persistido pra não invalidar a config do cliente a cada restart.
// Regerável manualmente pelo usuário.

fn mcp_entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(SERVICE_MCP, MCP_TOKEN_ACCOUNT)
}

pub fn set_mcp_token(token: &str) -> StoreResult<()> {
    mcp_entry()?.set_password(token)?;
    Ok(())
}

pub fn get_mcp_token() -> StoreResult<Option<String>> {
    match mcp_entry()?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_mcp_token() -> StoreResult<()> {
    match mcp_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// --- AI provider API keys ---
//
// App-wide (not per connection), one keyring entry per provider id. Kept out
// of the WebView localStorage so keys aren't written to disk in plaintext.

fn ai_entry(provider: &str) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(SERVICE_AI, provider)
}

pub fn set_ai_key(provider: &str, key: &str) -> StoreResult<()> {
    ai_entry(provider)?.set_password(key)?;
    Ok(())
}

pub fn get_ai_key(provider: &str) -> StoreResult<Option<String>> {
    match ai_entry(provider)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_ai_key(provider: &str) -> StoreResult<()> {
    match ai_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
