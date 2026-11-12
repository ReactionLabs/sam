// HTTP client for the dashboard API the owner console already uses.
// POST requests send the same X-SAM-Request header the page sends.
// Tokens are stripped from error text.

use crate::image_proto::{find_images, ImageRef, InlineImage};
use crate::status_view::{self, Action, Snapshot};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Component, Path};
use std::time::Duration;
use url::Url;

#[derive(Clone, Debug)]
pub struct Endpoint {
    pub origin: String,
    pub token: String,
}

#[derive(Clone, Debug)]
pub struct Message {
    #[allow(dead_code)]
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    pub reaction: Option<String>,
    pub partial: bool,
    /// Client stamp from GET, when the server stored one. Absent on older
    /// servers, and "unknown" is treated as absent so legacy rows stay quiet.
    pub source: Option<String>,
}

#[derive(Clone, Debug)]
pub struct TeamEvent {
    pub agent: String,
    pub kind: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct ChatDetail {
    pub messages: Vec<Message>,
    pub events: Vec<String>,
    pub team: Vec<TeamEvent>,
    pub actions: Vec<Action>,
    pub images: Vec<InlineImage>,
}

#[derive(Clone, Debug)]
pub struct SendResult {
    pub reply: String,
    pub user_reaction: Option<String>,
}

#[derive(Clone)]
pub struct Client {
    endpoint: Endpoint,
    agent: ureq::Agent,
    workspace: Option<std::path::PathBuf>,
}

impl Client {
    pub fn workspace(&self) -> Option<std::path::PathBuf> {
        self.workspace.clone()
    }

    pub fn new(endpoint: Endpoint, workspace: Option<std::path::PathBuf>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(120))
            .redirects(0)
            .build();
        Self {
            endpoint,
            agent,
            workspace,
        }
    }

    pub fn status(&self) -> Result<Snapshot, String> {
        let url = format!(
            "{}/api/status/{}",
            self.endpoint.origin, self.endpoint.token
        );
        let value = self.get_json(&url)?;
        status_view::parse_snapshot(&value).map_err(|e| self.redact(e))
    }

    pub fn chat(&self, id: &str) -> Result<ChatDetail, String> {
        let url = format!(
            "{}/api/{}/chats/{}",
            self.endpoint.origin, self.endpoint.token, id
        );
        let value = self.get_json(&url)?;
        let mut detail = parse_chat(&value).map_err(|e| self.redact(e))?;
        detail.images = self.hydrate(&detail.messages);
        Ok(detail)
    }

    pub fn send_message(&self, id: &str, content: &str) -> Result<SendResult, String> {
        let url = format!(
            "{}/api/{}/chats/{}/messages",
            self.endpoint.origin, self.endpoint.token, id
        );
        let value = self.post_json(&url, message_body(content))?;
        let reply = value
            .get("reply")
            .and_then(|r| r.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        if reply.is_empty() {
            if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
                return Err(self.redact(err.to_string()));
            }
        }
        let user_reaction = value
            .get("userReaction")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        Ok(SendResult {
            reply,
            user_reaction,
        })
    }

    pub fn decide(&self, id: &str, approve: bool) -> Result<Action, String> {
        let url = format!(
            "{}/api/{}/actions/{}/decide",
            self.endpoint.origin, self.endpoint.token, id
        );
        let decision = if approve { "approve" } else { "reject" };
        let value = self.post_json(&url, json!({ "decision": decision }))?;
        status_view::parse_action(&value)
            .ok_or_else(|| "decision response was missing the action".to_string())
            .map_err(|e| self.redact(e))
    }

