// Connection settings. Env (SAM_BASE_URL, SAM_TOKEN) wins over a local
// config file. The file must be owner-only (mode 0600 or 0400); a looser
// file is refused and never parsed, so a token in it is not loaded.

use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Connection {
    pub base_url: String,
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileConfig {
    #[serde(rename = "baseUrl", alias = "base_url")]
    base_url: Option<String>,
    token: Option<String>,
}

pub fn default_config_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("SAM_CONFIG") {
        let path = path.trim();
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    let home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(home.join("sam").join("cli.json"))
}

pub fn load_connection(
    config_path: Option<&Path>,
    base_override: Option<&str>,
    token_override: Option<&str>,
) -> Result<Connection, String> {
    let path = config_path
        .map(|p| p.to_path_buf())
        .or_else(default_config_path);
    let mut base_url = None;
    let mut token = None;
    if let Some(path) = path {
        if path.exists() {
            let file = read_private_config(&path)?;
            base_url = file.base_url.filter(|s| !s.trim().is_empty());
            token = file.token.filter(|s| !s.trim().is_empty());
        } else if config_path.is_some() {
            return Err(format!("config file not found: {}", path.display()));
        }
    }
    if let Some(value) = non_empty(std::env::var("SAM_BASE_URL").ok()) {
        base_url = Some(value);
    }
    if let Some(value) = non_empty(std::env::var("SAM_TOKEN").ok()) {
        token = Some(value);
    }
    if let Some(value) = non_empty(base_override.map(|s| s.to_string())) {
        base_url = Some(value);
    }
    if let Some(value) = non_empty(token_override.map(|s| s.to_string())) {
        token = Some(value);
    }
    let base_url = base_url.ok_or_else(|| {
        "set SAM_BASE_URL or baseUrl in the config file (the dashboard origin, or the /sam door)".to_string()
    })?;
    Ok(Connection {
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        token: token.map(|t| t.trim().to_string()),
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty())
}

fn read_private_config(path: &Path) -> Result<FileConfig, String> {
    ensure_private(path)?;
    if path
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        ensure_private(&fs::canonicalize(path).map_err(|e| e.to_string())?)?;
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("config {} is not valid JSON: {e}", path.display()))
}

fn ensure_private(path: &Path) -> Result<(), String> {
    let meta =
        fs::symlink_metadata(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!(
                "config file must be owner-only (mode 0600); refusing {} (mode {mode:04o})",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn isolated() -> std::sync::MutexGuard<'static, ()> {
        let guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var("SAM_BASE_URL");
        std::env::remove_var("SAM_TOKEN");
        std::env::remove_var("SAM_CONFIG");
        guard
    }

    #[test]
    fn env_overrides_a_private_file_and_a_loose_file_is_refused() {
        let _guard = isolated();
        let dir = std::env::temp_dir().join(format!("sam-cli-cfg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cli.json");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(
            br#"{"baseUrl":"http://127.0.0.1:4317","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o644);
            fs::set_permissions(&path, perms.clone()).unwrap();
            let err = load_connection(Some(&path), None, None).unwrap_err();
            assert!(err.contains("0600"), "{err}");
            perms.set_mode(0o600);
            fs::set_permissions(&path, perms).unwrap();
        }
        std::env::set_var("SAM_BASE_URL", "http://127.0.0.1:9999/sam");
        std::env::set_var("SAM_TOKEN", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let conn = load_connection(Some(&path), None, None).unwrap();
        assert_eq!(conn.base_url, "http://127.0.0.1:9999/sam");
        assert_eq!(
            conn.token.as_deref(),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        let from_flag = load_connection(
            Some(&path),
            Some("http://localhost:4317/"),
            Some("cccccccccccccccccccccccccccccccc"),
        )
        .unwrap();
        assert_eq!(from_flag.base_url, "http://localhost:4317");
        assert_eq!(
            from_flag.token.as_deref(),
            Some("cccccccccccccccccccccccccccccccc")
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
