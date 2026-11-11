// Kitty and iTerm2 inline-image sequences, matching src/term-image.ts.
// A terminal that speaks neither protocol gets a text placeholder.
// SAM_TUI_IMAGE overrides detection: kitty | iterm2 | halfblock | off | none.
// halfblock is not drawn here; it falls through to the placeholder.

use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageProtocol {
    Kitty,
    Iterm2,
    None,
}

impl ImageProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            ImageProtocol::Kitty => "kitty",
            ImageProtocol::Iterm2 => "iterm2",
            ImageProtocol::None => "none",
        }
    }
}

pub fn detect_image_protocol(get: impl Fn(&str) -> String) -> ImageProtocol {
    let over = get("SAM_TUI_IMAGE").to_ascii_lowercase();
    match over.trim() {
        "kitty" => return ImageProtocol::Kitty,
        "iterm2" | "iterm" => return ImageProtocol::Iterm2,
        "off" | "none" | "halfblock" => return ImageProtocol::None,
        _ => {}
    }
    if !get("KITTY_WINDOW_ID").trim().is_empty() || get("TERM").contains("kitty") {
        return ImageProtocol::Kitty;
    }
    match get("TERM_PROGRAM").as_str() {
        "iTerm.app" | "WezTerm" => ImageProtocol::Iterm2,
        _ => ImageProtocol::None,
    }
}

pub fn encode_kitty(bytes: &[u8]) -> String {
    let b64 = STANDARD.encode(bytes);
    const CHUNK: usize = 4096;
    if b64.len() <= CHUNK {
        return format!("\u{1b}_Ga=T,f=100,t=d;{b64}\u{1b}\\\n");
    }
    let mut out = String::new();
    let mut i = 0;
    while i < b64.len() {
        let last = i + CHUNK >= b64.len();
        let head = if i == 0 { "a=T,f=100,t=d," } else { "" };
        let end = (i + CHUNK).min(b64.len());
        out.push_str(&format!(
            "\u{1b}_G{head}m={};{}\u{1b}\\",
            if last { 0 } else { 1 },
            &b64[i..end]
        ));
        i += CHUNK;
    }
    out.push('\n');
    out
}

pub fn encode_iterm2(bytes: &[u8], name: &str, cols: u16) -> String {
    let b64 = STANDARD.encode(bytes);
    let name_b64 = STANDARD.encode(name.as_bytes());
    let cols = cols.max(1);
    format!(
        "\u{1b}]1337;File=name={name_b64};size={};inline=1;width={cols};preserveAspectRatio=1:{b64}\u{7}\n",
        bytes.len()
    )
}

pub fn image_label(name: &str, protocol: ImageProtocol) -> String {
    match protocol {
        ImageProtocol::Kitty => format!("[image: {name} · kitty protocol]"),
        ImageProtocol::Iterm2 => format!("[image: {name} · iTerm2 protocol]"),
        ImageProtocol::None => {
            format!("[image: {name} · no graphics protocol]")
        }
    }
}

