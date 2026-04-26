//! Connection export / import.
//!
//! Native format: `.bmconn` (JSON). Imported format: Navicat `.ncx`
//! (XML with Blowfish-ECB on passwords). Decryption is best-effort —
//! works on Navicat 11/12 exports with the public key; newer versions
//! may use a derived key and fail (password comes empty; user
//! re-types it).

use basemaster_core::{HttpProxyConfig, SshTunnelConfig, TlsMode};
use basemaster_store::secrets;
use cipher::{BlockDecryptMut, KeyInit};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportedFolder {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportedConnection {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub default_database: Option<String>,
    #[serde(default)]
    pub tls: TlsMode,
    /// Plaintext password (only included if the user chose to export with passwords).
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub ssh_key_passphrase: Option<String>,
    #[serde(default)]
    pub ssh_jump_hosts: Vec<SshTunnelConfig>,
    /// JSON-serialized Vec<{password,key_passphrase}> aligned to the
    /// jump hosts above. Only written when the user chose to export
    /// with passwords.
    #[serde(default)]
    pub ssh_jumps_secrets: Option<String>,
    #[serde(default)]
    pub http_proxy: Option<HttpProxyConfig>,
    #[serde(default)]
    pub http_proxy_password: Option<String>,
    /// Folder name (not ID — so it's possible to import into another app).
    #[serde(default)]
    pub folder_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportPayload {
    pub version: u32,
    pub folders: Vec<ExportedFolder>,
    pub connections: Vec<ExportedConnection>,
}

// ---------- Navicat .ncx parsing ----------

/// Navicat's Blowfish-ECB key (11 and many 12.x). Compatible with common
/// exports. Nav 12.1+ may derive the key from the user; in those cases
/// decryption returns garbage and the password ends up empty.
const NAVICAT_KEY: &[u8] = b"3DC5CA39";

/// Decrypts a Navicat password: input is HEX; bytes are Blowfish-ECB with
/// the key above; null-byte padding. Returns None on any failure.
pub fn decrypt_navicat_password(hex_str: &str) -> Option<String> {
    let cipher_bytes = hex::decode(hex_str.trim()).ok()?;
    if cipher_bytes.is_empty() || cipher_bytes.len() % 8 != 0 {
        return None;
    }
    type BfDec = ecb::Decryptor<blowfish::Blowfish>;
    let mut cipher = BfDec::new_from_slice(NAVICAT_KEY).ok()?;

    let mut out = vec![0u8; cipher_bytes.len()];
    let blocks_in = cipher_bytes
        .chunks_exact(8)
        .map(cipher::generic_array::GenericArray::clone_from_slice)
        .collect::<Vec<_>>();
    let mut blocks_out: Vec<cipher::generic_array::GenericArray<u8, cipher::consts::U8>> =
        vec![cipher::generic_array::GenericArray::default(); blocks_in.len()];

    cipher.decrypt_blocks_b2b_mut(&blocks_in, &mut blocks_out).ok()?;

    for (i, b) in blocks_out.iter().enumerate() {
        out[i * 8..(i + 1) * 8].copy_from_slice(b);
    }

    // Strip null-padding.
    while out.last() == Some(&0) {
        out.pop();
    }
    String::from_utf8(out).ok()
}

/// Maps Navicat ConnType to our driver id. Only supports mysql/postgres
/// for now (others are ignored).
fn navicat_driver(conn_type: &str) -> Option<&'static str> {
    match conn_type.to_uppercase().as_str() {
        "MYSQL" | "MARIADB" => Some("mysql"),
        "PGSQL" | "POSTGRESQL" | "POSTGRES" => Some("postgres"),
        _ => None,
    }
}

/// Parses Navicat's XML. Each <Connection> becomes an ExportedConnection.
pub fn parse_navicat_ncx(xml: &str) -> Result<ExportPayload, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut connections: Vec<ExportedConnection> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Err(e) => return Err(format!("xml: {e}")),
            Ok(Event::Eof) => break,
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) if e.name().as_ref() == b"Connection" => {
                let mut name = String::new();
                let mut conn_type = String::new();
                let mut host = String::new();
                let mut port: u16 = 0;
                let mut user = String::new();
                let mut db = String::new();
                let mut password_hex = String::new();

                for attr in e.attributes().flatten() {
                    let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                    let val = attr
                        .unescape_value()
                        .map(|c| c.to_string())
                        .unwrap_or_default();
                    match key.as_str() {
                        "ConnectionName" => name = val,
                        "ConnType" => conn_type = val,
                        "Host" => host = val,
                        "Port" => port = val.parse().unwrap_or(0),
                        "UserName" => user = val,
                        "DatabaseName" => db = val,
                        "Password" => password_hex = val,
                        _ => {}
                    }
                }

                let driver = match navicat_driver(&conn_type) {
                    Some(d) => d,
                    None => {
                        buf.clear();
                        continue;
                    }
                };

                if port == 0 {
                    port = if driver == "postgres" { 5432 } else { 3306 };
                }

                let password = if password_hex.is_empty() {
                    None
                } else {
                    decrypt_navicat_password(&password_hex)
                };

                connections.push(ExportedConnection {
                    name,
                    color: None,
                    driver: driver.to_string(),
                    host,
                    port,
                    user,
                    default_database: if db.is_empty() { None } else { Some(db) },
                    tls: TlsMode::default(),
                    password,
                    ssh_tunnel: None,
                    ssh_password: None,
                    ssh_key_passphrase: None,
                    ssh_jump_hosts: Vec::new(),
                    ssh_jumps_secrets: None,
                    http_proxy: None,
                    http_proxy_password: None,
                    folder_name: None,
                });
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(ExportPayload {
        version: 1,
        folders: Vec::new(),
        connections,
    })
}