    pub fn create_chat(&self, title: &str) -> Result<String, String> {
        let url = format!("{}/api/{}/chats", self.endpoint.origin, self.endpoint.token);
        let value = self.post_json(&url, json!({ "title": title }))?;
        value
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "create chat response had no id".to_string())
    }

    fn hydrate(&self, messages: &[Message]) -> Vec<InlineImage> {
        let mut images = Vec::new();
        for message in messages {
            for reference in find_images(&message.content) {
                match reference {
                    ImageRef::Inline(image) => images.push(image),
                    ImageRef::Remote { name, url } => {
                        if let Some(bytes) = self.fetch_same_origin(&url) {
                            images.push(InlineImage { name, bytes });
                        }
                    }
                    ImageRef::Local { name, path } => {
                        if let Some(bytes) = self.read_workspace_image(&path) {
                            images.push(InlineImage { name, bytes });
                        }
                    }
                }
            }
        }
        images
    }

    fn fetch_same_origin(&self, raw: &str) -> Option<Vec<u8>> {
        let url = Url::parse(raw).ok()?;
        let origin = Url::parse(&self.endpoint.origin).ok()?;
        if url.scheme() != origin.scheme()
            || url.host_str() != origin.host_str()
            || url.port_or_known_default() != origin.port_or_known_default()
        {
            return None;
        }
        if url.username() != "" || url.password().is_some() {
            return None;
        }
        let response = self.agent.get(raw).call().ok()?;
        let content_type = response.header("content-type").unwrap_or("").to_string();
        if !content_type.starts_with("image/") {
            return None;
        }
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(2_000_000)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.is_empty() {
            None
        } else {
            Some(bytes)
        }
    }

    fn read_workspace_image(&self, rel: &str) -> Option<Vec<u8>> {
        let root = self.workspace.as_ref()?;
        if rel.is_empty() || rel.contains('\0') || rel.starts_with('/') {
            return None;
        }
        let path = root.join(rel);
        for component in Path::new(rel).components() {
            if !matches!(component, Component::Normal(_)) {
                return None;
            }
        }
        let name = path.file_name()?.to_str()?;
        let lower = name.to_ascii_lowercase();
        if lower.starts_with('.') || lower.contains("secret") || lower.contains(".env") {
            return None;
        }
        let meta = fs::metadata(&path).ok()?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > 2_000_000 {
            return None;
        }
        fs::read(&path).ok()
    }

    fn get_json(&self, url: &str) -> Result<Value, String> {
        match self.agent.get(url).set("Accept", "application/json").call() {
            Ok(response) => read_json(response).map_err(|e| self.redact(e)),
            Err(ureq::Error::Status(code, response)) => {
                Err(self.redact(http_error(code, response)))
            }
            Err(err) => Err(self.redact(err.to_string())),
        }
    }

    fn post_json(&self, url: &str, body: Value) -> Result<Value, String> {
        let encoded = serde_json::to_string(&body).map_err(|e| e.to_string())?;
        match self
            .agent
            .post(url)
            .set("Content-Type", "application/json")
            .set("X-SAM-Request", "dashboard")
            .send_string(&encoded)
        {
            Ok(response) => read_json(response).map_err(|e| self.redact(e)),
            Err(ureq::Error::Status(code, response)) => {
                Err(self.redact(http_error(code, response)))
            }
            Err(err) => Err(self.redact(err.to_string())),
        }
    }

    fn redact(&self, text: String) -> String {
        text.replace(&self.endpoint.token, "<token>")
    }
}

/// Body the Rust CLI posts for one owner message. `source` is the
/// provenance stamp the dashboard stores on the message record.
pub fn message_body(content: &str) -> Value {
    json!({ "content": content, "source": "rust-cli" })
}

fn read_json(response: ureq::Response) -> Result<Value, String> {
    let text = response
        .into_string()
        .map_err(|e| format!("reading response: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("response was not JSON: {e}"))
}

fn http_error(code: u16, response: ureq::Response) -> String {
    let text = response.into_string().unwrap_or_default();
    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
            return format!("{err} (HTTP {code})");
        }
    }
    format!("HTTP {code}")
}

