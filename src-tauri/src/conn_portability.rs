//! Export / import de conexões.
//!
//! Formato nativo: `.bmconn` (JSON). Formato importado: `.ncx` do Navicat
//! (XML com Blowfish-ECB nas senhas). A decriptação é best-effort —
//! funciona em exports do Navicat 11/12 com a chave pública; versões
//! novas podem usar chave derivada e falhar (senha vem vazia; usuário
//! re-digita).

use basemaster_core::{SshTunnelConfig, TlsMode};
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
    /// Senha em plaintext (só incluída se usuário optou por exportar com senhas).
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub ssh_key_passphrase: Option<String>,
    /// Nome da pasta (não ID — pra permitir importar em outro app).
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

/// Chave Blowfish-ECB do Navicat (11 e muitos 12.x). Compat com exports
/// comuns. Nav 12.1+ pode derivar chave do user; nesses casos decripta
/// em garbage e a senha vem vazia.
const NAVICAT_KEY: &[u8] = b"3DC5CA39";

/// Decripta senha Navicat: input é HEX; bytes são Blowfish-ECB com
/// a chave acima; padding por null-byte. Retorna None em qualquer falha.
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
        .map(|c| cipher::generic_array::GenericArray::clone_from_slice(c))
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

/// Mapeia Navicat ConnType ao nosso driver id. Só suporta mysql/postgres
/// por enquanto (os outros são ignorados).
fn navicat_driver(conn_type: &str) -> Option<&'static str> {
    match conn_type.to_uppercase().as_str() {
        "MYSQL" | "MARIADB" => Some("mysql"),
        "PGSQL" | "POSTGRESQL" | "POSTGRES" => Some("postgres"),
        _ => None,
    }
}

/// Parse do XML do Navicat. Cada <Connection> vira uma ExportedConnection.
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

// ---------- Parse genérico (detect format) ----------

pub fn parse_file_content(content: &str, filename: &str) -> Result<ExportPayload, String> {
    let name_lower = filename.to_lowercase();
    let trimmed = content.trim_start();
    // Heurística: XML starts com `<?xml` ou `<`. NCX é XML.
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
}
