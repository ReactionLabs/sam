// A small markdown renderer for the transcript. SAM's replies are lists,
// tables, and fenced code, and raw text makes those unreadable. The
// highlighter covers the languages that show up in those fences. It is
// intentionally small: a wrong color is recoverable, a panic is not.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpanKind {
    Text,
    Dim,
    Accent,
    Strong,
    Code,
    Keyword,
    String,
    Comment,
    Ok,
    Warn,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StyledSpan {
    pub text: String,
    pub kind: SpanKind,
}

impl StyledSpan {
    pub fn new(text: impl Into<String>, kind: SpanKind) -> Self {
        Self {
            text: text.into(),
            kind,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MdLine {
    pub spans: Vec<StyledSpan>,
    pub code_block: Option<usize>,
    pub fence_header: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeBlock {
    pub lang: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Doc {
    pub lines: Vec<MdLine>,
    pub code_blocks: Vec<CodeBlock>,
}

impl Doc {
    #[allow(dead_code)]
    pub fn plain(&self) -> String {
        self.lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.text.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn render_markdown(src: &str, width: usize) -> Doc {
    let width = width.max(8);
    let mut doc = Doc {
        lines: Vec::new(),
        code_blocks: Vec::new(),
    };
    let mut in_fence = false;
    let mut lang = String::new();
    let mut code = String::new();
    let raw_lines: Vec<&str> = src.split('\n').collect();
    let mut i = 0;
    while i < raw_lines.len() {
        let line = raw_lines[i];
        if let Some(rest) = line.trim_start().strip_prefix("```") {
            if in_fence {
                let index = doc.code_blocks.len();
                doc.code_blocks.push(CodeBlock {
                    lang: lang.clone(),
                    source: code.clone(),
                });
                push_wrapped(
                    &mut doc.lines,
                    vec![StyledSpan::new(String::new(), SpanKind::Text)],
                    width,
                    Some(index),
                    false,
                );
                in_fence = false;
                code.clear();
            } else {
                lang = rest.trim().to_string();
                let label = if lang.is_empty() {
                    "code".to_string()
                } else {
                    lang.clone()
                };
                let index = doc.code_blocks.len();
                doc.lines.push(MdLine {
                    spans: vec![StyledSpan::new(format!("  {label}"), SpanKind::Dim)],
                    code_block: Some(index),
                    fence_header: true,
                });
                in_fence = true;
                code.clear();
            }
            i += 1;
            continue;
        }
        if in_fence {
            if !code.is_empty() {
                code.push('\n');
            }
            code.push_str(line);
            let highlighted = highlight_code(line, &lang);
            push_spans(
                &mut doc.lines,
                highlighted,
                width,
                Some(doc.code_blocks.len()),
                false,
            );
            i += 1;
            continue;
        }
        if line.trim().is_empty() {
            doc.lines.push(MdLine {
                spans: vec![StyledSpan::new(String::new(), SpanKind::Text)],
                code_block: None,
                fence_header: false,
            });
            i += 1;
            continue;
        }
        if is_table_row(line) {
            let mut table = Vec::new();
            while i < raw_lines.len() && is_table_row(raw_lines[i]) {
                if !is_table_rule(raw_lines[i]) {
                    table.push(raw_lines[i].to_string());
                }
                i += 1;
            }
            for (row_i, row) in table.iter().enumerate() {
                let cells = split_table(row);
                let rendered = if row_i == 0 {
                    cells.join("  ·  ")
                } else {
                    cells.join("  ")
                };
                let kind = if row_i == 0 {
                    SpanKind::Strong
                } else {
                    SpanKind::Text
                };
                push_wrapped(
                    &mut doc.lines,
                    vec![StyledSpan::new(rendered, kind)],
                    width,
                    None,
                    false,
                );
            }
            continue;
        }
        let trimmed = line.trim_start();
        if let Some(rest) = heading(trimmed) {
            push_wrapped(
                &mut doc.lines,
                vec![StyledSpan::new(rest, SpanKind::Strong)],
                width,
                None,
                false,
            );
        } else if let Some(rest) = list_item(trimmed) {
            push_wrapped(&mut doc.lines, inline(&rest, true), width, None, false);
        } else if let Some(rest) = trimmed.strip_prefix('>') {
            let mut spans = vec![StyledSpan::new("│ ", SpanKind::Dim)];
            spans.extend(inline(rest.trim_start(), false));
            for span in &mut spans {
                if span.kind == SpanKind::Text {
                    span.kind = SpanKind::Dim;
                }
            }
            push_wrapped(&mut doc.lines, spans, width, None, false);
        } else {
            push_wrapped(&mut doc.lines, inline(trimmed, false), width, None, false);
        }
        i += 1;
    }
    if in_fence {
        doc.code_blocks.push(CodeBlock {
            lang: lang.clone(),
            source: code,
        });
    }
    doc
}

fn heading(line: &str) -> Option<String> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if (1..=3).contains(&hashes) && line.chars().nth(hashes) == Some(' ') {
        Some(line[hashes + 1..].trim().to_string())
    } else {
        None
    }
}

fn list_item(line: &str) -> Option<String> {
    if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
        return Some(format!("• {rest}"));
    }
    let mut chars = line.chars();
    let mut digits = String::new();
    while let Some(ch) = chars.clone().next() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            chars.next();
        } else {
            break;
        }
    }
    if !digits.is_empty() && chars.next() == Some('.') && chars.next() == Some(' ') {
        let rest = line[digits.len() + 2..].trim();
        return Some(format!("{digits}. {rest}"));
    }
    None
}

fn is_table_row(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('|') && trimmed.matches('|').count() >= 2
}

fn is_table_rule(line: &str) -> bool {
    let cells = split_table(line);
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let cell = cell.trim();
            !cell.is_empty() && cell.chars().all(|c| c == '-' || c == ':' || c == ' ')
        })
}

fn split_table(line: &str) -> Vec<String> {
    line.trim()
        .trim_matches('|')
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect()
}

fn inline(text: &str, _list: bool) -> Vec<StyledSpan> {
    let mut spans = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut buf = String::new();
    let flush = |buf: &mut String, spans: &mut Vec<StyledSpan>| {
        if !buf.is_empty() {
            spans.push(StyledSpan::new(std::mem::take(buf), SpanKind::Text));
        }
    };
    while i < chars.len() {
        if chars[i] == '`' {
            flush(&mut buf, &mut spans);
            if let Some(end) = chars[i + 1..].iter().position(|c| *c == '`') {
                let inner: String = chars[i + 1..i + 1 + end].iter().collect();
                spans.push(StyledSpan::new(inner, SpanKind::Code));
                i += end + 2;
                continue;
            }
        }
        if chars[i] == '*' && chars.get(i + 1) == Some(&'*') {
            flush(&mut buf, &mut spans);
            if let Some(end) = find_marker(&chars, i + 2, &['*', '*']) {
                let inner: String = chars[i + 2..end].iter().collect();
                spans.push(StyledSpan::new(inner, SpanKind::Strong));
                i = end + 2;
                continue;
            }
        }
        if chars[i] == '*' {
            flush(&mut buf, &mut spans);
            if let Some(end) = chars[i + 1..].iter().position(|c| *c == '*') {
                let inner: String = chars[i + 1..i + 1 + end].iter().collect();
                if !inner.is_empty() {
                    spans.push(StyledSpan::new(inner, SpanKind::Accent));
                    i += end + 2;
                    continue;
                }
            }
        }
        if chars[i] == '[' {
            if let Some((label, close)) = parse_link(&chars, i) {
                flush(&mut buf, &mut spans);
                spans.push(StyledSpan::new(label, SpanKind::Accent));
                i = close;
                continue;
            }
        }
        buf.push(chars[i]);
        i += 1;
    }
    flush(&mut buf, &mut spans);
    if spans.is_empty() {
        spans.push(StyledSpan::new(String::new(), SpanKind::Text));
    }
    spans
}

fn find_marker(chars: &[char], from: usize, marker: &[char]) -> Option<usize> {
    if marker.len() != 2 {
        return None;
    }
    let mut i = from;
    while i + 1 < chars.len() {
        if chars[i] == marker[0] && chars[i + 1] == marker[1] {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn parse_link(chars: &[char], start: usize) -> Option<(String, usize)> {
    let close = chars[start + 1..].iter().position(|c| *c == ']')?;
    let label: String = chars[start + 1..start + 1 + close].iter().collect();
    let after = start + 1 + close + 1;
    if chars.get(after) != Some(&'(') {
        return None;
    }
    let end = chars[after + 1..].iter().position(|c| *c == ')')?;
    if label.is_empty() {
        return None;
    }
    Some((label, after + 1 + end + 1))
}

fn push_wrapped(
    out: &mut Vec<MdLine>,
    spans: Vec<StyledSpan>,
    width: usize,
    code_block: Option<usize>,
    fence_header: bool,
) {
    push_spans(out, spans, width, code_block, fence_header);
}

fn push_spans(
    out: &mut Vec<MdLine>,
    spans: Vec<StyledSpan>,
    width: usize,
    code_block: Option<usize>,
    fence_header: bool,
) {
    let mut row: Vec<StyledSpan> = Vec::new();
    let mut used = 0usize;
    for span in spans {
        let mut rest = span.text.as_str();
        let kind = span.kind;
        if rest.is_empty() && row.is_empty() {
            row.push(StyledSpan::new(String::new(), kind));
        }
        while !rest.is_empty() {
            let room = width.saturating_sub(used).max(1);
            if rest.chars().count() <= room {
                used += rest.chars().count();
                row.push(StyledSpan::new(rest, kind));
                break;
            }
            let (head, tail) = split_span(rest, room);
            if !head.is_empty() {
                row.push(StyledSpan::new(head, kind));
            }
            out.push(MdLine {
                spans: std::mem::take(&mut row),
                code_block,
                fence_header,
            });
            used = 0;
            rest = tail.trim_start();
        }
    }
    if !row.is_empty() || out.is_empty() {
        out.push(MdLine {
            spans: if row.is_empty() {
                vec![StyledSpan::new(String::new(), SpanKind::Text)]
            } else {
                row
            },
            code_block,
            fence_header,
        });
    }
}

fn split_span(text: &str, room: usize) -> (&str, &str) {
    let room = room.max(1);
    if text.chars().count() <= room {
        return (text, "");
    }
    let mut end = text.len();
    let mut count = 0;
    for (i, _ch) in text.char_indices() {
        if count == room {
            end = i;
            break;
        }
        count += 1;
    }
    if let Some(space) = text[..end].rfind(char::is_whitespace) {
        if space > 0 && text[..space].chars().count() >= room / 3 {
            return (text[..space].trim_end(), text[space..].trim_start());
        }
    }
    (text[..end].trim_end(), text[end..].trim_start())
}

pub fn highlight_code(line: &str, lang: &str) -> Vec<StyledSpan> {
    let keywords = keywords(lang);
    let hash_comment = matches!(
        lang,
        "py" | "python" | "sh" | "bash" | "zsh" | "yaml" | "yml" | "toml" | "rb" | "ruby"
    );
    let mut spans = Vec::new();
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut buf = String::new();
    let mut kind = SpanKind::Text;
    let flush = |buf: &mut String, kind: SpanKind, spans: &mut Vec<StyledSpan>| {
        if !buf.is_empty() {
            spans.push(StyledSpan::new(std::mem::take(buf), kind));
        }
    };
    while i < chars.len() {
        if chars[i] == '/' && chars.get(i + 1) == Some(&'/') {
            flush(&mut buf, kind, &mut spans);
            let rest: String = chars[i..].iter().collect();
            spans.push(StyledSpan::new(rest, SpanKind::Comment));
            return spans;
        }
        if hash_comment && chars[i] == '#' {
            flush(&mut buf, kind, &mut spans);
            let rest: String = chars[i..].iter().collect();
            spans.push(StyledSpan::new(rest, SpanKind::Comment));
            return spans;
        }
        if chars[i] == '"' || chars[i] == '\'' || chars[i] == '`' {
            flush(&mut buf, kind, &mut spans);
            let quote = chars[i];
            let mut j = i + 1;
            while j < chars.len() && chars[j] != quote {
                if chars[j] == '\\' && j + 1 < chars.len() {
                    j += 2;
                    continue;
                }
                j += 1;
            }
            if j < chars.len() {
                j += 1;
            }
            let text: String = chars[i..j].iter().collect();
            spans.push(StyledSpan::new(text, SpanKind::String));
            i = j;
            continue;
        }
        if chars[i].is_ascii_digit() && (i == 0 || !chars[i - 1].is_ascii_alphanumeric()) {
            flush(&mut buf, kind, &mut spans);
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == '.') {
                j += 1;
            }
            let text: String = chars[i..j].iter().collect();
            spans.push(StyledSpan::new(text, SpanKind::Accent));
            i = j;
            continue;
        }
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            let word: String = chars[i..j].iter().collect();
            if keywords.iter().any(|kw| *kw == word) {
                flush(&mut buf, kind, &mut spans);
                spans.push(StyledSpan::new(word, SpanKind::Keyword));
            } else {
                if kind != SpanKind::Text {
                    flush(&mut buf, kind, &mut spans);
                    kind = SpanKind::Text;
                }
                buf.push_str(&word);
            }
            i = j;
            continue;
        }
        if kind != SpanKind::Text {
            flush(&mut buf, kind, &mut spans);
            kind = SpanKind::Text;
        }
        buf.push(chars[i]);
        i += 1;
    }
    flush(&mut buf, kind, &mut spans);
    if spans.is_empty() {
        spans.push(StyledSpan::new(String::new(), SpanKind::Text));
    }
    spans
}

fn keywords(lang: &str) -> &'static [&'static str] {
    match lang {
        "rs" | "rust" => RUST_KW,
        "ts" | "tsx" | "js" | "jsx" | "javascript" | "typescript" => JS_KW,
        "py" | "python" => PY_KW,
        "go" => GO_KW,
        "sh" | "bash" | "zsh" => SH_KW,
        _ => COMMON_KW,
    }
}

const RUST_KW: &[&str] = &[
    "fn", "let", "mut", "pub", "struct", "enum", "impl", "use", "mod", "match", "if", "else",
    "return", "for", "while", "loop", "async", "await", "self", "Self", "true", "false", "const",
    "type", "where", "trait",
];
const JS_KW: &[&str] = &[
    "function", "const", "let", "var", "return", "if", "else", "for", "while", "class", "import",
    "export", "from", "async", "await", "new", "true", "false", "null", "undefined", "interface",
    "type",
];
const PY_KW: &[&str] = &[
    "def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "True",
    "False", "None", "with", "try", "except", "lambda", "yield", "async", "await",
];
const GO_KW: &[&str] = &[
    "func", "package", "import", "return", "if", "else", "for", "range", "struct", "type", "var",
    "const", "true", "false", "nil", "defer", "go",
];
const SH_KW: &[&str] = &[
    "if", "then", "else", "fi", "for", "in", "do", "done", "while", "case", "esac", "function",
    "return", "echo", "export",
];
const COMMON_KW: &[&str] = &[
    "fn", "function", "def", "return", "if", "else", "for", "while", "class", "import", "let",
    "const", "true", "false",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_renders_lists_tables_and_a_highlighted_block() {
        let src = "\
# Notes
See `code` and **bold**.

- first
- second

| name | kind |
| --- | --- |
| sam_code | own |

```rust
fn main() { let s = \"hi\"; } // note
```
";
        let doc = render_markdown(src, 60);
        let plain = doc.plain();
        assert!(plain.contains("Notes"), "{plain}");
        assert!(plain.contains("• first"), "{plain}");
        assert!(plain.contains("sam_code"), "{plain}");
        assert!(plain.contains("fn main"), "{plain}");
        assert!(!plain.contains("```"), "{plain}");
        assert_eq!(doc.code_blocks.len(), 1);
        assert_eq!(doc.code_blocks[0].lang, "rust");
        assert!(doc.code_blocks[0].source.contains("fn main"));
        assert!(doc.code_blocks[0].source.contains("// note"));
        let kinds: Vec<SpanKind> = doc
            .lines
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.kind))
            .collect();
        assert!(kinds.contains(&SpanKind::Code), "inline code");
        assert!(kinds.contains(&SpanKind::Strong), "bold and heading");
        assert!(kinds.contains(&SpanKind::Keyword), "fn is a keyword");
        assert!(kinds.contains(&SpanKind::String), "string literal");
        assert!(kinds.contains(&SpanKind::Comment), "line comment");
        assert!(doc
            .lines
            .iter()
            .any(|line| line.fence_header && line.code_block == Some(0)));
    }

    #[test]
    fn a_long_line_wraps_inside_the_column() {
        let doc = render_markdown(&"word ".repeat(30), 20);
        assert!(doc.lines.len() > 1);
        assert!(doc.lines.iter().all(|line| {
            line.spans
                .iter()
                .map(|s| s.text.chars().count())
                .sum::<usize>()
                <= 20
        }));
    }
}