#[derive(Clone, Debug)]
pub struct InlineImage {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// Images embedded in a message. Data URLs are decoded here. Remote http(s)
/// URLs are returned only when `allow_remote` accepts the URL (the caller
/// limits that to the SAM origin). Local paths are returned only as names
/// plus the raw relative token in `local`.
#[derive(Clone, Debug)]
pub enum ImageRef {
    Inline(InlineImage),
    Remote { name: String, url: String },
    Local { name: String, path: String },
}

pub fn find_images(content: &str) -> Vec<ImageRef> {
    let mut found = Vec::new();
    let mut rest = content;
    while !rest.is_empty() {
        let markdown = rest.find("![");
        let data = rest.find("data:image/");
        let http = ["http://", "https://"]
            .iter()
            .filter_map(|p| rest.find(p))
            .min();
        let Some(at) = [markdown, data, http].into_iter().flatten().min() else {
            break;
        };
        if markdown == Some(at) {
            if let Some((img, n)) = parse_markdown(&rest[at..]) {
                found.push(img);
                rest = &rest[at + n..];
                continue;
            }
        }
        if data == Some(at) {
            if let Some((img, n)) = parse_data_url(&rest[at..]) {
                found.push(ImageRef::Inline(img));
                rest = &rest[at + n..];
                continue;
            }
        }
        if http == Some(at) {
            if let Some((name, url, n)) = parse_http(&rest[at..]) {
                found.push(ImageRef::Remote { name, url });
                rest = &rest[at + n..];
                continue;
            }
        }
        let next = rest[at..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        rest = &rest[at + next..];
    }
    for token in content.split_whitespace() {
        let token = token.trim_matches(|c: char| "()[]<>\"',".contains(c));
        if token.starts_with("http://")
            || token.starts_with("https://")
            || token.starts_with("data:")
            || token.contains("..")
            || token.starts_with('/')
        {
            continue;
        }
        if is_image_path(token) {
            found.push(ImageRef::Local {
                name: file_name(token),
                path: token.to_string(),
            });
        }
    }
    found
}

pub fn display_text(content: &str) -> String {
    let mut out = String::new();
    let mut rest = content;
    while !rest.is_empty() {
        let markdown = rest.find("![");
        let data = rest.find("data:image/");
        let Some(at) = [markdown, data].into_iter().flatten().min() else {
            out.push_str(rest);
            break;
        };
        if markdown == Some(at) && parse_markdown(&rest[at..]).is_some() {
            let n = parse_markdown(&rest[at..]).map(|(_, n)| n).unwrap_or(1);
            out.push_str(&rest[..at]);
            out.push_str("[image]");
            rest = &rest[at + n..];
            continue;
        }
        if data == Some(at) && parse_data_url(&rest[at..]).is_some() {
            let n = parse_data_url(&rest[at..]).map(|(_, n)| n).unwrap_or(1);
            out.push_str(&rest[..at]);
            out.push_str("[image]");
            rest = &rest[at + n..];
            continue;
        }
        let next = rest[at..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&rest[..at + next]);
        rest = &rest[at + next..];
    }
    out
}

fn parse_markdown(s: &str) -> Option<(ImageRef, usize)> {
    if !s.starts_with("![") {
        return None;
    }
    let close_alt = s.find("](")?;
    let alt = &s[2..close_alt];
    let target_start = close_alt + 2;
    let close = s[target_start..].find(')')?;
    let target = &s[target_start..target_start + close];
    let consumed = target_start + close + 1;
    let name = if alt.trim().is_empty() {
        file_name(target)
    } else {
        alt.trim().to_string()
    };
    let img = if let Some((inline, _)) = parse_data_url(target) {
        let mut inline = inline;
        if !alt.trim().is_empty() {
            inline.name = name;
        }
        ImageRef::Inline(inline)
    } else if target.starts_with("http://") || target.starts_with("https://") {
        ImageRef::Remote {
            name,
            url: target.to_string(),
        }
    } else if !target.contains("..") && !target.starts_with('/') {
        ImageRef::Local {
            name,
            path: target.to_string(),
        }
    } else {
        return None;
    };
    Some((img, consumed))
}

fn parse_data_url(s: &str) -> Option<(InlineImage, usize)> {
    let rest = s.strip_prefix("data:image/")?;
    let semi = rest.find(';')?;
    let kind = &rest[..semi];
    if kind.is_empty() || kind.len() > 16 || !kind.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let after = &rest[semi..];
    let payload = after.strip_prefix(";base64,")?;
    let end = payload
        .find(|c: char| c.is_whitespace() || c == ')')
        .unwrap_or(payload.len());
    let b64 = &payload[..end];
    if b64.is_empty() || b64.len() > 2_000_000 {
        return None;
    }
    let bytes = STANDARD.decode(b64).ok()?;
    if bytes.is_empty() || bytes.len() > 2_000_000 {
        return None;
    }
    let header_len = "data:image/".len() + kind.len() + ";base64,".len();
    Some((
        InlineImage {
            name: format!("image.{kind}"),
            bytes,
        },
        header_len + end,
    ))
}

fn parse_http(s: &str) -> Option<(String, String, usize)> {
    let end = s
        .find(|c: char| c.is_whitespace() || c == ')')
        .unwrap_or(s.len());
    let url = &s[..end];
    if !is_image_path(url) {
        return None;
    }
    Some((file_name(url), url.to_string(), end))
}

fn is_image_path(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn file_name(token: &str) -> String {
    token
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("image")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> String + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
                .unwrap_or_default()
        }
    }

    #[test]
    fn protocol_detection_matches_the_terminal_env() {
        assert_eq!(detect_image_protocol(env(&[])), ImageProtocol::None);
        assert_eq!(
            detect_image_protocol(env(&[("SAM_TUI_IMAGE", "off")])),
            ImageProtocol::None
        );
        assert_eq!(
            detect_image_protocol(env(&[("SAM_TUI_IMAGE", "halfblock")])),
            ImageProtocol::None
        );
        assert_eq!(
            detect_image_protocol(env(&[("SAM_TUI_IMAGE", "kitty")])),
            ImageProtocol::Kitty
        );
        assert_eq!(
            detect_image_protocol(env(&[("KITTY_WINDOW_ID", "1")])),
            ImageProtocol::Kitty
        );
        assert_eq!(
            detect_image_protocol(env(&[("TERM", "xterm-kitty")])),
            ImageProtocol::Kitty
        );
        assert_eq!(
            detect_image_protocol(env(&[("TERM_PROGRAM", "iTerm.app")])),
            ImageProtocol::Iterm2
        );
        assert_eq!(
            detect_image_protocol(env(&[("TERM_PROGRAM", "WezTerm")])),
            ImageProtocol::Iterm2
        );
        assert_eq!(
            detect_image_protocol(env(&[
                ("TERM_PROGRAM", "iTerm.app"),
                ("SAM_TUI_IMAGE", "none")
            ])),
            ImageProtocol::None
        );
    }

    #[test]
    fn kitty_and_iterm2_sequences_hand_the_bytes_over() {
        let bytes = b"\x89PNG fake";
        let kitty = encode_kitty(bytes);
        assert!(kitty.starts_with("\u{1b}_Ga=T,f=100,t=d;"));
        assert!(kitty.trim_end().ends_with("\u{1b}\\"));
        assert!(kitty.contains(&STANDARD.encode(bytes)));

        let big = vec![7u8; 4000];
        let chunked = encode_kitty(&big);
        assert!(chunked.contains("m=1;"));
        assert!(chunked.contains("m=0;"));
        assert!(chunked.starts_with("\u{1b}_Ga=T,f=100,t=d,m="));

        let iterm = encode_iterm2(bytes, "pixel.png", 40);
        assert!(iterm.starts_with("\u{1b}]1337;File=name="));
        assert!(iterm.contains(";size=9;inline=1;width=40;preserveAspectRatio=1:"));
        assert!(iterm.contains(&STANDARD.encode(b"pixel.png")));
        assert!(iterm.trim_end().ends_with('\u{7}'));
    }

    #[test]
    fn placeholder_when_the_terminal_has_no_protocol() {
        assert_eq!(
            image_label("pixel", ImageProtocol::None),
            "[image: pixel · no graphics protocol]"
        );
        assert!(image_label("pixel", ImageProtocol::Kitty).contains("kitty"));
    }

    #[test]
    fn data_urls_decode_and_leave_the_transcript_readable() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let message = format!("pong from mock\n\n![pixel](data:image/png;base64,{png})");
        let images = find_images(&message);
        assert_eq!(images.len(), 1);
        match &images[0] {
            ImageRef::Inline(img) => {
                assert_eq!(img.name, "pixel");
                assert!(img.bytes.starts_with(b"\x89PNG"));
            }
            other => panic!("expected inline image, got {other:?}"),
        }
        let shown = display_text(&message);
        assert!(shown.contains("pong from mock"));
        assert!(shown.contains("[image]"));
        assert!(!shown.contains("base64"));
    }
}
