// Block-letter S.A.M. wordmark. Same glyphs as the TypeScript splash
// (src/banner.ts) so every surface spells the name the same way.

const GLYPHS: &[(&str, &[&str])] = &[
    ("PROMPT", &["    ", "    ", " >_ ", "    ", "    "]),
    (
        "S",
        &[" ██████", "██     ", " █████ ", "     ██", "██████ "],
    ),
    (".", &["  ", "  ", "  ", "  ", "██"]),
    (
        "A",
        &[" █████ ", "██   ██", "███████", "██   ██", "██   ██"],
    ),
    (".", &["  ", "  ", "  ", "  ", "██"]),
    (
        "M",
        &[
            "███   ███",
            "████ ████",
            "██ ███ ██",
            "██  █  ██",
            "██     ██",
        ],
    ),
];

pub fn sam_wordmark() -> Vec<String> {
    let mut rows = Vec::new();
    for r in 0..5 {
        let line = GLYPHS
            .iter()
            .map(|(_, g)| g[r])
            .collect::<Vec<_>>()
            .join(" ");
        rows.push(line);
    }
    rows
}

pub const TAGLINE: &str = "Self-directed AI Workforce";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordmark_is_five_rows_of_blocks() {
        let rows = sam_wordmark();
        assert_eq!(rows.len(), 5);
        assert!(rows.iter().all(|r| r.contains('█')));
        assert!(rows[0].starts_with("     "));
        assert!(rows[2].contains(">_"));
        assert!(rows[4].contains('█'));
        let width = rows[0].chars().count();
        assert!(rows.iter().all(|r| r.chars().count() == width));
        assert!(width < 48, "wordmark should fit a narrow terminal");
    }
}
