// The always-on status line. Today's tokens and calls are shown only
// when the status payload actually split them out. The all-time ledger
// is a different number and is never labeled "today".

pub fn format_count(n: u64) -> String {
    if n < 1_000 {
        n.to_string()
    } else if n < 1_000_000 {
        let tenths = (n as f64 / 100.0).round() / 10.0;
        if (tenths - tenths.round()).abs() < 0.05 {
            format!("{:.0}k", tenths)
        } else {
            format!("{tenths:.1}k")
        }
    } else {
        let tenths = (n as f64 / 100_000.0).round() / 10.0;
        format!("{tenths:.1}m")
    }
}

pub fn status_line(
    profile: &str,
    model: &str,
    tokens: Option<u64>,
    calls: Option<u64>,
    state: &str,
) -> String {
    let profile = if profile.trim().is_empty() {
        "profile"
    } else {
        profile.trim()
    };
    let model = if model.trim().is_empty() {
        "model not reported"
    } else {
        model.trim()
    };
    let usage = match (tokens, calls) {
        (Some(tokens), Some(calls)) => format!(
            "{} tok · {} call{} today",
            format_count(tokens),
            format_count(calls),
            if calls == 1 { "" } else { "s" }
        ),
        (Some(tokens), None) => format!("{} tok today", format_count(tokens)),
        (None, Some(calls)) => format!(
            "{} call{} today · tokens not reported",
            format_count(calls),
            if calls == 1 { "" } else { "s" }
        ),
        (None, None) => "today's usage not reported".into(),
    };
    let state = if state.trim().is_empty() {
        "connection not reported"
    } else {
        state.trim()
    };
    format!("{profile}  ·  {model}  ·  {usage}  ·  {state}")
}

pub fn connection_state(connected: bool, busy: bool, elapsed_ms: Option<u64>) -> String {
    let link = if connected { "connected" } else { "offline" };
    if busy {
        let elapsed = elapsed_ms
            .map(crate::thinking::elapsed_label)
            .unwrap_or_else(|| "…".into());
        format!("working {elapsed} · {link}")
    } else if connected {
        link.into()
    } else {
        "offline".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_line_names_today_only_when_the_server_split_it() {
        let line = status_line("dip", "mock-model", Some(18), Some(1), "connected");
        assert_eq!(
            line,
            "dip  ·  mock-model  ·  18 tok · 1 call today  ·  connected"
        );
        let missing = status_line("trading", "", None, None, "offline");
        assert!(missing.contains("model not reported"), "{missing}");
        assert!(missing.contains("today's usage not reported"), "{missing}");
        assert!(!missing.contains("0 tok"), "{missing}");
        assert_eq!(format_count(1_200), "1.2k");
        assert_eq!(format_count(2_000_000), "2.0m");
    }

    #[test]
    fn a_live_turn_stays_on_the_bar_next_to_the_link() {
        let state = connection_state(true, true, Some(3_200));
        assert_eq!(state, "working 3.2s · connected");
        assert_eq!(connection_state(false, false, None), "offline");
    }
}
