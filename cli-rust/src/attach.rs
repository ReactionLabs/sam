// Attach a local image by path. The dashboard message route accepts a
// string body, and a markdown data URL is a string it already stores.
// The body cap is 12_000 characters, so a photo that does not fit is
// refused instead of being truncated into a broken URL.

use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
use std::path::{Path, PathBuf};

pub const MESSAGE_LIMIT: usize = 12_000;

pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

pub fn image_markdown(name: &str, mime: &str, bytes: &[u8]) -> String {
    let safe = name.replace(['[', ']', '(', ')', '\n', '\r'], "");
    let name = if safe.trim().is_empty() {
        "image"
    } else {
        safe.trim()
    };
    format!("![{name}](data:{mime};base64,{})", STANDARD.encode(bytes))
}

pub fn join_attachment(text: &str, markdown: &str) -> Result<String, String> {
    let joined = if text.trim().is_empty() {
        markdown.to_string()
    } else {
        format!("{}\n{markdown}", text.trim_end())
    };
    if joined.chars().count() > MESSAGE_LIMIT {
        Err(format!(
            "image is too large for the dashboard message limit ({MESSAGE_LIMIT} characters)"
        ))
    } else {
        Ok(joined)
    }
}

pub fn load_attachment(path: &Path, existing_text: &str) -> Result<(String, String), String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();
    refuse_name(&name)?;
    if let Ok(canon) = fs::canonicalize(path) {
        if let Some(final_name) = canon.file_name().and_then(|n| n.to_str()) {
            refuse_name(final_name)?;
        }
    }
    let meta = fs::metadata(path).map_err(|err| format!("cannot read {}: {err}", display(path)))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", display(path)));
    }
    let prefix = image_markdown(&name, "image/png", &[]);
    let budget = MESSAGE_LIMIT
        .saturating_sub(existing_text.chars().count())
        .saturating_sub(prefix.chars().count())
        .saturating_sub(1);
    let max_bytes = (budget / 4) * 3;
    if meta.len() == 0 || meta.len() > max_bytes as u64 {
        return Err(format!(
            "image is too large for the dashboard message limit ({MESSAGE_LIMIT} characters)"
        ));
    }
    let bytes = fs::read(path).map_err(|err| format!("cannot read {}: {err}", display(path)))?;
    let mime = sniff_mime(&bytes).ok_or_else(|| {
        format!("{} is not a png, jpeg, gif, or webp", display(path))
    })?;
    let markdown = image_markdown(&name, mime, &bytes);
    let _ = join_attachment(existing_text, &markdown)?;
    Ok((name, markdown))
}

fn refuse_name(name: &str) -> Result<(), String> {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with('.')
        || lower.contains("secret")
        || lower.contains(".env")
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.contains("id_rsa")
    {
        return Err(format!("refusing to attach {name}"));
    }
    Ok(())
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

pub fn expand_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

    #[test]
    fn a_png_becomes_a_data_url_the_message_body_can_carry() {
        let dir = std::env::temp_dir().join(format!("sam-cli-attach-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pixel.png");
        fs::write(&path, PNG).unwrap();
        let (name, markdown) = load_attachment(&path, "look").unwrap();
        assert_eq!(name, "pixel.png");
        assert!(
            markdown.starts_with("![pixel.png](data:image/png;base64,"),
            "{markdown}"
        );
        let joined = join_attachment("look", &markdown).unwrap();
        assert!(joined.starts_with("look\n![pixel.png]"));
        assert!(joined.chars().count() <= MESSAGE_LIMIT);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn secrets_and_non_images_and_oversize_files_are_refused() {
        let dir = std::env::temp_dir().join(format!("sam-cli-attach-no-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let env = dir.join(".env");
        fs::write(&env, b"TOKEN=nope").unwrap();
        let err = load_attachment(&env, "").unwrap_err();
        assert!(err.contains("refusing"), "{err}");
        let text = dir.join("notes.txt");
        fs::write(&text, b"hello").unwrap();
        let err = load_attachment(&text, "").unwrap_err();
        assert!(err.contains("not a png"), "{err}");
        let big = dir.join("big.png");
        let mut bytes = PNG.to_vec();
        bytes.resize(20_000, 1);
        fs::write(&big, &bytes).unwrap();
        let err = load_attachment(&big, "").unwrap_err();
        assert!(err.contains("12000"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }
}
