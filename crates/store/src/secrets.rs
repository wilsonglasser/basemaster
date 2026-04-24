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
const SERVICE_HTTP_PROXY: &str = "basemaster-http-proxy";

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