// ---------- DBeaver (data-sources.json) ----------

/// DBeaver writes a `data-sources.json` like:
/// ```json
/// {
///   "folders": { "MyFolder": { "description": "..." } },
///   "connections": {
///     "uuid": {
///       "provider": "mysql",
///       "name": "Local",
///       "folder": "MyFolder",
///       "configuration": {
///         "host": "127.0.0.1", "port": "3306",
///         "database": "mydb", "user": "root"
///       }
///     }
///   }
/// }
/// ```
/// Passwords live in a separate `credentials-config.json` encrypted with
/// a fixed AES key — we don't try to decrypt; user re-types.
pub fn parse_dbeaver_data_sources(json: &str) -> Result<ExportPayload, String> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("dbeaver json inválido: {e}"))?;

    let mut folders: Vec<ExportedFolder> = Vec::new();
    if let Some(map) = v.get("folders").and_then(|f| f.as_object()) {
        for k in map.keys() {
            folders.push(ExportedFolder {
                name: k.clone(),
                color: None,
            });
        }
    }

    let connections_obj = v
        .get("connections")
        .and_then(|c| c.as_object())
        .ok_or_else(|| "dbeaver: campo 'connections' ausente".to_string())?;

    let mut out: Vec<ExportedConnection> = Vec::new();
    for (_id, conn) in connections_obj.iter() {
        let provider = conn
            .get("provider")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let driver = match dbeaver_driver(provider) {
            Some(d) => d,
            None => continue,
        };
        let name = conn
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("Imported")
            .to_string();
        let folder_name = conn
            .get("folder")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let cfg = conn.get("configuration").and_then(|x| x.as_object());
        let host = cfg
            .and_then(|m| m.get("host"))
            .and_then(|x| x.as_str())
            .unwrap_or("localhost")
            .to_string();
        let port = cfg
            .and_then(|m| m.get("port"))
            .and_then(|x| x.as_str().map(|s| s.to_string()).or_else(|| x.as_u64().map(|n| n.to_string())))
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or_else(|| default_port_for(driver));
        let user = cfg
            .and_then(|m| m.get("user"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let database = cfg
            .and_then(|m| m.get("database"))
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        out.push(ExportedConnection {
            name,
            color: None,
            driver: driver.to_string(),
            host,
            port,
            user,
            default_database: database,
            tls: TlsMode::default(),
            password: None,
            ssh_tunnel: None,
            ssh_password: None,
            ssh_key_passphrase: None,
            ssh_jump_hosts: Vec::new(),
            ssh_jumps_secrets: None,
            http_proxy: None,
            http_proxy_password: None,
            folder_name,
        });
    }

    Ok(ExportPayload {
        version: 1,
        folders,
        connections: out,
    })
}

fn dbeaver_driver(provider: &str) -> Option<&'static str> {
    match provider.to_lowercase().as_str() {
        "mysql" | "mariadb" | "mariadb-server" => Some("mysql"),
        "postgresql" | "postgres" => Some("postgres"),
        "sqlite" | "generic_sqlite" => Some("sqlite"),
        _ => None,
    }
}

