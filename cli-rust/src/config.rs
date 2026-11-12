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

pub const PROFILE_NAMES: [&str; 3] = ["dip", "trading", "second-shift"];

#[derive(Clone, Debug)]
pub struct ProfileSlot {
    pub name: String,
    pub base_url: Option<String>,
    pub token: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProfileSet {
    pub active: String,
    pub slots: Vec<ProfileSlot>,
}

impl ProfileSet {
    pub fn bare(active: &str) -> Self {
        Self {
            active: canonical_profile(active),
            slots: PROFILE_NAMES
                .iter()
                .map(|name| ProfileSlot {
                    name: (*name).to_string(),
                    base_url: None,
                    token: None,
                })
                .collect(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&ProfileSlot> {
        let name = canonical_profile(name);
        self.slots.iter().find(|slot| slot.name == name)
    }
}

pub struct Session {
    pub connection: Connection,
    pub profiles: ProfileSet,
}

#[derive(Debug, Deserialize)]
struct FileConfig {
    #[serde(rename = "baseUrl", alias = "base_url")]
    base_url: Option<String>,
    token: Option<String>,
    #[serde(rename = "activeProfile", alias = "active_profile")]
    active_profile: Option<String>,
    profiles: Option<std::collections::BTreeMap<String, FileProfile>>,
}

#[derive(Debug, Deserialize)]
struct FileProfile {
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

#[allow(dead_code)]
pub fn load_connection(
    config_path: Option<&Path>,
    base_override: Option<&str>,
    token_override: Option<&str>,
) -> Result<Connection, String> {
    Ok(load_session(config_path, base_override, token_override)?.connection)
}

pub fn load_session(
    config_path: Option<&Path>,
    base_override: Option<&str>,
    token_override: Option<&str>,
) -> Result<Session, String> {
    let path = config_path
        .map(|p| p.to_path_buf())
        .or_else(default_config_path);
    let file = if let Some(path) = &path {
        if path.exists() {
            Some(read_private_config(path)?)
        } else if config_path.is_some() {
            return Err(format!("config file not found: {}", path.display()));
        } else {
            None
        }
    } else {
        None
    };
    let active = active_name(file.as_ref());
    let mut slots = Vec::new();
    for name in PROFILE_NAMES {
        let mut base_url = None;
        let mut token = None;
        if let Some(file) = file.as_ref() {
            if let Some(profiles) = &file.profiles {
                if let Some(slot) = profiles.get(name) {
                    base_url = non_empty(slot.base_url.clone());
                    token = non_empty(slot.token.clone());
                }
            }
        }
        if let Some(value) = non_empty(std::env::var(profile_env(name, "URL")).ok()) {
            base_url = Some(value);
        }
        if let Some(value) = non_empty(std::env::var(profile_env(name, "TOKEN")).ok()) {
            token = Some(value);
        }
        if name == active {
            if base_url.is_none() {
                if let Some(file) = file.as_ref() {
                    base_url = non_empty(file.base_url.clone());
                }
            }
            if token.is_none() {
                if let Some(file) = file.as_ref() {
                    token = non_empty(file.token.clone());
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
        }
        slots.push(ProfileSlot {
            name: name.to_string(),
            base_url: base_url.map(|s| s.trim().trim_end_matches('/').to_string()),
            token: token.map(|s| s.trim().to_string()),
        });
    }
    let profiles = ProfileSet {
        active: active.clone(),
        slots,
    };
    let base_url = profiles
        .get(&active)
        .and_then(|slot| slot.base_url.clone())
        .ok_or_else(|| {
            "set SAM_BASE_URL or baseUrl in the config file (the dashboard origin, or the /sam door)"
                .to_string()
        })?;
    let token = profiles.get(&active).and_then(|slot| slot.token.clone());
    Ok(Session {
        connection: Connection { base_url, token },
        profiles,
    })
}

fn active_name(file: Option<&FileConfig>) -> String {
    if let Some(value) = non_empty(std::env::var("SAM_PROFILE").ok()) {
        return canonical_profile(&value);
    }
    if let Some(file) = file {
        if let Some(value) = non_empty(file.active_profile.clone()) {
            return canonical_profile(&value);
        }
    }
    "dip".into()
}

pub fn canonical_profile(name: &str) -> String {
    let name = name.trim().to_ascii_lowercase().replace('_', "-");
    match name.as_str() {
        "secondshift" | "second-shift" => "second-shift".into(),
        "dip" | "trading" => name,
        _ => "dip".into(),
    }
}

fn profile_env(name: &str, suffix: &str) -> String {
    format!(
        "SAM_PROFILE_{}_{suffix}",
        name.to_ascii_uppercase().replace('-', "_")
    )
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
        std::env::remove_var("SAM_PROFILE");
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
