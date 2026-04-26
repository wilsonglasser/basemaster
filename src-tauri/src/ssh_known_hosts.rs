//! SSH host-key verification with per-app `known_hosts`.
//!
//! Backed by a plain text file at `<app_data_dir>/ssh_known_hosts`.
//! Format (one entry per line):
//!
//! ```text
//! <host>:<port> <openssh-encoded-public-key>
//! # blank lines and lines starting with `#` are ignored
//! ```
//!
//! Behavior (TOFU — Trust On First Use):
//!   * `Match`    — stored key matches the server's: connection allowed.
//!   * `Mismatch` — stored key differs: connection ABORTED. Possible MITM.
//!     User must manually remove/edit the file to accept the new key
//!     (no silent update).
//!   * `Unknown`  — no stored key: TOFU, append and allow. First-connect
//!     dialog with fingerprint confirmation is a follow-up.
//!
//! Multiple keys per host are supported (key rotation / multi-algorithm).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use russh::keys::ssh_key;
use serde::Serialize;
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Hash, Eq, PartialEq, Clone, Debug)]
struct HostPort(String, u16);

pub enum Verdict {
    Match,
    Mismatch,
    Unknown,
}

/// Flat representation of one stored key — serialized to the frontend
/// for the Settings list.
#[derive(Serialize, Clone)]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub openssh: String,
}

/// SHA-256 fingerprint in the OpenSSH-compatible form
/// `SHA256:<base64-no-padding>`. Deterministic and safe to display.
pub fn fingerprint_sha256(key: &ssh_key::PublicKey) -> String {
    key.fingerprint(ssh_key::HashAlg::Sha256).to_string()
}

pub struct KnownHosts {
    path: PathBuf,
    entries: RwLock<HashMap<HostPort, Vec<ssh_key::PublicKey>>>,
}

impl KnownHosts {
    /// Loads the known_hosts file. Missing file is not an error — the
    /// map starts empty and the file is created on the first TOFU add.
    pub async fn load(path: PathBuf) -> Self {
        let entries = match fs::read_to_string(&path).await {
            Ok(text) => parse(&text),
            Err(_) => HashMap::new(),
        };
        Self {
            path,
            entries: RwLock::new(entries),
        }
    }

    pub fn verify(&self, host: &str, port: u16, key: &ssh_key::PublicKey) -> Verdict {
        let entries = self.entries.read().unwrap();
        match entries.get(&HostPort(host.to_string(), port)) {
            Some(keys) => {
                if keys.iter().any(|k| k == key) {
                    Verdict::Match
                } else {
                    Verdict::Mismatch
                }
            }
            None => Verdict::Unknown,
        }
    }

    /// Appends a new trusted key for `host:port`. Persisted to file.
    pub async fn add(
        &self,
        host: &str,
        port: u16,
        key: ssh_key::PublicKey,
    ) -> Result<(), String> {
        let openssh = key
            .to_openssh()
            .map_err(|e| format!("encode openssh: {e}"))?;

        {
            let mut entries = self.entries.write().unwrap();
            entries
                .entry(HostPort(host.to_string(), port))
                .or_default()
                .push(key);
        }

        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        let line = format!("{}:{} {}\n", host, port, openssh);
        let mut f = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.path)
            .await
            .map_err(|e| format!("open {}: {e}", self.path.display()))?;
        f.write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write known_hosts: {e}"))?;
        Ok(())
    }

    /// Flat snapshot of all entries, one per stored key.
    pub fn list(&self) -> Vec<KnownHostEntry> {
        let entries = self.entries.read().unwrap();
        let mut out = Vec::new();
        for (hp, keys) in entries.iter() {
            for key in keys {
                let openssh = match key.to_openssh() {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                out.push(KnownHostEntry {
                    host: hp.0.clone(),
                    port: hp.1,
                    algorithm: key.algorithm().as_str().to_string(),
                    fingerprint_sha256: fingerprint_sha256(key),
                    openssh,
                });
            }
        }
        out.sort_by(|a, b| a.host.cmp(&b.host).then_with(|| a.port.cmp(&b.port)));
        out
    }

    /// Removes the single key identified by `(host, port, fingerprint)`.
    /// Rewrites the file from the in-memory state. No-op if not found.
    pub async fn remove(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
    ) -> Result<(), String> {
        let snapshot = {
            let mut entries = self.entries.write().unwrap();
            if let Some(keys) = entries.get_mut(&HostPort(host.to_string(), port)) {
                keys.retain(|k| fingerprint_sha256(k) != fingerprint);
                if keys.is_empty() {
                    entries.remove(&HostPort(host.to_string(), port));
                }
            }
            // Clone out a snapshot to rewrite the file without holding
            // the lock across I/O.
            entries
                .iter()
                .flat_map(|(hp, ks)| {
                    ks.iter()
                        .filter_map(|k| k.to_openssh().ok())
                        .map(|s| format!("{}:{} {}\n", hp.0, hp.1, s))
                        .collect::<Vec<_>>()
                })
                .collect::<String>()
        };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        fs::write(&self.path, snapshot)
            .await
            .map_err(|e| format!("rewrite known_hosts: {e}"))?;
        Ok(())
    }
}