fn default_port_for(driver: &str) -> u16 {
    match driver {
        "postgres" => 5432,
        "sqlite" => 0,
        _ => 3306,
    }
}

// ---------- HeidiSQL (portable_settings.txt) ----------

/// HeidiSQL stores settings under `[Servers\<name>]` sections (INI-like).
/// `Password` is hex of bytes obfuscated with a known descending-shift
/// algorithm (decrypt below). `NetType` indicates the engine.
pub fn parse_heidisql_settings(text: &str) -> Result<ExportPayload, String> {
    let mut current_name: Option<String> = None;
    let mut current_kv: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();
    let mut connections: Vec<ExportedConnection> = Vec::new();

    let flush = |name: Option<String>,
                 kv: &std::collections::BTreeMap<String, String>,
                 connections: &mut Vec<ExportedConnection>| {
        let Some(name) = name else { return };
        let Some(driver) = kv
            .get("NetType")
            .and_then(|v| v.parse::<u32>().ok())
            .and_then(heidisql_driver)
        else {
            return;
        };
        let host = kv
            .get("Host")
            .cloned()
            .unwrap_or_else(|| "localhost".into());
        let port = kv
            .get("Port")
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or_else(|| default_port_for(driver));
        let user = kv.get("User").cloned().unwrap_or_default();
        let password = kv
            .get("Password")
            .filter(|s| !s.is_empty())
            .and_then(|s| decrypt_heidisql_password(s));
        let db = kv
            .get("Databases")
            .or_else(|| kv.get("Database"))
            .cloned()
            .filter(|s| !s.is_empty());

        connections.push(ExportedConnection {
            name,
            color: None,
            driver: driver.to_string(),
            host,
            port,
            user,
            default_database: db,
            tls: TlsMode::default(),
            password,
            ssh_tunnel: None,
            ssh_password: None,
            ssh_key_passphrase: None,
            ssh_jump_hosts: Vec::new(),
            ssh_jumps_secrets: None,
            http_proxy: None,
            http_proxy_password: None,
            folder_name: None,
        });
    };

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            // New section — flush previous if it was a Servers entry.
            flush(current_name.take(), &current_kv, &mut connections);
            current_kv.clear();
            // Match `Servers\<name>` or `Servers\<name>\Subsection`.
            let parts: Vec<&str> = rest.split('\\').collect();
            if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("Servers") {
                current_name = Some(parts[1].to_string());
            } else {
                current_name = None;
            }
            continue;
        }
        if current_name.is_some() {
            if let Some((k, v)) = line.split_once('=') {
                current_kv.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    flush(current_name, &current_kv, &mut connections);

    Ok(ExportPayload {
        version: 1,
        folders: Vec::new(),
        connections,
    })
}

/// HeidiSQL NetType → driver. Keep only what we support.
/// 0=MySQL TCP/IP · 1=MySQL Named Pipe · 2=MySQL SSH tunnel ·
/// 3=MariaDB · 5=MS SQL · 6=PostgreSQL · 14=SQLite · 17/18/19 newer engines.
fn heidisql_driver(net_type: u32) -> Option<&'static str> {
    match net_type {
        0 | 1 | 2 | 4 => Some("mysql"),
        3 => Some("mysql"), // MariaDB shares our MySQL driver
        6..=8 => Some("postgres"),
        14 => Some("sqlite"),
        _ => None,
    }
}

/// Reverses HeidiSQL's `encrypt`: hex-decode each pair, then subtract a
/// descending shift starting at the byte count. Each output byte is
/// `hex_byte - shift` (wrapping on underflow). Shift decrements per byte.
pub fn decrypt_heidisql_password(hex_str: &str) -> Option<String> {
    let bytes = hex::decode(hex_str.trim()).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let mut shift = bytes.len() as u8;
    let mut out = Vec::with_capacity(bytes.len());
    for b in &bytes {
        out.push(b.wrapping_sub(shift));
        shift = shift.wrapping_sub(1);
    }
    String::from_utf8(out).ok()
}