fn parse_chat(value: &Value) -> Result<ChatDetail, String> {
    let messages = value
        .get("messages")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "chat response had no messages".to_string())?
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            Some(Message {
                id: obj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                role: obj
                    .get("role")
                    .and_then(|v| v.as_str())
                    .unwrap_or("assistant")
                    .to_string(),
                content: obj
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                created_at: obj
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                reaction: obj
                    .get("reaction")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                partial: obj
                    .get("partial")
                    .map(|v| v.as_bool().unwrap_or(false) || v.as_i64().unwrap_or(0) != 0)
                    .unwrap_or(false),
                source: message_source(obj.get("source")),
            })
        })
        .collect();
    let team: Vec<TeamEvent> = value
        .get("events")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| TeamEvent {
                    agent: item
                        .get("agent")
                        .and_then(|v| v.as_str())
                        .unwrap_or("sam")
                        .to_string(),
                    kind: item
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or("event")
                        .to_string(),
                    content: item
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    created_at: item
                        .get("created_at")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let events = team
        .iter()
        .map(|event| format!("{} {}: {}", event.agent, event.kind, event.content))
        .collect();
    let actions = status_view::parse_actions(value.get("actions"));
    Ok(ChatDetail {
        messages,
        events,
        team,
        actions,
        images: Vec::new(),
    })
}

/// Known client stamps. Anything else, including a missing field and
/// "unknown", draws nothing.
pub fn message_source(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(|v| v.as_str()).unwrap_or("").trim();
    match text {
        "dashboard" | "rust-cli" | "ts-cli" | "telegram" | "api" => Some(text.to_string()),
        _ => None,
    }
}

pub fn resolve_endpoint(base_url: &str, explicit: Option<String>) -> Result<Endpoint, String> {
    if !base_url.contains("://") {
        return Err("base URL needs a scheme, for example http://127.0.0.1:4317/sam".into());
    }
    let parsed = Url::parse(base_url).map_err(|e| format!("base URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("base URL must be http or https".into());
    }
    let origin = origin_of(&parsed)?;
    if let Some(from_url) = token_from_dashboard_url(base_url) {
        return Ok(Endpoint {
            origin,
            token: explicit.unwrap_or(from_url),
        });
    }
    if let Some(token) = explicit {
        return Ok(Endpoint { origin, token });
    }
    let path = parsed.path().trim_end_matches('/');
    if path.ends_with("/sam") {
        return follow_stable_door(base_url);
    }
    Err(
        "set SAM_TOKEN, or pass the /sam door (or the /dashboard/<token> URL) as SAM_BASE_URL"
            .into(),
    )
}

fn follow_stable_door(start: &str) -> Result<Endpoint, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .redirects(0)
        .build();
    let mut url = start.to_string();
    for _ in 0..5 {
        let (status, location) = match agent.get(&url).call() {
            Ok(response) => {
                let status = response.status();
                let location = response.header("location").map(|s| s.to_string());
                (status, location)
            }
            Err(ureq::Error::Status(status, response)) => {
                let location = response.header("location").map(|s| s.to_string());
                (status, location)
            }
            Err(err) => return Err(format!("stable door: {err}")),
        };
        if (300..400).contains(&status) {
            let location = location
                .ok_or_else(|| format!("stable door returned {status} without a Location"))?;
            let joined = Url::parse(&url)
                .map_err(|e| e.to_string())?
                .join(&location)
                .map_err(|e| format!("stable door Location: {e}"))?;
            url = joined.to_string();
            if let Some(token) = token_from_dashboard_url(&url) {
                return Ok(Endpoint {
                    origin: origin_of(&joined)?,
                    token,
                });
            }
            continue;
        }
        if let Some(token) = token_from_dashboard_url(&url) {
            let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
            return Ok(Endpoint {
                origin: origin_of(&parsed)?,
                token,
            });
        }
        return Err(format!(
            "stable door returned HTTP {status} and no dashboard token"
        ));
    }
    Err("stable door redirected too many times".into())
}

