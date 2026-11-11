// Tolerant reading of /api/status. Item 7 (and anything after it) may add
// fields; this client shows what is present and says when a section was
// not reported. Unknown keys are ignored.

use serde_json::Value;

#[derive(Clone, Debug)]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub agent: String,
    pub pinned: bool,
    pub updated: String,
}

#[derive(Clone, Debug)]
pub struct Action {
    pub id: String,
    pub actor: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub result: Option<String>,
    pub risk: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Surfaces {
    pub provider_health: Vec<String>,
    pub activity: Vec<String>,
    pub spend: Vec<String>,
    pub failures: Vec<String>,
    pub model: Vec<String>,
    pub auth: Vec<String>,
    pub channels: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub ok: bool,
    pub at: Option<String>,
    pub chats: Vec<ChatSummary>,
    pub actions: Vec<Action>,
    pub surfaces: Surfaces,
}

pub fn parse_snapshot(value: &Value) -> Result<Snapshot, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "status response was not a JSON object".to_string())?;
    if let Some(err) = obj.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    let ok = obj.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
    let at = obj
        .get("at")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut chats = parse_chats(obj.get("chats"));
    chats.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.updated.cmp(&a.updated))
            .then(a.title.cmp(&b.title))
    });
    let actions = parse_actions(obj.get("actions"));
    Ok(Snapshot {
        ok,
        at,
        chats,
        actions,
        surfaces: project(value),
    })
}

pub fn parse_actions(value: Option<&Value>) -> Vec<Action> {
    let Some(items) = value.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    items.iter().filter_map(parse_action).collect()
}