fn parse(text: &str) -> HashMap<HostPort, Vec<ssh_key::PublicKey>> {
    let mut map: HashMap<HostPort, Vec<ssh_key::PublicKey>> = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (hp, rest) = match trimmed.split_once(char::is_whitespace) {
            Some(x) => x,
            None => continue,
        };
        let (host, port_str) = match hp.rsplit_once(':') {
            Some(x) => x,
            None => continue,
        };
        let port: u16 = match port_str.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let key = match ssh_key::PublicKey::from_openssh(rest.trim()) {
            Ok(k) => k,
            Err(_) => continue,
        };
        map.entry(HostPort(host.to_string(), port))
            .or_default()
            .push(key);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real ed25519 public key encoded in OpenSSH format. Deterministic —
    /// we're only checking the parser round-trip, not crypto.
    const SAMPLE_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ+dHIrXqP01NMYPPLpbR7C0g1RLz6E8EVC6Rl4LRkHI test@bm";

    fn sample_key() -> ssh_key::PublicKey {
        ssh_key::PublicKey::from_openssh(SAMPLE_KEY).unwrap()
    }

    #[test]
    fn parse_skips_comments_and_blanks() {
        let text = "\n# a comment\n\n  \nexample.com:22 garbage\n";
        let map = parse(text);
        assert!(map.is_empty());
    }

    #[test]
    fn parse_ipv6_host_with_bracketless_form() {
        // `rsplit_once(':')` lets IPv6 colons go to `host` — port is the
        // last colon-delimited segment. Good enough for v1.
        let line = format!("2001:db8::1:22 {}", SAMPLE_KEY);
        let map = parse(&line);
        let v = map.get(&HostPort("2001:db8::1".into(), 22)).unwrap();
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn parse_then_verify_matches_and_mismatches() {
        let line = format!("example.com:22 {}", SAMPLE_KEY);
        let entries = parse(&line);
        let kh = KnownHosts {
            path: PathBuf::from("unused"),
            entries: RwLock::new(entries),
        };
        let k = sample_key();
        assert!(matches!(
            kh.verify("example.com", 22, &k),
            Verdict::Match
        ));
        assert!(matches!(
            kh.verify("example.com", 2222, &k),
            Verdict::Unknown
        ));
        assert!(matches!(
            kh.verify("other.example.com", 22, &k),
            Verdict::Unknown
        ));
    }

    #[test]
    fn verify_mismatch_when_same_host_different_key() {
        // Stored key: zero-bytes dummy. Presented key: real SAMPLE_KEY.
        // Since they differ, Verdict::Mismatch.
        let other_key = ssh_key::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA other",
        )
        .unwrap();
        let mut map = HashMap::new();
        map.insert(
            HostPort("example.com".into(), 22),
            vec![other_key],
        );
        let kh = KnownHosts {
            path: PathBuf::from("unused"),
            entries: RwLock::new(map),
        };
        assert!(matches!(
            kh.verify("example.com", 22, &sample_key()),
            Verdict::Mismatch
        ));
    }
}
