// Read-only projections of /api/status for the keys 5–9 screens.
// Missing objects stay missing: a section says so instead of inventing
// rows. Telegram pairing is not the desktop bridge.

use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Boards {
    pub skills: Vec<String>,
    pub tools: Vec<String>,
    pub connections: Vec<String>,
    pub engine: Vec<String>,
    pub bridge: Vec<String>,
    pub model: String,
    pub today_tokens: Option<u64>,
    pub today_calls: Option<u64>,
}

pub fn from_status(value: &Value) -> Boards {
    Boards {
        skills: skill_lines(value),
        tools: tool_lines(value),
        connections: connection_lines(value),
        engine: engine_lines(value),
        bridge: bridge_lines(value),
        model: model_name(value),
        today_tokens: usage_today(value, "totalTokens"),
        today_calls: usage_today(value, "calls"),
    }
}

fn skill_lines(value: &Value) -> Vec<String> {
    let Some(skills) = value.get("skills").and_then(|v| v.as_array()) else {
        return vec!["skills not reported by /api/status".into()];
    };
    let mut lines = Vec::new();
    if skills.is_empty() {
        lines.push("No skills installed.".into());
    }
    for skill in skills {
        let name = skill
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("(unnamed skill)");
        let source = skill
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("source not reported");
        lines.push(format!("{name}  ·  {source}"));
        if let Some(description) = skill.get("description").and_then(|v| v.as_str()) {
            if !description.is_empty() {
                lines.push(format!("  {description}"));
            }
        }
    }
    if let Some(use_rows) = value.get("skillUse").and_then(|v| v.as_array()) {
        if !use_rows.is_empty() {
            lines.push(String::new());
            lines.push("Recent use".into());
            for row in use_rows.iter().take(8) {
                let name = row
                    .get("skill")
                    .or_else(|| row.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("skill");
                let when = row
                    .get("at")
                    .or_else(|| row.get("usedAt"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                lines.push(format!("  {name}  {when}").trim_end().to_string());
            }
        }
    }
    if let Some(lists) = value.get("skillAllowlists").and_then(|v| v.as_object()) {
        if !lists.is_empty() {
            lines.push(String::new());
            lines.push("Allowlists".into());
            for (profile, names) in lists {
                let joined = names
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_else(|| "not a list".into());
                let joined = if joined.is_empty() {
                    "(none)".into()
                } else {
                    joined
                };
                lines.push(format!("  {profile}: {joined}"));
            }
        }
    }
    lines
}

fn tool_lines(value: &Value) -> Vec<String> {
    let mut lines = Vec::new();
    let catalog = value.get("tools").and_then(|v| v.as_array());
    if let Some(tools) = catalog {
        if tools.is_empty() {
            lines.push("Tool catalog is empty.".into());
        }
        for tool in tools {
            if let Some(name) = tool.as_str() {
                lines.push(name.to_string());
                continue;
            }
            let name = tool
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("(unnamed tool)");
            let kind = tool
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("tool");
            lines.push(format!("{name}  ·  {kind}"));
        }
    }
    if let Some(connectors) = value.get("connectors").and_then(|v| v.as_array()) {
        for connector in connectors {
            let name = connector
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("connector");
            let tools = connector
                .get("allowedTools")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if tools.is_empty() {
                continue;
            }
            lines.push(format!("{name}  ·  connector"));
            lines.push(format!("  {}", tools.join(", ")));
        }
    }
    if let Some(commands) = value
        .get("code")
        .and_then(|v| v.get("commands"))
        .and_then(|v| v.as_array())
    {
        let names: Vec<&str> = commands.iter().filter_map(|v| v.as_str()).collect();
        if !names.is_empty() {
            lines.push("Code commands".into());
            lines.push(format!("  {}", names.join(", ")));
        }
    }
    if catalog.is_none() {
        lines.push(String::new());
        lines.push(
            "SAM's built-in tool names are not on /api/status. Connector tools and code commands are listed when that payload includes them."
                .into(),
        );
    }
    if lines.iter().all(|line| line.is_empty()) {
        lines.push("tools not reported by /api/status".into());
    }
    lines
}

fn connection_lines(value: &Value) -> Vec<String> {
    let Some(connectors) = value.get("connectors").and_then(|v| v.as_array()) else {
        return vec!["connections not reported by /api/status".into()];
    };
    if connectors.is_empty() {
        return vec!["No connections configured.".into()];
    }
    let mut lines = Vec::new();
    for connector in connectors {
        let name = connector
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("(unnamed connection)");
        let enabled = match connector.get("enabled").and_then(|v| v.as_bool()) {
            Some(true) => "enabled",
            Some(false) => "disabled",
            None => "enabled not reported",
        };
        let credential = match connector.get("credentialPresent").and_then(|v| v.as_bool()) {
            Some(true) => "credential present",
            Some(false) => "credential missing",
            None => "credential not reported",
        };
        let env_name = connector
            .get("tokenEnv")
            .and_then(|v| v.as_str())
            .filter(|name| !name.is_empty())
            .map(|name| format!(" · env {name}"))
            .unwrap_or_default();
        lines.push(format!(
            "{name}  ·  {enabled}  ·  {credential}{env_name}"
        ));
        if let Some(url) = connector.get("url").and_then(|v| v.as_str()) {
            lines.push(format!("  {}", host_of(url)));
        }
    }
    lines
}

fn engine_lines(value: &Value) -> Vec<String> {
    let Some(engine) = value.get("engine") else {
        return vec!["Claude Code status is not reported by /api/status".into()];
    };
    if engine.is_null() {
        return vec!["Claude Code status is not reported by /api/status".into()];
    }
    let mut lines = vec!["Claude Code".into()];
    let installed = engine.get("installed").and_then(|v| v.as_bool());
    lines.push(format!(
        "installed  {}",
        match installed {
            Some(true) => "yes",
            Some(false) => "no",
            None => "not reported",
        }
    ));
    match engine.get("binary") {
        Some(Value::String(path)) if !path.is_empty() => lines.push(format!("binary  {path}")),
        Some(Value::Null) | None => lines.push("binary  not installed".into()),
        _ => lines.push("binary  not reported".into()),
    }
    let queued = num(engine, "queued");
    let running = num(engine, "running");
    let done = num(engine, "done");
    let blocked = num(engine, "blocked");
    let failed = num(engine, "failed");
    lines.push(format!(
        "queue  {queued} queued · {running} running · {done} done · {blocked} blocked · {failed} failed"
    ));
    if let Some(connection) = engine.get("connection") {
        let connected = connection.get("connected").and_then(|v| v.as_bool());
        let stale = connection.get("stale").and_then(|v| v.as_bool());
        let route = connection
            .get("route")
            .and_then(|v| v.as_str())
            .unwrap_or("route not reported");
        let state = match (connected, stale) {
            (Some(true), _) => "connected",
            (Some(false), Some(true)) => "stale",
            (Some(false), _) => "not connected",
            _ => "connection not reported",
        };
        lines.push(format!("connect  {state} · {route}"));
        if let Some(record) = connection.get("record") {
            if let Some(method) = record.get("authMethod").and_then(|v| v.as_str()) {
                lines.push(format!("auth method  {method}"));
            }
            if let Some(at) = record.get("connectedAt").and_then(|v| v.as_str()) {
                lines.push(format!("connected at  {at}"));
            }
        }
    } else {
        lines.push("connect  not reported".into());
    }
    if let Some(recent) = engine.get("recent").and_then(|v| v.as_array()) {
        lines.push(String::new());
        lines.push("Recent runs".into());
        if recent.is_empty() {
            lines.push("  none".into());
        }
        for task in recent.iter().rev().take(8) {
            let title = task
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("(untitled)");
            let status = task
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("status not reported");
            lines.push(format!("  {status}  ·  {title}"));
        }
    }
    lines
}

fn bridge_lines(value: &Value) -> Vec<String> {
    let bridge = value
        .get("desktopBridge")
        .or_else(|| value.get("desktop_bridge"));
    let Some(bridge) = bridge else {
        return vec![
            "not paired".into(),
            String::new(),
            "No desktop bridge is connected. Pairing and session state will show here when a bridge exists."
                .into(),
            "Telegram pairing is a different channel and is not shown on this screen.".into(),
        ];
    };
    if bridge.is_null() {
        return vec![
            "not paired".into(),
            "The desktop bridge reported nothing.".into(),
        ];
    }
    let paired = bridge.get("paired").and_then(|v| v.as_bool());
    let mut lines = vec![match paired {
        Some(true) => "paired".to_string(),
        Some(false) => "not paired".to_string(),
        None => "pairing not reported".to_string(),
    }];
    for key in ["device", "session", "detail", "since"] {
        if let Some(text) = bridge.get(key).and_then(|v| v.as_str()) {
            if !text.is_empty() && !looks_secret(key) {
                lines.push(format!("{key}  {text}"));
            }
        }
    }
    if paired != Some(true) && lines.len() == 1 {
        lines.push("The desktop bridge is not paired.".into());
    }
    lines
}

fn looks_secret(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("token") || key.contains("secret") || key.contains("password") || key.contains("key")
}

fn model_name(value: &Value) -> String {
    let Some(models) = value.get("models").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let preferred = models
        .iter()
        .find(|row| row.get("route").and_then(|v| v.as_str()) == Some("chat"));
    preferred
        .or_else(|| models.first())
        .and_then(|row| row.get("model").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string()
}

fn usage_today(value: &Value, field: &str) -> Option<u64> {
    value
        .get("usageToday")
        .and_then(|v| v.get(field))
        .and_then(|v| v.as_u64())
}

fn num(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

fn host_of(url: &str) -> String {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let host = rest.split('/').next().unwrap_or(rest);
    if host.is_empty() {
        "endpoint not reported".into()
    } else {
        host.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_sections_say_so_and_the_bridge_is_not_inferred() {
        let boards = from_status(&json!({
            "ok": true,
            "pairing": [{"channel": "desk", "owners": 2}],
            "usage": {"totalTokens": 99, "calls": 4}
        }));
        assert!(boards.skills.iter().any(|l| l.contains("not reported")));
        assert!(boards.connections.iter().any(|l| l.contains("not reported")));
        assert!(boards.engine.iter().any(|l| l.contains("not reported")));
        assert_eq!(boards.bridge[0], "not paired");
        assert!(boards.bridge.iter().any(|l| l.contains("not shown")));
        assert!(boards.today_tokens.is_none(), "all-time usage is not today");
        assert!(boards.today_calls.is_none());
        assert!(boards.model.is_empty());
    }

    #[test]
    fn present_payloads_render_without_secrets() {
        let boards = from_status(&json!({
            "skills": [{"name": "brief", "description": "Morning digest", "source": "skills"}],
            "skillAllowlists": {"trading": ["brief"]},
            "connectors": [{
                "name": "Second Shift",
                "url": "https://mcp.secondshiftos.com/v1",
                "tokenEnv": "SAM_MCP_TOKEN_SHIFT",
                "enabled": true,
                "credentialPresent": true,
                "allowedTools": ["whoami", "list_leads"],
                "token": "do-not-print"
            }],
            "code": {"commands": ["build", "test"]},
            "models": [{"route": "fast", "model": "small"}, {"route": "chat", "model": "mock-model"}],
            "usageToday": {"totalTokens": 18, "calls": 1},
            "engine": {
                "installed": true,
                "binary": "/usr/local/bin/claude",
                "queued": 0, "running": 1, "done": 3, "blocked": 0, "failed": 0,
                "connection": {"route": "cli-reuse", "connected": true, "stale": false,
                    "record": {"authMethod": "claude.ai", "connectedAt": "2026-11-11T00:00:00Z"}},
                "recent": [{"title": "Fix the gate", "status": "running"}]
            },
            "desktopBridge": {"paired": false, "detail": "waiting for the app"}
        }));
        assert!(boards.skills.iter().any(|l| l.contains("brief")));
        assert!(boards.skills.iter().any(|l| l.contains("trading: brief")));
        assert!(boards.tools.iter().any(|l| l.contains("list_leads")));
        assert!(boards.tools.iter().any(|l| l.contains("build")));
        assert!(boards.tools.iter().any(|l| l.contains("not on /api/status")));
        assert!(boards
            .connections
            .iter()
            .any(|l| l.contains("SAM_MCP_TOKEN_SHIFT")));
        assert!(boards
            .connections
            .iter()
            .any(|l| l.contains("mcp.secondshiftos.com")));
        let flat = format!("{:?}", boards.connections);
        assert!(!flat.contains("do-not-print"));
        assert_eq!(boards.model, "mock-model");
        assert_eq!(boards.today_tokens, Some(18));
        assert_eq!(boards.today_calls, Some(1));
        assert!(boards.engine.iter().any(|l| l.contains("connected")));
        assert!(boards.engine.iter().any(|l| l.contains("Fix the gate")));
        assert_eq!(boards.bridge[0], "not paired");
        assert!(boards.bridge.iter().any(|l| l.contains("waiting")));
    }
}
