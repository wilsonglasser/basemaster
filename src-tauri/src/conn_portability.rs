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

// ---------- Generic parse (detect format) ----------

pub fn parse_file_content(content: &str, filename: &str) -> Result<ExportPayload, String> {
    let name_lower = filename.to_lowercase();
    let trimmed = content.trim_start();
    // Heuristic: XML starts with `<?xml` or `<`. NCX is XML.
    let is_xml = trimmed.starts_with("<?xml")
        || trimmed.starts_with('<')
        || name_lower.ends_with(".ncx");

    if is_xml {
        parse_navicat_ncx(content)
    } else {
        serde_json::from_str::<ExportPayload>(content)
            .map_err(|e| format!("JSON inválido: {e}"))
    }
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
        assert!(err.contains("JSON"));
    }
}
