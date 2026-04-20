//! Secrets — encapsula keyring do SO atrás de uma API simples.
//!
//! Cada senha é guardada no keyring nativo (Windows Credential Manager,
//! macOS Keychain, Secret Service no Linux) sob:
//!   service = "basemaster"
//!   account = `<connection_id>`
//!
//! No futuro, este módulo ganha uma variante "passphrase" para suporte
//! ao export/import portátil — a API pública não muda.

use uuid::Uuid;

use crate::StoreResult;

const SERVICE: &str = "basemaster";
const SERVICE_SSH: &str = "basemaster-ssh";
const SERVICE_SSH_KEY: &str = "basemaster-ssh-key-passphrase";

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

// --- SSH password (separate entry pra não colidir com DB password) ---

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

// --- Passphrase da chave privada SSH ---

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