// ---------- DataGrip (dataSources.xml) ----------

/// DataGrip / IntelliJ stores connections in `dataSources.xml`. Passwords
/// live in `dataSources.local.xml` or in the IDE keyring — we don't try
/// to decrypt; user re-types. Driver and host come from `<jdbc-url>`.
pub fn parse_datagrip_xml(xml: &str) -> Result<ExportPayload, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut connections: Vec<ExportedConnection> = Vec::new();

    // Per-data-source running state.
    let mut in_data_source = false;
    let mut current_name = String::new();
    let mut current_url = String::new();
    let mut current_user = String::new();
    let mut current_driver_ref = String::new();
    let mut current_tag: Option<Vec<u8>> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Err(e) => return Err(format!("xml: {e}")),
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                if e.name().as_ref() == b"data-source" {
                    in_data_source = true;
                    current_name.clear();
                    current_url.clear();
                    current_user.clear();
                    current_driver_ref.clear();
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"name" {
                            current_name = attr
                                .unescape_value()
                                .map(|c| c.to_string())
                                .unwrap_or_default();
                        }
                    }
                } else if in_data_source {
                    current_tag = Some(e.name().as_ref().to_vec());
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(tag) = &current_tag {
                    let txt = e.unescape().map(|c| c.to_string()).unwrap_or_default();
                    match tag.as_slice() {
                        b"jdbc-url" => current_url = txt,
                        b"user-name" => current_user = txt,
                        b"driver-ref" => current_driver_ref = txt,
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                if e.name().as_ref() == b"data-source" {
                    if let Some(parsed) =
                        datagrip_to_connection(&current_name, &current_url, &current_user, &current_driver_ref)
                    {
                        connections.push(parsed);
                    }
                    in_data_source = false;
                    current_tag = None;
                } else if in_data_source {
                    current_tag = None;
                }
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(ExportPayload {
        version: 1,
        folders: Vec::new(),
        connections,
    })
}

fn datagrip_to_connection(
    name: &str,
    jdbc_url: &str,
    user: &str,
    driver_ref: &str,
) -> Option<ExportedConnection> {
    let driver = datagrip_driver(jdbc_url, driver_ref)?;
    let (host, port, database) = parse_jdbc_url(jdbc_url, driver);
    Some(ExportedConnection {
        name: name.to_string(),
        color: None,
        driver: driver.to_string(),
        host,
        port,
        user: user.to_string(),
        default_database: database,
        tls: TlsMode::default(),
        password: None,
        ssh_tunnel: None,
        ssh_password: None,
        ssh_key_passphrase: None,
        ssh_jump_hosts: Vec::new(),
        ssh_jumps_secrets: None,
        http_proxy: None,
        http_proxy_password: None,
        folder_name: None,
    })
}

fn datagrip_driver(jdbc_url: &str, driver_ref: &str) -> Option<&'static str> {
    let url = jdbc_url.to_lowercase();
    let dref = driver_ref.to_lowercase();
    if url.starts_with("jdbc:mysql") || url.starts_with("jdbc:mariadb") || dref.contains("mysql") || dref.contains("mariadb") {
        return Some("mysql");
    }
    if url.starts_with("jdbc:postgresql") || dref.contains("postgres") {
        return Some("postgres");
    }
    if url.starts_with("jdbc:sqlite") || dref.contains("sqlite") {
        return Some("sqlite");
    }
    None
}

/// Extracts host/port/database from a JDBC URL like
/// `jdbc:mysql://host:port/db?params` or `jdbc:postgresql://host/db`.
fn parse_jdbc_url(url: &str, driver: &str) -> (String, u16, Option<String>) {
    let default_port = default_port_for(driver);
    // Strip jdbc:<engine>:// prefix.
    let after_scheme = match url.find("://") {
        Some(i) => &url[i + 3..],
        None => return ("localhost".into(), default_port, None),
    };
    // <host[:port]>/<db>[?params]
    let (authority, rest) = match after_scheme.find('/') {
        Some(i) => (&after_scheme[..i], &after_scheme[i + 1..]),
        None => (after_scheme, ""),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(default_port)),
        None => (authority.to_string(), default_port),
    };
    let db_part = rest.split(['?', ';']).next().unwrap_or("");
    let database = if db_part.is_empty() {
        None
    } else {
        Some(db_part.to_string())
    };
    (host, port, database)
}

