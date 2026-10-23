//! Views, routines and triggers of a schema, read inside the dump snapshot
//! and recreated by restore after every table. Dialect SQL lives here (like
//! the trigger copy in the GUI transfer) rather than on the `Driver` trait.

use anyhow::{anyhow, bail, Result};
use basemaster_core::{Driver, Snapshot, Value};

use crate::container::{ObjectEntry, ObjectKind};
use crate::sql_export::{value_to_sql, Dialect};

async fn scan_all(snapshot: &Snapshot, sql: &str) -> Result<Vec<Vec<Value>>> {
    let mut rx = snapshot.scan(sql, 256).await.map_err(|e| anyhow!("{e}"))?;
    let mut out = Vec::new();
    while let Some(chunk) = rx.recv().await {
        out.extend(chunk.map_err(|e| anyhow!("{sql}: {e}"))?);
    }
    Ok(out)
}

/// `SHOW CREATE` / catalog text columns come back as bytes on some servers
/// (`_bin` collations).
fn text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Bytes(b) => String::from_utf8(b.clone()).ok(),
        _ => None,
    }
}

fn lit(s: &str, dialect: Dialect) -> String {
    value_to_sql(&Value::String(s.to_string()), false, dialect)
}

pub async fn collect_objects(
    driver: &dyn Driver,
    snapshot: &Snapshot,
    schema: &str,
) -> Result<Vec<ObjectEntry>> {
    match Dialect::parse(driver.dialect()) {
        Some(Dialect::Mysql) => mysql(driver, snapshot, schema).await,
        Some(Dialect::Postgres) => postgres(driver, snapshot, schema).await,
        Some(Dialect::Sqlite) => sqlite(snapshot).await,
        None => Ok(Vec::new()),
    }
}

fn entry(schema: &str, kind: ObjectKind, name: String, table: Option<String>, ddl: String) -> ObjectEntry {
    ObjectEntry {
        schema: Some(schema.to_string()),
        kind,
        name,
        table,
        ddl,
    }
}

async fn mysql(driver: &dyn Driver, snapshot: &Snapshot, schema: &str) -> Result<Vec<ObjectEntry>> {
    let s = lit(schema, Dialect::Mysql);
    let q = |name: &str| format!("{}.{}", driver.quote_ident(schema), driver.quote_ident(name));
    let mut out = Vec::new();

    let routines = scan_all(
        snapshot,
        &format!(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = {s} ORDER BY ROUTINE_NAME"
        ),
    )
    .await?;
    for r in routines {
        let name = text(r.first()).unwrap_or_default();
        let (kind, word) = match text(r.get(1)).as_deref() {
            Some("PROCEDURE") => (ObjectKind::Procedure, "PROCEDURE"),
            _ => (ObjectKind::Function, "FUNCTION"),
        };
        let rows = scan_all(snapshot, &format!("SHOW CREATE {word} {}", q(&name))).await?;
        // The body column is NULL when the user may list the routine but not
        // read it; a backup without it would silently lose the routine.
        let Some(ddl) = rows.first().and_then(|r| text(r.get(2))) else {
            bail!(
                "no access to the body of {word} {schema}.{name} \
                 (needs SHOW_ROUTINE or being its definer)"
            );
        };
        out.push(entry(schema, kind, name, None, ddl));
    }

    let views = scan_all(
        snapshot,
        &format!(
            "SELECT TABLE_NAME FROM information_schema.VIEWS \
             WHERE TABLE_SCHEMA = {s} ORDER BY TABLE_NAME"
        ),
    )
    .await?;
    for r in views {
        let name = text(r.first()).unwrap_or_default();
        let rows = scan_all(snapshot, &format!("SHOW CREATE VIEW {}", q(&name))).await?;
        let ddl = rows
            .first()
            .and_then(|r| text(r.get(1)))
            .ok_or_else(|| anyhow!("no definition for view {schema}.{name}"))?;
        out.push(entry(schema, ObjectKind::View, name, None, ddl));
    }
    order_mysql_views(&mut out, &|n: &str| driver.quote_ident(n));

    let triggers = scan_all(
        snapshot,
        &format!(
            "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS \
             WHERE TRIGGER_SCHEMA = {s} ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER"
        ),
    )
    .await?;
    for r in triggers {
        let name = text(r.first()).unwrap_or_default();
        let table = text(r.get(1));
        let rows = scan_all(snapshot, &format!("SHOW CREATE TRIGGER {}", q(&name))).await?;
        let ddl = rows
            .first()
            .and_then(|r| text(r.get(2)))
            .ok_or_else(|| anyhow!("no definition for trigger {schema}.{name}"))?;
        out.push(entry(schema, ObjectKind::Trigger, name, table, ddl));
    }
    Ok(out)
}

