//! Real end-to-end: seed a SQLite DB, dump it to `.bmbak`, restore into a
//! second DB through the actual `SqliteDriver`, and verify the rows survive.
//! Uses no external infra (SQLite is embedded), so it runs in CI like a unit
//! test but exercises the genuine driver path the GUI/CLI use.

use std::io::Cursor;
use std::sync::atomic::AtomicBool;

use basemaster_backup::container::BmbakReader;
use basemaster_backup::dump::{dump_tables_to_bmbak, DumpToBmbakOptions, NoProgress};
use basemaster_backup::restore::{restore_from_bmbak, NoProgress as RNoProgress, RestoreOptions};
use basemaster_core::connection::{ConnectionConfig, TlsMode};
use basemaster_core::value::Value;
use basemaster_core::Driver;
use basemaster_driver_sqlite::SqliteDriver;

fn cfg(path: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: uuid_nil(),
        name: "e2e".into(),
        color: None,
        host: path.into(),
        port: 0,
        user: String::new(),
        password: None,
        default_database: Some(path.into()),
        tls: TlsMode::Preferred,
        ssh_tunnel: None,
        ssh_jump_hosts: vec![],
        http_proxy: None,
        ssm_tunnel: None,
    }
}

fn uuid_nil() -> uuid::Uuid {
    // backup crate doesn't depend on uuid directly; build a nil via core's config default path.
    // Simpler: parse the canonical nil string.
    "00000000-0000-0000-0000-000000000000".parse().unwrap()
}

fn fresh_db(name: &str) -> String {
    let p = std::env::temp_dir().join(name);
    let _ = std::fs::remove_file(&p);
    // An empty file is a valid empty SQLite database.
    std::fs::File::create(&p).unwrap();
    p.to_string_lossy().to_string()
}

#[tokio::test]
async fn sqlite_dump_restore_roundtrip() {
    let src_path = fresh_db("bm_e2e_src.db");
    let dst_path = fresh_db("bm_e2e_dst.db");

    // --- seed source ---
    let src = SqliteDriver::new();
    src.connect(&cfg(&src_path)).await.expect("connect src");
    src.execute(
        Some("main"),
        "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, val REAL)",
    )
    .await
    .expect("create");
    src.execute(
        Some("main"),
        "INSERT INTO t (id, name, val) VALUES (1,'alice',1.5),(2,'bob',2.5),(3,NULL,3.0)",
    )
    .await
    .expect("insert");

    // --- dump to .bmbak in memory ---
    let opts = DumpToBmbakOptions {
        created_at: "2026-06-01T00:00:00Z".into(),
        app_version: "test".into(),
        level: 5,
        chunk_size: 2, // force multiple blocks
    };
    let bytes = dump_tables_to_bmbak(
        &src,
        "main",
        &["t".to_string()],
        &opts,
        Cursor::new(Vec::new()),
        &NoProgress,
        None::<&AtomicBool>,
    )
    .await
    .expect("dump")
    .into_inner();
    let _ = src.disconnect().await;

    // --- restore into a fresh DB ---
    let dst = SqliteDriver::new();
    dst.connect(&cfg(&dst_path)).await.expect("connect dst");
    let mut reader = BmbakReader::open(Cursor::new(bytes)).expect("open bmbak");
    let stats = restore_from_bmbak(
        &dst,
        &mut reader,
        &RestoreOptions::default(),
        &RNoProgress,
        None::<&AtomicBool>,
    )
    .await
    .expect("restore");
    assert_eq!(stats.tables, 1);
    assert_eq!(stats.rows, 3);

    // --- verify ---
    let q = dst
        .query(Some("main"), "SELECT id, name, val FROM t ORDER BY id")
        .await
        .expect("verify select");
    assert_eq!(q.rows.len(), 3);
    assert_eq!(q.rows[0][0], Value::Int(1));
    assert_eq!(q.rows[0][1], Value::String("alice".into()));
    assert_eq!(q.rows[2][1], Value::Null);
    // val column survived as a real
    match &q.rows[1][2] {
        Value::Float(f) => assert!((f - 2.5).abs() < 1e-9),
        other => panic!("expected float, got {other:?}"),
    }

    let _ = dst.disconnect().await;
    let _ = std::fs::remove_file(&src_path);
    let _ = std::fs::remove_file(&dst_path);
}