pub fn token_from_dashboard_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let mut segments = url.path_segments()?;
    let head = segments.next()?;
    let token = segments.next()?;
    if head == "dashboard" && segments.next().is_none() && is_token(token) {
        Some(token.to_string())
    } else {
        None
    }
}

fn is_token(value: &str) -> bool {
    let bytes = value.as_bytes();
    (16..=128).contains(&bytes.len()) && bytes.iter().all(|b| b.is_ascii_hexdigit())
}

fn origin_of(url: &Url) -> Result<String, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "base URL is missing a host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "base URL is missing a port".to_string())?;
    Ok(format!("{}://{host}:{port}", url.scheme()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn send_body_stamps_rust_cli() {
        let body = message_body("hello from the cli");
        assert_eq!(body["content"], "hello from the cli");
        assert_eq!(body["source"], "rust-cli");
    }

    #[test]
    fn dashboard_url_carries_its_own_token() {
        let endpoint = resolve_endpoint(
            "http://127.0.0.1:4317/dashboard/0123456789abcdef0123456789abcdef",
            None,
        )
        .unwrap();
        assert_eq!(endpoint.origin, "http://127.0.0.1:4317");
        assert_eq!(endpoint.token, "0123456789abcdef0123456789abcdef");
    }

    #[test]
    fn explicit_token_with_an_origin_does_not_need_the_door() {
        let endpoint = resolve_endpoint(
            "http://127.0.0.1:4317",
            Some("abcdefabcdefabcdefabcdefabcdefab".into()),
        )
        .unwrap();
        assert_eq!(endpoint.token, "abcdefabcdefabcdefabcdefabcdefab");
    }

    #[test]
    fn stable_door_redirect_is_followed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for _ in 0..4 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let req = String::from_utf8_lossy(&buf);
                let body = if req.contains("GET /sam ") || req.contains("GET /sam?") {
                    "HTTP/1.1 302 Found\r\nLocation: /dashboard/0123456789abcdef0123456789abcdef\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                };
                let _ = stream.write_all(body.as_bytes());
            }
        });
        let endpoint = resolve_endpoint(&format!("http://127.0.0.1:{port}/sam"), None).unwrap();
        assert_eq!(endpoint.origin, format!("http://127.0.0.1:{port}"));
        assert_eq!(endpoint.token, "0123456789abcdef0123456789abcdef");
    }

    #[test]
    fn errors_do_not_echo_the_token() {
        let client = Client::new(
            Endpoint {
                origin: "http://127.0.0.1:1".into(),
                token: "0123456789abcdef0123456789abcdef".into(),
            },
            None,
        );
        let err = client.status().unwrap_err();
        assert!(!err.contains("0123456789abcdef0123456789abcdef"), "{err}");
        assert!(err.contains("<token>") || err.contains("status") || !err.is_empty());
    }

    #[test]
    fn outgoing_messages_are_stamped_rust_cli() {
        let body = message_body("hello");
        assert_eq!(body["content"], "hello");
        assert_eq!(body["source"], "rust-cli");
        assert_eq!(
            message_source(Some(&serde_json::json!("rust-cli"))).as_deref(),
            Some("rust-cli")
        );
        assert!(message_source(None).is_none());
        assert!(message_source(Some(&serde_json::json!("unknown"))).is_none());
        assert!(message_source(Some(&serde_json::json!("browser"))).is_none());
    }

    #[test]
    fn partial_messages_and_tool_events_survive_the_parse() {
        let detail = parse_chat(&serde_json::json!({
            "messages": [
                {"id": "a", "role": "assistant", "content": "draft", "created_at": "", "partial": 1}
            ],
            "events": [
                {"agent": "sam", "kind": "tool", "content": "sam_code: requested", "created_at": "t"}
            ]
        }))
        .unwrap();
        assert!(detail.messages[0].partial);
        assert!(detail.messages[0].source.is_none());
        assert_eq!(detail.team[0].kind, "tool");
        assert!(detail.events[0].contains("sam_code"));
    }
}