/// Views that read other views go after them, so a `.sql` script (no retry)
/// creates them in a working order. `SHOW CREATE VIEW` backquotes every
/// reference, so a view reads another when its text holds `` `name` ``; a
/// column of the same name gives a false edge, which at worst falls back to
/// name order.
fn order_mysql_views(objects: &mut Vec<ObjectEntry>, q: &dyn Fn(&str) -> String) {
    let first = objects.iter().position(|o| o.kind == ObjectKind::View).unwrap_or(objects.len());
    let views: Vec<ObjectEntry> = objects.drain(first..).collect();
    let refs: Vec<String> = views.iter().map(|v| q(&v.name)).collect();
    let mut ordered: Vec<ObjectEntry> = Vec::with_capacity(views.len());
    let mut placed = vec![false; views.len()];
    while ordered.len() < views.len() {
        let before = ordered.len();
        for i in 0..views.len() {
            let ready = !placed[i]
                && (0..views.len()).all(|j| j == i || placed[j] || !views[i].ddl.contains(&refs[j]));
            if ready {
                placed[i] = true;
                ordered.push(views[i].clone());
            }
        }
        if ordered.len() == before {
            ordered.extend((0..views.len()).filter(|&i| !placed[i]).map(|i| views[i].clone()));
            break;
        }
    }
    objects.extend(ordered);
}

async fn postgres(driver: &dyn Driver, snapshot: &Snapshot, schema: &str) -> Result<Vec<ObjectEntry>> {
    let s = lit(schema, Dialect::Postgres);
    let q = |name: &str| format!("{}.{}", driver.quote_ident(schema), driver.quote_ident(name));
    let mut out = Vec::new();

    // Extension-owned objects come back with CREATE EXTENSION, and aggregates
    // have no pg_get_functiondef.
    let routines = scan_all(
        snapshot,
        &format!(
            "SELECT p.proname::text, p.prokind::text, pg_get_functiondef(p.oid) \
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
              WHERE n.nspname = {s} AND p.prokind IN ('f', 'p') \
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') \
              ORDER BY p.oid"
        ),
    )
    .await?;
    for r in routines {
        let kind = match text(r.get(1)).as_deref() {
            Some("p") => ObjectKind::Procedure,
            _ => ObjectKind::Function,
        };
        let name = text(r.first()).unwrap_or_default();
        out.push(entry(schema, kind, name, None, text(r.get(2)).unwrap_or_default()));
    }

    // Creation order (oid) puts views that read other views after them.
    let views = scan_all(
        snapshot,
        &format!(
            "SELECT c.relname::text, c.relkind::text, pg_get_viewdef(c.oid) \
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = {s} AND c.relkind IN ('v', 'm') \
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') \
              ORDER BY c.oid"
        ),
    )
    .await?;
    for r in views {
        let name = text(r.first()).unwrap_or_default();
        let def = text(r.get(2)).unwrap_or_default();
        let def = def.trim().trim_end_matches(';');
        let (kind, word) = match text(r.get(1)).as_deref() {
            Some("m") => (ObjectKind::MaterializedView, "MATERIALIZED VIEW"),
            _ => (ObjectKind::View, "VIEW"),
        };
        let ddl = format!("CREATE {word} {} AS\n{def}", q(&name));
        out.push(entry(schema, kind, name, None, ddl));
    }

    let triggers = scan_all(
        snapshot,
        &format!(
            "SELECT t.tgname::text, c.relname::text, pg_get_triggerdef(t.oid) \
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = {s} AND NOT t.tgisinternal \
              ORDER BY c.relname, t.tgname"
        ),
    )
    .await?;
    for r in triggers {
        let name = text(r.first()).unwrap_or_default();
        out.push(entry(schema, ObjectKind::Trigger, name, text(r.get(1)), text(r.get(2)).unwrap_or_default()));
    }
    Ok(out)
}

async fn sqlite(snapshot: &Snapshot) -> Result<Vec<ObjectEntry>> {
    // rowid order = creation order, so dependencies come first.
    let rows = scan_all(
        snapshot,
        "SELECT type, name, tbl_name, sql FROM sqlite_master \
         WHERE type IN ('view', 'trigger') AND sql IS NOT NULL ORDER BY rowid",
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let trigger = text(r.first()).as_deref() == Some("trigger");
            ObjectEntry {
                schema: None,
                kind: if trigger { ObjectKind::Trigger } else { ObjectKind::View },
                name: text(r.get(1)).unwrap_or_default(),
                table: if trigger { text(r.get(2)) } else { None },
                ddl: text(r.get(3)).unwrap_or_default(),
            }
        })
        .collect())
}
