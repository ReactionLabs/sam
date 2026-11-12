// Thinking render, tier 1. The dashboard does not stream a private
// reasoning channel. What we can show honestly is the wall clock of the
// turn, team events the chat poll already returns, and a partial
// assistant row while it is still being written.

use crate::markdown::{SpanKind, StyledSpan};

pub const SPINNER: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

pub const VERBS: &[&str] = &[
    "Thinking",
    "Reading",
    "Drafting",
    "Checking",
    "Weighing",
    "Composing",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolState {
    Running,
    Done,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolLine {
    pub name: String,
    pub state: ToolState,
}

pub fn spinner_frame(elapsed_ms: u64) -> char {
    SPINNER[(elapsed_ms / 80) as usize % SPINNER.len()]
}

pub fn verb(elapsed_ms: u64) -> &'static str {
    VERBS[(elapsed_ms / 1_200) as usize % VERBS.len()]
}

pub fn elapsed_label(ms: u64) -> String {
    if ms < 10_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format!("{}s", ms / 1000)
    }
}

pub fn thought_line(ms: u64) -> String {
    if ms < 1_000 {
        "Thought for <1s".into()
    } else {
        format!("Thought for {}s", ms / 1000)
    }
}

pub fn tool_mark(state: ToolState, frame: char) -> char {
    match state {
        ToolState::Running => frame,
        ToolState::Done => '✓',
        ToolState::Failed => '✗',
    }
}

pub fn apply_event(tools: &mut Vec<ToolLine>, kind: &str, content: &str) {
    let name = event_name(content);
    if name.is_empty() {
        return;
    }
    match kind {
        "tool" => {
            if tools
                .iter()
                .any(|tool| tool.name == name && tool.state == ToolState::Running)
            {
                return;
            }
            tools.push(ToolLine {
                name,
                state: ToolState::Running,
            });
        }
        "result" => {
            let folded = content.to_ascii_lowercase();
            let state = if folded.contains("fail") || folded.contains("error") {
                ToolState::Failed
            } else {
                ToolState::Done
            };
            if let Some(existing) = tools.iter_mut().rev().find(|tool| tool.name == name) {
                existing.state = state;
            } else {
                tools.push(ToolLine { name, state });
            }
        }
        _ => {}
    }
}

fn event_name(content: &str) -> String {
    let head = content.split(':').next().unwrap_or(content).trim();
    head.split_whitespace()
        .next()
        .unwrap_or("")
        .chars()
        .take(48)
        .collect()
}

pub fn live_block(
    elapsed_ms: u64,
    tools: &[ToolLine],
    reasoning: &str,
    width: usize,
) -> Vec<Vec<StyledSpan>> {
    let frame = spinner_frame(elapsed_ms);
    let mut lines = vec![vec![StyledSpan::new(
        format!(
            "{frame} {} · {}",
            verb(elapsed_ms),
            elapsed_label(elapsed_ms)
        ),
        SpanKind::Accent,
    )]];
    for tool in tools.iter().take(8) {
        let kind = match tool.state {
            ToolState::Running => SpanKind::Accent,
            ToolState::Done => SpanKind::Ok,
            ToolState::Failed => SpanKind::Warn,
        };
        lines.push(vec![StyledSpan::new(
            format!("  {} {}", tool_mark(tool.state, frame), tool.name),
            kind,
        )]);
    }
    let reasoning = reasoning.trim();
    if !reasoning.is_empty() {
        let room = width.saturating_sub(2).max(8);
        for line in wrap_plain(reasoning, room).into_iter().take(6) {
            lines.push(vec![StyledSpan::new(format!("  {line}"), SpanKind::Dim)]);
        }
    }
    lines
}

fn wrap_plain(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        if raw.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut rest = raw.trim();
        while rest.chars().count() > width {
            let mut end = floor_char_count(rest, width);
            if let Some(space) = rest[..end].rfind(char::is_whitespace) {
                if space > width / 3 {
                    end = space;
                }
            }
            let end = floor_char(rest, end);
            lines.push(rest[..end].trim_end().to_string());
            rest = rest[end..].trim_start();
        }
        if !rest.is_empty() {
            lines.push(rest.to_string());
        }
    }
    lines
}

fn floor_char_count(text: &str, chars: usize) -> usize {
    text.char_indices()
        .nth(chars)
        .map(|(i, _)| i)
        .unwrap_or(text.len())
}

fn floor_char(text: &str, byte: usize) -> usize {
    if byte >= text.len() {
        return text.len();
    }
    let mut at = byte;
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spinner_verbs_and_the_thought_line_follow_the_clock() {
        assert_ne!(spinner_frame(0), spinner_frame(80));
        assert_eq!(verb(0), "Thinking");
        assert_eq!(verb(1_200), "Reading");
        assert_eq!(verb(6_000), "Composing");
        assert_eq!(verb(7_200), "Thinking");
        assert_eq!(elapsed_label(1_200), "1.2s");
        assert_eq!(thought_line(400), "Thought for <1s");
        assert_eq!(thought_line(3_400), "Thought for 3s");
        assert!(SPINNER.iter().all(|ch| !ch.is_ascii()));
    }

    #[test]
    fn tool_lines_spin_then_check_or_cross() {
        let mut tools = Vec::new();
        apply_event(&mut tools, "message", "hello");
        assert!(tools.is_empty());
        apply_event(&mut tools, "tool", "sam_code: requested (read)");
        apply_event(&mut tools, "tool", "sam_code: requested (read)");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].state, ToolState::Running);
        assert_eq!(tool_mark(ToolState::Running, '⠋'), '⠋');
        apply_event(&mut tools, "result", "sam_code: done (ok)");
        assert_eq!(tools[0].state, ToolState::Done);
        assert_eq!(tool_mark(ToolState::Done, '⠋'), '✓');
        apply_event(&mut tools, "result", "sam_reach: failed (timeout)");
        assert_eq!(tools[1].state, ToolState::Failed);
        assert_eq!(tool_mark(ToolState::Failed, '⠋'), '✗');

        let block = live_block(0, &tools, "comparing the two diffs", 40);
        let text = block
            .iter()
            .flat_map(|line| line.iter().map(|span| span.text.clone()))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Thinking"), "{text}");
        assert!(text.contains('⠋'), "{text}");
        assert!(text.contains("sam_code"), "{text}");
        assert!(text.contains('✓'), "{text}");
        assert!(text.contains('✗'), "{text}");
        assert!(text.contains("comparing the two diffs"), "{text}");
        assert!(block
            .iter()
            .any(|line| line.iter().any(|span| span.kind == SpanKind::Dim)));
    }
}