// ---------- Generic parse (detect format) ----------

pub fn parse_file_content(content: &str, filename: &str) -> Result<ExportPayload, String> {
    let name_lower = filename.to_lowercase();
    let trimmed = content.trim_start();

    // HeidiSQL portable_settings.txt — INI-like with `[Servers\name]`.
    if name_lower.ends_with("portable_settings.txt")
        || (trimmed.starts_with('[') && content.contains("[Servers\\"))
    {
        return parse_heidisql_settings(content);
    }

    // XML: DataGrip first (DataSourceManagerImpl marker), then Navicat.
    let is_xml = trimmed.starts_with("<?xml")
        || trimmed.starts_with('<')
        || name_lower.ends_with(".ncx")
        || name_lower.ends_with("datasources.xml");
    if is_xml {
        if content.contains("DataSourceManagerImpl") || content.contains("<data-source ")
        {
            return parse_datagrip_xml(content);
        }
        return parse_navicat_ncx(content);
    }

    // JSON: DBeaver if it has the connection-typed structure, else our own.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(content) {
        let looks_like_dbeaver = v
            .get("connections")
            .and_then(|c| c.as_object())
            .map(|m| {
                m.values().any(|conn| {
                    conn.get("provider").is_some() || conn.get("configuration").is_some()
                })
            })
            .unwrap_or(false);
        if looks_like_dbeaver {
            return parse_dbeaver_data_sources(content);
        }
        return serde_json::from_value::<ExportPayload>(v)
            .map_err(|e| format!("JSON inválido: {e}"));
    }
    Err("formato não reconhecido (esperado .bmconn, .ncx, dbeaver data-sources.json, datagrip dataSources.xml ou heidisql portable_settings.txt)".into())
}

// ---------- Export helpers ----------

