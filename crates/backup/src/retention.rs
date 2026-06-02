//! Pure retention policy: given the existing backup files and a policy, decide
//! which ones to delete. No filesystem access here so it stays unit-testable;
//! the caller does the stat() and the unlink().

/// One backup file on disk, with its modification time (unix seconds).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackupFile {
    pub path: String,
    pub mtime: i64,
}

/// Retention policy. Both bounds are optional and combine: a file is deleted if
/// it falls outside `keep_n` (too old by count) OR older than `max_age_days`.
#[derive(Clone, Copy, Debug, Default)]
pub struct RetentionPolicy {
    /// Keep only the newest N. `None` = unlimited.
    pub keep_n: Option<u32>,
    /// Delete files older than this many days. `None` = no age limit.
    pub max_age_days: Option<u32>,
}

impl RetentionPolicy {
    pub fn is_noop(&self) -> bool {
        self.keep_n.is_none() && self.max_age_days.is_none()
    }
}

/// Returns the paths to delete, newest-first ordering applied internally.
/// `now` is unix seconds (passed in — this layer has no clock).
pub fn files_to_delete(files: &[BackupFile], policy: RetentionPolicy, now: i64) -> Vec<String> {
    if policy.is_noop() {
        return Vec::new();
    }

    // newest first
    let mut sorted: Vec<&BackupFile> = files.iter().collect();
    sorted.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));

    let age_cutoff = policy
        .max_age_days
        .map(|d| now - (d as i64) * 86_400);

    let mut doomed = Vec::new();
    for (idx, f) in sorted.iter().enumerate() {
        let over_count = policy.keep_n.is_some_and(|n| idx >= n as usize);
        let too_old = age_cutoff.is_some_and(|cut| f.mtime < cut);
        if over_count || too_old {
            doomed.push(f.path.clone());
        }
    }
    doomed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(path: &str, mtime: i64) -> BackupFile {
        BackupFile { path: path.into(), mtime }
    }

    #[test]
    fn noop_keeps_everything() {
        let files = vec![f("a", 1), f("b", 2)];
        assert!(files_to_delete(&files, RetentionPolicy::default(), 100).is_empty());
    }

    #[test]
    fn keep_n_drops_oldest() {
        let files = vec![f("old", 10), f("mid", 20), f("new", 30)];
        let policy = RetentionPolicy { keep_n: Some(2), max_age_days: None };
        let del = files_to_delete(&files, policy, 100);
        assert_eq!(del, vec!["old".to_string()]);
    }

    #[test]
    fn max_age_drops_old_files() {
        let now = 100 * 86_400;
        let files = vec![
            f("recent", now - 86_400),
            f("aged", now - 10 * 86_400),
        ];
        let policy = RetentionPolicy { keep_n: None, max_age_days: Some(7) };
        let del = files_to_delete(&files, policy, now);
        assert_eq!(del, vec!["aged".to_string()]);
    }

    #[test]
    fn count_and_age_combine() {
        let now = 100 * 86_400;
        // 4 files; keep_n=3 would drop the oldest, age=5d also drops anything older
        let files = vec![
            f("d1", now - 86_400),
            f("d2", now - 2 * 86_400),
            f("d6", now - 6 * 86_400),
            f("d8", now - 8 * 86_400),
        ];
        let policy = RetentionPolicy { keep_n: Some(3), max_age_days: Some(5) };
        let mut del = files_to_delete(&files, policy, now);
        del.sort();
        // d8 fails count (idx 3) AND age; d6 fails age only. both deleted, no dups.
        assert_eq!(del, vec!["d6".to_string(), "d8".to_string()]);
    }

    #[test]
    fn keep_n_zero_deletes_all() {
        let files = vec![f("a", 1), f("b", 2)];
        let policy = RetentionPolicy { keep_n: Some(0), max_age_days: None };
        assert_eq!(files_to_delete(&files, policy, 100).len(), 2);
    }
}
