// OSC 52 clipboard write. The terminal copies `text` into the system
// clipboard when it understands the sequence. We emit it beside the
// alternate screen, the same way inline images are emitted.

use base64::{engine::general_purpose::STANDARD, Engine};

pub fn encode_osc52(text: &str) -> String {
    let encoded = STANDARD.encode(text.as_bytes());
    format!("\u{1b}]52;c;{encoded}\u{7}")
}

#[allow(dead_code)]
pub fn decode_osc52_payload(sequence: &str) -> Option<Vec<u8>> {
    let rest = sequence.strip_prefix("\u{1b}]52;c;")?;
    let payload = rest.strip_suffix('\u{7}')?;
    STANDARD.decode(payload).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc52_round_trips_text_and_uses_the_clipboard_selector() {
        let sequence = encode_osc52("yank this · line");
        assert!(sequence.starts_with("\u{1b}]52;c;"), "{sequence:?}");
        assert!(sequence.ends_with('\u{7}'), "{sequence:?}");
        assert!(!sequence.contains("yank this"), "payload is base64");
        let bytes = decode_osc52_payload(&sequence).expect("payload");
        assert_eq!(String::from_utf8(bytes).unwrap(), "yank this · line");
    }

    #[test]
    fn osc52_encodes_an_empty_selection_without_dropping_the_wrapper() {
        let sequence = encode_osc52("");
        assert_eq!(sequence, "\u{1b}]52;c;\u{7}");
        assert_eq!(decode_osc52_payload(&sequence).unwrap(), b"");
    }
}