pub fn load_secrets_into(
    conn: &mut ExportedConnection,
    connection_id: uuid::Uuid,
) {
    if let Ok(Some(pw)) = secrets::get_password(connection_id) {
        conn.password = Some(pw);
    }
    if let Ok(Some(pw)) = secrets::get_ssh_password(connection_id) {
        conn.ssh_password = Some(pw);
    }
    if let Ok(Some(pp)) = secrets::get_ssh_key_passphrase(connection_id) {
        conn.ssh_key_passphrase = Some(pp);
    }
    if let Ok(Some(blob)) = secrets::get_ssh_jumps_secrets(connection_id) {
        conn.ssh_jumps_secrets = Some(blob);
    }
    if let Ok(Some(pp)) = secrets::get_http_proxy_password(connection_id) {
        conn.http_proxy_password = Some(pp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cipher::BlockEncryptMut;

    /// Encrypts a plaintext with Blowfish-ECB and the Navicat key, returning
    /// ASCII hex (format expected by the parser). Used only to generate
    /// fixtures — the product decrypts, never encrypts.
    fn encrypt_with_navicat_key(plain: &str) -> String {
        type BfEnc = ecb::Encryptor<blowfish::Blowfish>;
        let mut cipher = BfEnc::new_from_slice(NAVICAT_KEY).unwrap();
        // Null-pad to a multiple of 8 bytes.
        let mut bytes = plain.as_bytes().to_vec();
        while !bytes.len().is_multiple_of(8) {
            bytes.push(0);
        }
        let blocks_in = bytes
            .chunks_exact(8)
            .map(cipher::generic_array::GenericArray::clone_from_slice)
            .collect::<Vec<_>>();
        let mut blocks_out: Vec<cipher::generic_array::GenericArray<u8, cipher::consts::U8>> =
            vec![cipher::generic_array::GenericArray::default(); blocks_in.len()];
        cipher
            .encrypt_blocks_b2b_mut(&blocks_in, &mut blocks_out)
            .unwrap();
        let mut out = Vec::with_capacity(bytes.len());
        for b in &blocks_out {
            out.extend_from_slice(b);
        }
        hex::encode_upper(out)
    }

    #[test]
    fn decrypt_rejects_non_hex() {
        assert!(decrypt_navicat_password("zzz not hex zzz").is_none());
    }

    #[test]
    fn decrypt_rejects_wrong_block_size() {
        // 7 hex bytes = 14 chars, but Blowfish needs a multiple of 8 bytes.
        let hex = "AABBCCDDEEFF11"; // 7 bytes
        assert!(decrypt_navicat_password(hex).is_none());
    }

    #[test]
    fn decrypt_roundtrip_short_password() {
        let hex = encrypt_with_navicat_key("hunter2");
        assert_eq!(decrypt_navicat_password(&hex).as_deref(), Some("hunter2"));
    }

    #[test]
    fn decrypt_roundtrip_empty_string() {
        // Empty plaintext doesn't go through the real path (password_hex.is_empty()
        // before the call), but make sure an empty cipher returns None.
        assert!(decrypt_navicat_password("").is_none());
    }

    #[test]
    fn decrypt_trims_whitespace() {
        let hex = encrypt_with_navicat_key("pg-secret");
        let padded = format!("  {hex}\n");
        assert_eq!(
            decrypt_navicat_password(&padded).as_deref(),
            Some("pg-secret")
        );
    }

    #[test]
    fn parse_empty_xml_returns_no_connections() {
        let r = parse_navicat_ncx("<?xml version=\"1.0\"?><Connections/>").unwrap();
        assert_eq!(r.version, 1);
        assert!(r.connections.is_empty());
    }

    #[test]
    fn parse_mysql_connection_with_password() {
        let pw_hex = encrypt_with_navicat_key("s3cret");
        let xml = format!(
            r#"<?xml version="1.0"?>
            <Connections>
              <Connection ConnectionName="prod-db"
                          ConnType="MYSQL"
                          Host="db.example.com"
                          Port="3307"
                          UserName="admin"
                          DatabaseName="shop"
                          Password="{pw_hex}"/>
            </Connections>"#
        );
        let r = parse_navicat_ncx(&xml).unwrap();
        assert_eq!(r.connections.len(), 1);
        let c = &r.connections[0];
        assert_eq!(c.name, "prod-db");
        assert_eq!(c.driver, "mysql");
        assert_eq!(c.host, "db.example.com");
        assert_eq!(c.port, 3307);
        assert_eq!(c.user, "admin");
        assert_eq!(c.default_database.as_deref(), Some("shop"));
        assert_eq!(c.password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn parse_postgres_default_port() {
        let xml = r#"<?xml version="1.0"?>
            <Connections>
              <Connection ConnectionName="pg" ConnType="PGSQL"
                          Host="localhost" UserName="postgres"/>
            </Connections>"#;
        let r = parse_navicat_ncx(xml).unwrap();
        assert_eq!(r.connections.len(), 1);
        assert_eq!(r.connections[0].driver, "postgres");
        assert_eq!(r.connections[0].port, 5432);
    }

    #[test]
    fn parse_mysql_default_port() {
        let xml = r#"<?xml version="1.0"?>
            <Connections>
              <Connection ConnectionName="m" ConnType="MARIADB"
                          Host="localhost" UserName="root"/>
            </Connections>"#;
        let r = parse_navicat_ncx(xml).unwrap();
        assert_eq!(r.connections.len(), 1);
        assert_eq!(r.connections[0].driver, "mysql");
        assert_eq!(r.connections[0].port, 3306);
    }

    #[test]
    fn parse_skips_unsupported_drivers() {
        let xml = r#"<?xml version="1.0"?>
            <Connections>
              <Connection ConnectionName="oracle-thing" ConnType="ORACLE"
                          Host="x" UserName="y"/>
              <Connection ConnectionName="good" ConnType="MYSQL"
                          Host="h" UserName="u"/>
            </Connections>"#;
        let r = parse_navicat_ncx(xml).unwrap();
        assert_eq!(r.connections.len(), 1);
        assert_eq!(r.connections[0].name, "good");
    }

    #[test]
    fn parse_bad_password_hex_keeps_connection_without_password() {
        let xml = r#"<?xml version="1.0"?>
            <Connections>
              <Connection ConnectionName="c" ConnType="MYSQL" Host="h"
                          UserName="u" Password="not-a-valid-hex-string"/>
            </Connections>"#;
        let r = parse_navicat_ncx(xml).unwrap();
        assert_eq!(r.connections.len(), 1);
        assert!(r.connections[0].password.is_none());
    }

    #[test]
    fn parse_file_content_detects_xml_by_content() {
        let xml = "<?xml version=\"1.0\"?><Connections/>";
        let r = parse_file_content(xml, "whatever.txt").unwrap();
        assert!(r.connections.is_empty());
    }

    #[test]
    fn parse_file_content_detects_xml_by_extension() {
        let r = parse_file_content("<Connections/>", "export.ncx").unwrap();
        assert!(r.connections.is_empty());
    }

    #[test]
    fn parse_file_content_detects_json() {
        let json = r#"{"version":1,"folders":[],"connections":[]}"#;
        let r = parse_file_content(json, "export.bmconn").unwrap();
        assert_eq!(r.version, 1);
    }

    #[test]
    fn parse_file_content_rejects_invalid_json() {
        let err = parse_file_content("{not json", "export.bmconn").unwrap_err();
        // After multi-format detection, garbage input falls through to the
        // generic "format not recognized" error.
        assert!(err.contains("formato"));
    }

    // ---------- DBeaver tests ----------

    #[test]
    fn dbeaver_parses_connections_and_folders() {
        let json = r#"{
            "folders": { "Prod": {}, "Local": {} },
            "connections": {
                "abc-1": {
                    "provider": "mysql",
                    "name": "Local MySQL",
                    "folder": "Local",
                    "configuration": {
                        "host": "127.0.0.1",
                        "port": "3306",
                        "database": "shop",
                        "user": "root"
                    }
                },
                "abc-2": {
                    "provider": "postgresql",
                    "name": "PG warehouse",
                    "configuration": {
                        "host": "warehouse.example.com",
                        "port": "5433",
                        "database": "wh",
                        "user": "ro"
                    }
                }
            }
        }"#;
        let r = parse_dbeaver_data_sources(json).unwrap();
        assert_eq!(r.folders.len(), 2);
        assert_eq!(r.connections.len(), 2);
        let mysql = r.connections.iter().find(|c| c.driver == "mysql").unwrap();
        assert_eq!(mysql.name, "Local MySQL");
        assert_eq!(mysql.host, "127.0.0.1");
        assert_eq!(mysql.port, 3306);
        assert_eq!(mysql.user, "root");
        assert_eq!(mysql.default_database.as_deref(), Some("shop"));
        assert_eq!(mysql.folder_name.as_deref(), Some("Local"));
        let pg = r.connections.iter().find(|c| c.driver == "postgres").unwrap();
        assert_eq!(pg.port, 5433);
    }

    #[test]
    fn dbeaver_skips_unknown_providers() {
        let json = r#"{
            "connections": {
                "x": { "provider": "oracle", "name": "ora",
                       "configuration": { "host": "h", "port": "1521", "user": "u" } }
            }
        }"#;
        let r = parse_dbeaver_data_sources(json).unwrap();
        assert!(r.connections.is_empty());
    }

    #[test]
    fn parse_file_content_detects_dbeaver_json() {
        let json = r#"{
            "connections": {
                "x": { "provider": "mysql", "name": "h",
                       "configuration": { "host": "h", "port": "3306", "user": "u" } }
            }
        }"#;
        let r = parse_file_content(json, "data-sources.json").unwrap();
        assert_eq!(r.connections.len(), 1);
        assert_eq!(r.connections[0].driver, "mysql");
    }

    // ---------- HeidiSQL tests ----------

    /// Mirror of HeidiSQL's `encrypt`: each char becomes hex(byte + shift),
    /// shift starts at length and decrements per byte. Used only for
    /// fixtures.
    fn encrypt_with_heidisql_algo(plain: &str) -> String {
        let bytes = plain.as_bytes();
        let mut shift = bytes.len() as u8;
        let mut out = Vec::with_capacity(bytes.len());
        for b in bytes {
            out.push(b.wrapping_add(shift));
            shift = shift.wrapping_sub(1);
        }
        hex::encode_upper(out)
    }

    #[test]
    fn heidisql_password_roundtrip() {
        let cipher = encrypt_with_heidisql_algo("hunter2");
        assert_eq!(
            decrypt_heidisql_password(&cipher).as_deref(),
            Some("hunter2")
        );
    }

    #[test]
    fn heidisql_decrypt_rejects_non_hex() {
        assert!(decrypt_heidisql_password("zzz").is_none());
    }

    #[test]
    fn heidisql_parses_servers_section() {
        let cipher = encrypt_with_heidisql_algo("s3cret");
        let txt = format!(
            "[Servers\\Local MySQL]\n\
             Host=127.0.0.1\n\
             Port=3306\n\
             User=root\n\
             Password={cipher}\n\
             NetType=0\n\
             Databases=shop\n\
             [Servers\\PG]\n\
             Host=pg.example.com\n\
             Port=5432\n\
             User=ro\n\
             NetType=6\n",
        );
        let r = parse_heidisql_settings(&txt).unwrap();
        assert_eq!(r.connections.len(), 2);
        let mysql = &r.connections[0];
        assert_eq!(mysql.name, "Local MySQL");
        assert_eq!(mysql.driver, "mysql");
        assert_eq!(mysql.port, 3306);
        assert_eq!(mysql.password.as_deref(), Some("s3cret"));
        assert_eq!(mysql.default_database.as_deref(), Some("shop"));
        let pg = &r.connections[1];
        assert_eq!(pg.driver, "postgres");
        assert_eq!(pg.port, 5432);
        assert!(pg.password.is_none());
    }

    #[test]
    fn heidisql_skips_unsupported_engines() {
        // NetType=5 is MS SQL — we don't support it.
        let txt = "[Servers\\MSSQL]\nHost=h\nUser=u\nNetType=5\n";
        let r = parse_heidisql_settings(txt).unwrap();
        assert!(r.connections.is_empty());
    }

    #[test]
    fn parse_file_content_detects_heidisql_by_content() {
        let txt = "[Servers\\Local]\nHost=h\nUser=u\nNetType=0\nPort=3306\n";
        let r = parse_file_content(txt, "any.txt").unwrap();
        assert_eq!(r.connections.len(), 1);
        assert_eq!(r.connections[0].driver, "mysql");
    }

    // ---------- DataGrip tests ----------

    #[test]
    fn datagrip_parses_mysql_data_source() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <project version="4">
          <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
            <data-source source="LOCAL" name="Local MySQL" uuid="abc">
              <driver-ref>mysql.8</driver-ref>
              <jdbc-driver>com.mysql.cj.jdbc.Driver</jdbc-driver>
              <jdbc-url>jdbc:mysql://127.0.0.1:3307/shop?useSSL=false</jdbc-url>
              <user-name>root</user-name>
            </data-source>
            <data-source source="LOCAL" name="PG" uuid="def">
              <driver-ref>postgresql</driver-ref>
              <jdbc-url>jdbc:postgresql://pg.example.com/wh</jdbc-url>
              <user-name>ro</user-name>
            </data-source>
          </component>
        </project>"#;
        let r = parse_datagrip_xml(xml).unwrap();
        assert_eq!(r.connections.len(), 2);
        let mysql = &r.connections[0];
        assert_eq!(mysql.name, "Local MySQL");
        assert_eq!(mysql.driver, "mysql");
        assert_eq!(mysql.host, "127.0.0.1");
        assert_eq!(mysql.port, 3307);
        assert_eq!(mysql.user, "root");
        assert_eq!(mysql.default_database.as_deref(), Some("shop"));
        let pg = &r.connections[1];
        assert_eq!(pg.driver, "postgres");
        assert_eq!(pg.host, "pg.example.com");
        assert_eq!(pg.port, 5432); // default
        assert_eq!(pg.default_database.as_deref(), Some("wh"));
    }

    #[test]
    fn datagrip_skips_unsupported_jdbc_drivers() {
        let xml = r#"<?xml version="1.0"?>
        <project version="4">
          <component name="DataSourceManagerImpl">
            <data-source name="Oracle">
              <jdbc-url>jdbc:oracle:thin:@host:1521:db</jdbc-url>
            </data-source>
          </component>
        </project>"#;
        let r = parse_datagrip_xml(xml).unwrap();
        assert!(r.connections.is_empty());
    }

    #[test]
    fn parse_file_content_detects_datagrip_xml() {
        let xml = r#"<?xml version="1.0"?>
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="m">
              <jdbc-url>jdbc:mysql://h:3306/d</jdbc-url>
              <user-name>u</user-name>
            </data-source>
          </component>
        </project>"#;
        let r = parse_file_content(xml, "dataSources.xml").unwrap();
        assert_eq!(r.connections.len(), 1);
        assert_eq!(r.connections[0].driver, "mysql");
    }
}