pub fn parse_action(value: &Value) -> Option<Action> {
    let obj = value.as_object()?;
    let id = obj.get("id").and_then(|v| v.as_str())?.to_string();
    Some(Action {
        id,
        actor: obj
            .get("actor")
            .and_then(|v| v.as_str())
            .unwrap_or("sam")
            .to_string(),
        kind: obj
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("action")
            .to_string(),
        title: obj
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("(untitled)")
            .to_string(),
        detail: obj
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        status: obj
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("pending")
            .to_string(),
        result: obj
            .get("result")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        risk: obj
            .get("risk")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

fn parse_chats(value: Option<&Value>) -> Vec<ChatSummary> {
    let Some(items) = value.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let id = obj.get("id").and_then(|v| v.as_str())?.to_string();
            let title = obj
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("untitled")
                .to_string();
            let agent = obj
                .get("agent_name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("sam")
                .to_string();
            let pinned = match obj.get("pinned") {
                Some(Value::Bool(b)) => *b,
                Some(Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
                _ => false,
            };
            let updated = ["lastMessageAt", "updated_at", "updatedAt"]
                .iter()
                .find_map(|key| obj.get(*key).and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            Some(ChatSummary {
                id,
                title,
                agent,
                pinned,
                updated,
            })
        })
        .collect()
}

pub fn project(value: &Value) -> Surfaces {
    Surfaces {
        provider_health: provider_health(value),
        activity: activity_lines(value),
        spend: spend_lines(value),
        failures: failure_lines(value),
        model: model_lines(value),
        auth: auth_lines(value),
        channels: channel_lines(value),
    }
}

fn provider_health(value: &Value) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(providers) = value.get("providers").and_then(|v| v.as_array()) {
        if providers.is_empty() {
            lines.push("providers: none configured".into());
        }
        for provider in providers {
            lines.push(provider_line(provider));
        }
    } else if value.get("providerHealth").is_some() {
        lines.push(provider_line(value.get("providerHealth").unwrap()));
    }
    if let Some(auth) = value.get("auth") {
        if auth.is_null() {
            lines.push("auth: not reported".into());
        } else {
            let provider = auth
                .get("provider")
                .and_then(|v| v.as_str())
                .unwrap_or("(provider not named)");
            let healthy = match auth.get("healthy").and_then(|v| v.as_bool()) {
                Some(true) => "healthy",
                Some(false) => "not healthy",
                None => "health not reported",
            };
            let key = auth
                .get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("key not reported");
            let key_env = auth.get("keyEnv").and_then(|v| v.as_str()).unwrap_or("key");
            lines.push(format!("{provider} · {healthy} · {key_env} {key}"));
            if let Some(routes) = auth.get("routes").and_then(|v| v.as_array()) {
                for route in routes {
                    lines.push(format!("  {}", route_line(route)));
                }
            }
        }
    } else if lines.is_empty() {
        lines.push("provider health not reported".into());
    }
    lines
}

fn provider_line(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    let name = value
        .get("name")
        .or_else(|| value.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("provider");
    let verdict = value
        .get("verdict")
        .or_else(|| value.get("status"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            value.get("healthy").and_then(|v| v.as_bool()).map(|ok| {
                if ok {
                    "healthy".into()
                } else {
                    "not healthy".into()
                }
            })
        })
        .unwrap_or_else(|| "verdict not reported".into());
    let model = value
        .get("model")
        .and_then(|v| v.as_str())
        .map(|m| format!(" · {m}"))
        .unwrap_or_default();
    format!("{name} · {verdict}{model}")
}

fn route_line(route: &Value) -> String {
    let name = route
        .get("route")
        .and_then(|v| v.as_str())
        .unwrap_or("route");
    let model = route
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("(no model)");
    let key = route.get("key").and_then(|v| v.as_str()).unwrap_or("key ?");
    let probe = route
        .get("lastProbe")
        .and_then(|p| p.get("bucket"))
        .and_then(|v| v.as_str())
        .unwrap_or("no probe");
    format!("{name}: {model} · key {key} · probe {probe}")
}

fn activity_lines(value: &Value) -> Vec<String> {
    let Some(items) = value.get("activity").and_then(|v| v.as_array()) else {
        return vec!["per-agent activity not reported".into()];
    };
    if items.is_empty() {
        return vec!["no activity recorded".into()];
    }
    let mut lines = Vec::new();
    let mut actors: Vec<String> = Vec::new();
    for item in items {
        let actor = item
            .get("actor")
            .and_then(|v| v.as_str())
            .unwrap_or("sam")
            .to_string();
        if !actors.iter().any(|a| a == &actor) {
            actors.push(actor);
        }
    }
    for actor in actors {
        let count = items
            .iter()
            .filter(|item| item.get("actor").and_then(|v| v.as_str()).unwrap_or("sam") == actor)
            .count();
        lines.push(format!(
            "{actor} · {count} event{}",
            if count == 1 { "" } else { "s" }
        ));
        for item in items
            .iter()
            .rev()
            .filter(|item| item.get("actor").and_then(|v| v.as_str()).unwrap_or("sam") == actor)
        {
            let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("event");
            let summary = item.get("summary").and_then(|v| v.as_str()).unwrap_or("");
            lines.push(format!("  {kind} · {summary}"));
        }
    }
    lines
}

fn spend_lines(value: &Value) -> Vec<String> {
    let Some(usage) = value.get("usage") else {
        return vec!["spend not reported".into()];
    };
    if usage.is_null() {
        return vec!["spend not reported".into()];
    }
    let mut lines = Vec::new();
    let total = usage.get("totalTokens").and_then(|v| v.as_u64());
    let calls = usage.get("calls").and_then(|v| v.as_u64());
    match (total, calls) {
        (Some(t), Some(c)) => lines.push(format!("{t} tokens · {c} calls")),
        (Some(t), None) => lines.push(format!("{t} tokens")),
        (None, Some(c)) => lines.push(format!("{c} calls · token totals not reported")),
        (None, None) => lines.push("usage object present, totals not reported".into()),
    }
    if let Some(map) = usage.get("byActor").and_then(|v| v.as_object()) {
        for (actor, bucket) in map {
            lines.push(format!("  {actor}: {}", bucket_text(bucket)));
        }
    }
    if let Some(map) = usage.get("byModel").and_then(|v| v.as_object()) {
        for (model, bucket) in map {
            lines.push(format!("  model {model}: {}", bucket_text(bucket)));
        }
    }
    lines
}

fn bucket_text(bucket: &Value) -> String {
    let tokens = bucket.get("totalTokens").and_then(|v| v.as_u64());
    let calls = bucket.get("calls").and_then(|v| v.as_u64());
    match (tokens, calls) {
        (Some(t), Some(c)) => format!("{t} tokens · {c} calls"),
        (Some(t), None) => format!("{t} tokens"),
        (None, Some(c)) => format!("{c} calls"),
        (None, None) => "no totals".into(),
    }
}

fn failure_lines(value: &Value) -> Vec<String> {
    if let Some(failures) = value.get("failures").and_then(|v| v.as_array()) {
        if failures.is_empty() {
            return vec!["no failures reported".into()];
        }
        return failures
            .iter()
            .map(|item| {
                if let Some(text) = item.as_str() {
                    return text.to_string();
                }
                let actor = item.get("actor").and_then(|v| v.as_str()).unwrap_or("sam");
                let reason = item
                    .get("reason")
                    .or_else(|| item.get("summary"))
                    .or_else(|| item.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("failure");
                format!("{actor} · {reason}")
            })
            .collect();
    }
    let Some(items) = value.get("activity").and_then(|v| v.as_array()) else {
        return vec!["failures not reported".into()];
    };
    let failed: Vec<String> = items
        .iter()
        .filter(|item| {
            item.get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .contains("fail")
        })
        .map(|item| {
            let actor = item.get("actor").and_then(|v| v.as_str()).unwrap_or("sam");
            let summary = item
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("failed");
            format!("{actor} · {summary}")
        })
        .collect();
    if failed.is_empty() {
        vec!["no turn failures in the activity that was returned".into()]
    } else {
        failed
    }
}

fn model_lines(value: &Value) -> Vec<String> {
    let Some(models) = value.get("models").and_then(|v| v.as_array()) else {
        return vec!["model routes not reported".into()];
    };
    if models.is_empty() {
        return vec!["no model routes reported".into()];
    }
    models
        .iter()
        .map(|row| {
            let route = row.get("route").and_then(|v| v.as_str()).unwrap_or("route");
            let model = row
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("(unset)");
            let tier = row.get("tier").and_then(|v| v.as_str()).unwrap_or("");
            let source = row.get("source").and_then(|v| v.as_str()).unwrap_or("");
            let extra = [tier, source]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
            if extra.is_empty() {
                format!("{route} → {model}")
            } else {
                format!("{route} → {model} ({extra})")
            }
        })
        .collect()
}

fn auth_lines(value: &Value) -> Vec<String> {
    let Some(auth) = value.get("auth") else {
        return vec!["auth state not reported".into()];
    };
    if auth.is_null() {
        return vec!["auth state not reported".into()];
    }
    let mut lines = Vec::new();
    if let Some(provider) = auth.get("provider").and_then(|v| v.as_str()) {
        lines.push(format!("provider {provider}"));
    }
    if let Some(endpoint) = auth.get("endpoint").and_then(|v| v.as_str()) {
        lines.push(format!("endpoint {endpoint}"));
    } else {
        lines.push("endpoint not reported".into());
    }
    let key_env = auth.get("keyEnv").and_then(|v| v.as_str()).unwrap_or("key");
    let key = auth
        .get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("not reported");
    lines.push(format!("{key_env} {key}"));
    if let Some(setup) = auth.get("setupVerified") {
        if setup.is_null() {
            lines.push("setup not verified".into());
        } else {
            let model = setup
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("(model)");
            let at = setup
                .get("verifiedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("time not reported");
            lines.push(format!("setup verified {model} at {at}"));
        }
    }
    if let Some(engine) = auth.get("engine") {
        let installed = engine.get("installed").and_then(|v| v.as_bool());
        let connected = engine.get("connected").and_then(|v| v.as_bool());
        lines.push(format!(
            "engine installed {} · connected {}",
            yes_no(installed),
            yes_no(connected)
        ));
    }
    if let Some(config) = value.get("config") {
        if let Some(agent) = config.get("defaultAgent").and_then(|v| v.as_str()) {
            lines.push(format!("default agent {agent}"));
        }
    }
    if lines.is_empty() {
        lines.push("auth object present, no readable fields".into());
    }
    lines
}

fn channel_lines(value: &Value) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(channels) = value.get("channels").and_then(|v| v.as_array()) {
        if channels.is_empty() {
            lines.push("no channels registered".into());
        }
        for channel in channels {
            if let Some(text) = channel.as_str() {
                lines.push(text.to_string());
                continue;
            }
            let name = channel
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("channel");
            let kind = channel.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
            let profile = channel
                .get("profile")
                .and_then(|v| v.as_str())
                .unwrap_or("sam");
            let enabled = channel
                .get("enabled")
                .and_then(|v| v.as_bool())
                .map(|on| if on { "on" } else { "off" })
                .unwrap_or("?");
            let token_env = channel
                .get("tokenEnv")
                .and_then(|v| v.as_str())
                .map(|name| format!(" · env {name}"))
                .unwrap_or_default();
            lines.push(format!(
                "{kind} {name} · profile {profile} · {enabled}{token_env}"
            ));
        }
    }
    if let Some(pairing) = value.get("pairing").and_then(|v| v.as_array()) {
        if pairing.is_empty() && lines.is_empty() {
            lines.push("no paired channels".into());
        }
        for row in pairing {
            let name = row
                .get("channel")
                .and_then(|v| v.as_str())
                .unwrap_or("channel");
            let profile = row.get("profile").and_then(|v| v.as_str()).unwrap_or("sam");
            let owners = row.get("owners").and_then(|v| v.as_u64()).unwrap_or(0);
            let locked = row.get("lockedUntil").and_then(|v| v.as_str());
            let lock = locked
                .map(|t| format!(" · locked until {t}"))
                .unwrap_or_default();
            lines.push(format!(
                "pairing {name} · profile {profile} · {owners} owners{lock}"
            ));
        }
    }
    if lines.is_empty() {
        lines.push("channels not reported".into());
    }
    lines
}

fn yes_no(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "yes",
        Some(false) => "no",
        None => "not reported",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_and_extra_status_fields_are_both_safe() {
        let bare = parse_snapshot(&json!({"ok": true, "futureWidget": {"n": 1}})).unwrap();
        assert!(bare.ok);
        assert!(bare.chats.is_empty());
        assert!(bare
            .surfaces
            .provider_health
            .iter()
            .any(|l| l.contains("not reported")));
        assert!(bare
            .surfaces
            .spend
            .iter()
            .any(|l| l.contains("not reported")));
        assert!(bare
            .surfaces
            .activity
            .iter()
            .any(|l| l.contains("not reported")));
        assert!(bare
            .surfaces
            .channels
            .iter()
            .any(|l| l.contains("not reported")));

        let rich = parse_snapshot(&json!({
            "ok": true,
            "at": "2026-11-11T00:00:00Z",
            "extra": [1, {"a": true}],
            "chats": [{"id": "c1", "title": "Smoke", "agent_name": null, "pinned": 1, "updated_at": "t2"},
                      {"id": "c2", "title": "Other", "pinned": false, "updated_at": "t3"}],
            "actions": [{"id": "a1", "actor": "sam", "kind": "note", "title": "Remember", "detail": "x", "status": "pending", "risk": "internal"}],
            "providers": [{"name": "mock", "healthy": true, "model": "mock-model"}],
            "failures": [{"actor": "sam", "reason": "timeout on chat"}],
            "auth": {"provider": "generic", "keyEnv": "SAM_MODEL_API_KEY", "key": "present", "healthy": true,
                     "endpoint": "http://127.0.0.1:9/v1/chat/completions",
                     "routes": [{"route": "chat", "model": "mock-model", "key": "present", "lastProbe": {"bucket": "ok"}}]},
            "models": [{"route": "chat", "model": "mock-model", "tier": "main", "source": "main-env"}],
            "usage": {"totalTokens": 18, "calls": 1, "byActor": {"sam": {"totalTokens": 18, "calls": 1}}},
            "activity": [{"actor": "sam", "kind": "turn", "summary": "Answered in chat abc"}],
            "channels": [{"name": "desk", "kind": "telegram", "profile": "sam", "enabled": true, "tokenEnv": "SAM_CHANNEL_DESK"}],
            "pairing": [{"channel": "desk", "profile": "sam", "owners": 1}]
        }))
        .unwrap();
        assert_eq!(rich.chats[0].title, "Smoke");
        assert_eq!(rich.chats[0].agent, "sam");
        assert!(rich
            .surfaces
            .provider_health
            .iter()
            .any(|l| l.contains("mock")));
        assert!(rich
            .surfaces
            .provider_health
            .iter()
            .any(|l| l.contains("healthy")));
        assert!(rich.surfaces.spend.iter().any(|l| l.contains("18 tokens")));
        assert!(rich.surfaces.failures.iter().any(|l| l.contains("timeout")));
        assert!(rich
            .surfaces
            .activity
            .iter()
            .any(|l| l.contains("Answered")));
        assert!(rich
            .surfaces
            .channels
            .iter()
            .any(|l| l.contains("SAM_CHANNEL_DESK")));
        assert!(rich.surfaces.model.iter().any(|l| l.contains("mock-model")));
        assert!(!format!("{:?}", rich.surfaces).contains("secret-value"));
    }

    #[test]
    fn turn_failures_come_from_activity_when_no_failures_field() {
        let snap = parse_snapshot(&json!({
            "activity": [
                {"actor": "sam", "kind": "turn", "summary": "Answered"},
                {"actor": "sam", "kind": "turn-failed", "summary": "Turn failed in chat abcd (chat): Model request timed out"}
            ]
        }))
        .unwrap();
        assert_eq!(snap.surfaces.failures.len(), 1);
        assert!(snap.surfaces.failures[0].contains("timed out"));
    }
}
