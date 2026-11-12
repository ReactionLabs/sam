//! Hermetic stand-in for the SAM dashboard HTTP API, plus ratatui
//! `TestBackend` snapshots.
//!
//! `FakeDashboard` binds `127.0.0.1:0` and speaks the routes `cli-rust`
//! already calls. `DashboardState::demo` also serves three fields the
//! real status document does not: `tools`, `usage.today`, and top-level
//! `channels`. `DashboardState::production` turns those off so a test
//! can assert the shape a live SAM actually returns. See `API.md`.
//!
//! The fixture never dials a model, a network host, or a credential.
//! Dropping it stops the accept thread.

use crate::api::{Client, Endpoint};
use crate::app::App;
use crate::ui;
use base64::{engine::general_purpose::STANDARD, Engine};
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::Terminal;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub const DEMO_TOKEN: &str = "0123456789abcdef0123456789abcdef";
pub const SMOKE_CHAT: &str = "11111111-1111-4111-8111-111111111111";
pub const SCRATCH_CHAT: &str = "11111111-1111-4111-8111-111111111112";
pub const PENDING_ACTION: &str = "22222222-2222-4222-8222-222222222222";
pub const DONE_ACTION: &str = "22222222-2222-4222-8222-222222222223";
pub const CONNECTOR_ID: &str = "44444444-4444-4444-8444-444444444444";

const AT: &str = "2026-11-12T04:00:00Z";
const HOLD_WAIT: Duration = Duration::from_secs(8);
const PIXEL_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const GENERIC_MESSAGE_ERROR: &str = "Message failed. Check model configuration and server logs.";

#[derive(Clone, Debug)]
pub struct UsageBucket {
    pub calls: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

impl UsageBucket {
    fn json(&self) -> Value {
        json!({
            "calls": self.calls,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "totalTokens": self.total_tokens,
        })
    }

    fn bump(&mut self) {
        self.calls += 1;
        self.prompt_tokens += 10;
        self.completion_tokens += 6;
        self.total_tokens += 16;
    }
}

#[derive(Clone, Debug)]
pub struct Usage {
    pub total: UsageBucket,
    pub today: UsageBucket,
    pub by_actor: Vec<(String, UsageBucket)>,
    pub by_model: Vec<(String, UsageBucket)>,
    pub by_route: Vec<(String, UsageBucket)>,
    pub by_tier: Vec<(String, UsageBucket)>,
    pub last_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub created_at: String,
    pub model: Option<String>,
    pub connector_id: Option<String>,
    pub provider: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
}

/// Proposed tools catalog. The real status document has no `tools` key.
#[derive(Clone, Debug)]
pub struct Tool {
    pub name: String,
    pub source: String,
    pub tier: String,
    pub description: String,
}

#[derive(Clone, Debug)]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub url: String,
    pub token_env: String,
    pub enabled: bool,
    pub allowed_tools: Vec<String>,
    pub credential_present: bool,
}

/// Proposed channel row. The real status document has `pairing`, not `channels`.
#[derive(Clone, Debug)]
pub struct Channel {
    pub name: String,
    pub kind: String,
    pub profile: String,
    pub enabled: bool,
    pub token_env: String,
}

#[derive(Clone, Debug)]
pub struct Pairing {
    pub channel: String,
    pub profile: String,
    pub owners: u64,
    pub locked_until: Option<String>,
}

#[derive(Clone, Debug)]
pub struct EngineTask {
    pub id: String,
    pub actor: String,
    pub chat_id: String,
    pub title: String,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct EngineView {
    pub installed: bool,
    pub binary: Option<String>,
    pub queued: u64,
    pub running: u64,
    pub done: u64,
    pub blocked: u64,
    pub failed: u64,
    pub connected: bool,
    pub stale: bool,
    pub auth_method: Option<String>,
    pub connected_at: Option<String>,
    pub recent: Vec<EngineTask>,
}

#[derive(Clone, Debug)]
pub struct ActivityLine {
    pub actor: String,
    pub kind: String,
    pub summary: String,
}

#[derive(Clone, Debug)]
pub struct FailureLine {
    pub actor: String,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct ModelRoute {
    pub route: String,
    pub model: String,
    pub tier: String,
    pub source: String,
}

#[derive(Clone, Debug)]
pub struct AuthView {
    pub provider: String,
    pub endpoint: String,
    pub key_env: String,
    /// `present` or `absent`. Never a key value.
    pub key: String,
    pub healthy: bool,
}

#[derive(Clone, Debug)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    pub reaction: Option<String>,
    pub partial: bool,
}

#[derive(Clone, Debug)]
pub struct TeamEvent {
    pub id: String,
    pub agent: String,
    pub kind: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct LastSkill {
    pub skill: String,
    pub at: String,
}

#[derive(Clone, Debug)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub agent_name: Option<String>,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_message_at: Option<String>,
    pub last_skill: Option<LastSkill>,
    pub messages: Vec<ChatMessage>,
    pub events: Vec<TeamEvent>,
}

#[derive(Clone, Debug)]
pub struct ActionRecord {
    pub id: String,
    pub actor: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub result: Option<String>,
    pub risk: Option<String>,
    pub chat_id: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
    pub decided_by: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DashboardState {
    pub at: String,
    pub default_agent: String,
    pub show_team_events: bool,
    /// When true, GET /api/status returns 500. The real server does this
    /// when the status read throws.
    pub unavailable: bool,
    /// Next successful reply. Read when the turn finishes, so a test can
    /// change it while a held turn is open.
    pub reply: String,
    /// Consumed by the next message POST. Known model errors pass through;
    /// anything else is replaced with the dashboard's generic message.
    pub fail_next: Option<String>,
    /// Real status omits `tools`. On in [`Self::demo`].
    pub serve_tools: bool,
    /// Real status omits `usage.today` (usage is the whole ledger). On in [`Self::demo`].
    pub serve_usage_today: bool,
    /// Real status omits a top-level `channels` array. On in [`Self::demo`].
    pub serve_channels: bool,
    pub profiles: Vec<Profile>,
    pub chats: Vec<Chat>,
    pub actions: Vec<ActionRecord>,
    pub skills: Vec<Skill>,
    pub tools: Vec<Tool>,
    pub connectors: Vec<Connector>,
    pub channels: Vec<Channel>,
    pub pairing: Vec<Pairing>,
    pub engine: EngineView,
    pub usage: Usage,
    pub activity: Vec<ActivityLine>,
    pub failures: Vec<FailureLine>,
    pub models: Vec<ModelRoute>,
    pub auth: AuthView,
    seq: u64,
}

impl DashboardState {
    /// Demo workspace: profiles dip, trading, and second-shift, one pinned
    /// chat, one pending approval, and the proposed status fields turned on.
    pub fn demo() -> Self {
        let bucket = |calls, prompt, completion, total| UsageBucket {
            calls,
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: total,
        };
        Self {
            at: AT.into(),
            default_agent: "dip".into(),
            show_team_events: true,
            unavailable: false,
            reply: "Noted.".into(),
            fail_next: None,
            serve_tools: true,
            serve_usage_today: true,
            serve_channels: true,
            profiles: vec![
                Profile {
                    id: "55555555-5555-4555-8555-555555555551".into(),
                    name: "dip".into(),
                    instructions: "Dip's SAM".into(),
                    created_at: "2026-11-01T00:00:00Z".into(),
                    model: Some("grok-4".into()),
                    connector_id: None,
                    provider: None,
                },
                Profile {
                    id: "55555555-5555-4555-8555-555555555552".into(),
                    name: "trading".into(),
                    instructions: "Trading desk".into(),
                    created_at: "2026-11-01T00:00:00Z".into(),
                    model: Some("grok-4".into()),
                    connector_id: None,
                    provider: None,
                },
                Profile {
                    id: "55555555-5555-4555-8555-555555555553".into(),
                    name: "second-shift".into(),
                    instructions: "Second Shift".into(),
                    created_at: "2026-11-01T00:00:00Z".into(),
                    model: Some("grok-4".into()),
                    connector_id: Some(CONNECTOR_ID.into()),
                    provider: None,
                },
            ],
            chats: vec![
                Chat {
                    id: SCRATCH_CHAT.into(),
                    title: "Scratch".into(),
                    agent_name: Some("trading".into()),
                    pinned: false,
                    created_at: "2026-11-12T02:00:00Z".into(),
                    updated_at: "2026-11-12T03:30:00Z".into(),
                    last_message_at: None,
                    last_skill: None,
                    messages: Vec::new(),
                    events: Vec::new(),
                },
                Chat {
                    id: SMOKE_CHAT.into(),
                    title: "Smoke".into(),
                    agent_name: Some("dip".into()),
                    pinned: true,
                    created_at: "2026-11-12T01:00:00Z".into(),
                    updated_at: "2026-11-12T03:00:00Z".into(),
                    last_message_at: Some("2026-11-12T03:10:00Z".into()),
                    last_skill: Some(LastSkill {
                        skill: "agent-reach".into(),
                        at: "2026-11-12T03:09:00Z".into(),
                    }),
                    messages: vec![
                        ChatMessage {
                            id: "66666666-6666-4666-8666-666666666661".into(),
                            role: "user".into(),
                            content: "Status?".into(),
                            created_at: "2026-11-12T03:10:00Z".into(),
                            reaction: Some("❤️".into()),
                            partial: false,
                        },
                        ChatMessage {
                            id: "66666666-6666-4666-8666-666666666662".into(),
                            role: "assistant".into(),
                            content: "The ledger is quiet.".into(),
                            created_at: "2026-11-12T03:10:08Z".into(),
                            reaction: None,
                            partial: false,
                        },
                    ],
                    events: vec![TeamEvent {
                        id: "77777777-7777-4777-8777-777777777771".into(),
                        agent: "dip".into(),
                        kind: "tool".into(),
                        content: "checked the ledger".into(),
                        created_at: "2026-11-12T03:10:04Z".into(),
                    }],
                },
            ],
            actions: vec![
                ActionRecord {
                    id: PENDING_ACTION.into(),
                    actor: "dip".into(),
                    kind: "note".into(),
                    title: "Save the ledger note".into(),
                    detail: "Remember the quiet ledger".into(),
                    status: "pending".into(),
                    result: None,
                    risk: Some("internal".into()),
                    chat_id: Some(SMOKE_CHAT.into()),
                    created_at: "2026-11-12T03:11:00Z".into(),
                    decided_at: None,
                    decided_by: None,
                },
                ActionRecord {
                    id: DONE_ACTION.into(),
                    actor: "dip".into(),
                    kind: "law".into(),
                    title: "Keep replies short".into(),
                    detail: "Short replies".into(),
                    status: "done".into(),
                    result: Some("saved".into()),
                    risk: Some("internal".into()),
                    chat_id: Some(SMOKE_CHAT.into()),
                    created_at: "2026-11-12T02:00:00Z".into(),
                    decided_at: Some("2026-11-12T02:01:00Z".into()),
                    decided_by: Some("owner".into()),
                },
            ],
            skills: vec![Skill {
                name: "agent-reach".into(),
                description: "Search the web and supported platforms".into(),
                path: "skills/agent-reach/SKILL.md".into(),
                source: "skills".into(),
            }],
            tools: vec![
                Tool {
                    name: "sam_memory_search".into(),
                    source: "own".into(),
                    tier: "core".into(),
                    description: "Search memory this profile can see".into(),
                },
                Tool {
                    name: "pipeline_summary".into(),
                    source: "connector:second-shift".into(),
                    tier: "connector".into(),
                    description: "Read the Second Shift pipeline summary".into(),
                },
            ],
            connectors: vec![Connector {
                id: CONNECTOR_ID.into(),
                name: "Second Shift".into(),
                url: "https://mcp.secondshiftos.com/mcp".into(),
                token_env: "SAM_MCP_TOKEN_SHIFT".into(),
                enabled: true,
                allowed_tools: vec![
                    "whoami".into(),
                    "pipeline_summary".into(),
                    "list_leads".into(),
                ],
                credential_present: true,
            }],
            channels: vec![Channel {
                name: "desk".into(),
                kind: "telegram".into(),
                profile: "dip".into(),
                enabled: true,
                token_env: "SAM_CHANNEL_DESK".into(),
            }],
            pairing: vec![Pairing {
                channel: "desk".into(),
                profile: "dip".into(),
                owners: 1,
                locked_until: None,
            }],
            engine: EngineView {
                installed: true,
                binary: Some("claude".into()),
                queued: 0,
                running: 1,
                done: 3,
                blocked: 0,
                failed: 0,
                connected: true,
                stale: false,
                auth_method: Some("claude.ai".into()),
                connected_at: Some("2026-11-11T12:00:00Z".into()),
                recent: vec![EngineTask {
                    id: "88888888-8888-4888-8888-888888888881".into(),
                    actor: "dip".into(),
                    chat_id: SMOKE_CHAT.into(),
                    title: "status line".into(),
                    status: "running".into(),
                }],
            },
            usage: Usage {
                total: bucket(12, 800, 400, 1200),
                today: bucket(4, 200, 120, 320),
                by_actor: vec![
                    ("dip".into(), bucket(9, 600, 300, 900)),
                    ("trading".into(), bucket(2, 140, 60, 200)),
                    ("second-shift".into(), bucket(1, 60, 40, 100)),
                ],
                by_model: vec![("grok-4".into(), bucket(12, 800, 400, 1200))],
                by_route: vec![("chat".into(), bucket(12, 800, 400, 1200))],
                by_tier: vec![("main".into(), bucket(12, 800, 400, 1200))],
                last_at: Some("2026-11-12T03:50:00Z".into()),
            },
            activity: vec![ActivityLine {
                actor: "dip".into(),
                kind: "turn".into(),
                summary: "Answered in chat 11111111".into(),
            }],
            failures: Vec::new(),
            models: vec![
                ModelRoute {
                    route: "heartbeat".into(),
                    model: "grok-cheap".into(),
                    tier: "cheap".into(),
                    source: "cheap-env".into(),
                },
                ModelRoute {
                    route: "chat".into(),
                    model: "grok-4".into(),
                    tier: "main".into(),
                    source: "main-env".into(),
                },
                ModelRoute {
                    route: "background".into(),
                    model: "grok-4".into(),
                    tier: "deep".into(),
                    source: "main-env".into(),
                },
            ],
            auth: AuthView {
                provider: "generic".into(),
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                key_env: "SAM_MODEL_API_KEY".into(),
                key: "present".into(),
                healthy: true,
            },
            seq: 0,
        }
    }

    /// [`Self::demo`] with the three unshipped status fields omitted.
    pub fn production() -> Self {
        let mut state = Self::demo();
        state.serve_tools = false;
        state.serve_usage_today = false;
        state.serve_channels = false;
        state
    }

    pub fn mint(&mut self) -> String {
        self.seq += 1;
        format!("33333333-3333-4333-8333-{:012x}", self.seq)
    }

    pub fn chat_mut(&mut self, id: &str) -> Option<&mut Chat> {
        self.chats.iter_mut().find(|chat| chat.id == id)
    }

    fn known_profile(&self, name: &str) -> bool {
        name == "sam" || self.profiles.iter().any(|profile| profile.name == name)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub dashboard_header: Option<String>,
    pub body: String,
}

struct GateInner {
    armed: bool,
    release: bool,
    waiting: bool,
    chat_id: Option<String>,
    staged_partial: Option<String>,
}

struct TurnGate {
    inner: Mutex<GateInner>,
    cv: Condvar,
}

struct Parts {
    state: Arc<Mutex<DashboardState>>,
    gate: Arc<TurnGate>,
    inflight: Arc<Mutex<HashSet<String>>>,
    log: Arc<Mutex<Vec<RecordedRequest>>>,
    token: String,
}

pub struct FakeDashboard {
    origin: String,
    token: String,
    addr: SocketAddr,
    state: Arc<Mutex<DashboardState>>,
    gate: Arc<TurnGate>,
    shutdown: Arc<AtomicBool>,
    log: Arc<Mutex<Vec<RecordedRequest>>>,
    accept: Option<JoinHandle<()>>,
}

impl FakeDashboard {
    pub fn spawn() -> Self {
        Self::spawn_with(DashboardState::demo())
    }

    pub fn spawn_production() -> Self {
        Self::spawn_with(DashboardState::production())
    }

    pub fn spawn_with(state: DashboardState) -> Self {
        let token = DEMO_TOKEN.to_string();
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind dashboard fixture");
        let addr = listener.local_addr().expect("fixture address");
        let origin = format!("http://127.0.0.1:{}", addr.port());
        let state = Arc::new(Mutex::new(state));
        let gate = Arc::new(TurnGate {
            inner: Mutex::new(GateInner {
                armed: false,
                release: false,
                waiting: false,
                chat_id: None,
                staged_partial: None,
            }),
            cv: Condvar::new(),
        });
        let inflight = Arc::new(Mutex::new(HashSet::new()));
        let log = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let parts = Parts {
            state: Arc::clone(&state),
            gate: Arc::clone(&gate),
            inflight,
            log: Arc::clone(&log),
            token: token.clone(),
        };
        let flag = Arc::clone(&shutdown);
        let accept = thread::Builder::new()
            .name("sam-fixture".into())
            .spawn(move || accept_loop(listener, parts, flag))
            .expect("fixture thread");
        Self {
            origin,
            token,
            addr,
            state,
            gate,
            shutdown,
            log,
            accept: Some(accept),
        }
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn door_url(&self) -> String {
        format!("{}/sam", self.origin)
    }

    pub fn dashboard_url(&self) -> String {
        format!("{}/dashboard/{}", self.origin, self.token)
    }

    pub fn endpoint(&self) -> Endpoint {
        Endpoint {
            origin: self.origin.clone(),
            token: self.token.clone(),
        }
    }

    pub fn client(&self) -> Client {
        Client::new(self.endpoint(), None)
    }

    pub fn update<R>(&self, f: impl FnOnce(&mut DashboardState) -> R) -> R {
        let mut guard = lock(&self.state);
        f(&mut guard)
    }

    pub fn status_json(&self) -> Value {
        build_status(&lock(&self.state))
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        lock(&self.log).clone()
    }

    /// The next `POST .../messages` stays open until [`Self::release_turn`].
    /// `GET` of that chat meanwhile shows the user message with the eyes
    /// reaction, and any [`Self::push_partial`] text as `partial: 1`.
    pub fn hold_next_turn(&self) {
        let mut gate = lock(&self.gate.inner);
        gate.armed = true;
        gate.release = false;
    }

    pub fn turn_is_waiting(&self) -> bool {
        lock(&self.gate.inner).waiting
    }

    /// Accumulated assistant text, matching the dashboard's partial row.
    /// Before the turn is waiting, the text is staged and applied when the
    /// hold begins.
    pub fn push_partial(&self, text: &str) {
        let chat_id = {
            let mut gate = lock(&self.gate.inner);
            if gate.waiting {
                gate.chat_id.clone()
            } else {
                gate.staged_partial = Some(text.to_string());
                None
            }
        };
        if let Some(chat_id) = chat_id {
            self.update(|state| write_partial(state, &chat_id, text));
        }
    }

    pub fn release_turn(&self) {
        let mut gate = lock(&self.gate.inner);
        gate.release = true;
        gate.armed = false;
        self.gate.cv.notify_all();
    }

    pub fn get_json(&self, path: &str) -> (u16, Value) {
        let url = format!("{}{path}", self.origin);
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(5))
            .redirects(0)
            .build();
        match agent.get(&url).call() {
            Ok(response) => read_value(response.status(), response),
            Err(ureq::Error::Status(code, response)) => read_value(code, response),
            Err(_) => (0, Value::Null),
        }
    }

    pub fn post_json(&self, path: &str, body: &Value) -> (u16, Value) {
        self.post_body(path, &body.to_string(), true)
    }

    pub fn post_without_dashboard_header(&self, path: &str, body: &Value) -> (u16, Value) {
        self.post_body(path, &body.to_string(), false)
    }

    fn post_body(&self, path: &str, body: &str, dashboard: bool) -> (u16, Value) {
        let url = format!("{}{path}", self.origin);
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(5))
            .redirects(0)
            .build();
        let mut request = agent.post(&url).set("Content-Type", "application/json");
        if dashboard {
            request = request.set("X-SAM-Request", "dashboard");
        }
        match request.send_string(body) {
            Ok(response) => read_value(response.status(), response),
            Err(ureq::Error::Status(code, response)) => read_value(code, response),
            Err(_) => (0, Value::Null),
        }
    }
}

impl Drop for FakeDashboard {
    fn drop(&mut self) {
        self.release_turn();
        self.shutdown.store(true, Ordering::SeqCst);
        if let Ok(mut stream) = TcpStream::connect(self.addr) {
            let _ = stream.write_all(
                b"GET /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            );
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        if let Some(handle) = self.accept.take() {
            let _ = handle.join();
        }
    }
}

fn read_value(status: u16, response: ureq::Response) -> (u16, Value) {
    let text = response.into_string().unwrap_or_default();
    let value = serde_json::from_str(&text).unwrap_or(Value::Null);
    (status, value)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn accept_loop(listener: TcpListener, parts: Parts, shutdown: Arc<AtomicBool>) {
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        let (stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(_) => break,
        };
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        let parts = Parts {
            state: Arc::clone(&parts.state),
            gate: Arc::clone(&parts.gate),
            inflight: Arc::clone(&parts.inflight),
            log: Arc::clone(&parts.log),
            token: parts.token.clone(),
        };
        thread::spawn(move || {
            let _ = handle_connection(stream, &parts);
        });
    }
}

fn handle_connection(mut stream: TcpStream, parts: &Parts) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let Some(request) = read_request(&mut stream)? else {
        return Ok(());
    };
    {
        let mut log = lock(&parts.log);
        if log.len() < 200 {
            log.push(RecordedRequest {
                method: request.method.clone(),
                path: request.path.clone(),
                dashboard_header: header(&request, "x-sam-request").map(str::to_string),
                body: request.body.clone(),
            });
        }
    }
    let response = if is_message_post(&request, &parts.token) {
        message_turn(parts, &request)
    } else {
        dispatch(parts, &request)
    };
    write_response(&mut stream, &response)
}

struct Request {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    body: String,
}

struct Response {
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    location: Option<String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    let header_end = loop {
        if buf.len() > 64 * 1024 {
            return Ok(None);
        }
        let n = match stream.read(&mut tmp) {
            Ok(0) => return Ok(None),
            Ok(n) => n,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
            Err(err) if err.kind() == std::io::ErrorKind::TimedOut => return Ok(None),
            Err(err) => return Err(err),
        };
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let Some(start) = lines.next() else {
        return Ok(None);
    };
    let mut start_parts = start.split_whitespace();
    let Some(method) = start_parts.next() else {
        return Ok(None);
    };
    let Some(target) = start_parts.next() else {
        return Ok(None);
    };
    let (path, query) = split_target(target);
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let content_length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0)
        .min(20_000);
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);
    Ok(Some(Request {
        method: method.to_string(),
        path,
        query,
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    }))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn split_target(target: &str) -> (String, Vec<(String, String)>) {
    let (path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let query = raw_query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect();
    (path.to_string(), query)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn query<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .query
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn write_response(stream: &mut TcpStream, response: &Response) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n",
        response.status,
        response.reason,
        response.body.len()
    );
    if !response.content_type.is_empty() {
        head.push_str(&format!("Content-Type: {}\r\n", response.content_type));
    }
    if let Some(location) = &response.location {
        head.push_str(&format!("Location: {location}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&response.body)?;
    Ok(())
}

fn empty(status: u16) -> Response {
    Response {
        status,
        reason: reason(status),
        content_type: "",
        location: None,
        body: Vec::new(),
    }
}

fn json_response(status: u16, value: &Value) -> Response {
    Response {
        status,
        reason: reason(status),
        content_type: "application/json",
        location: None,
        body: serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn is_message_post(request: &Request, token: &str) -> bool {
    request.method == "POST" && chat_message_id(&request.path, token).is_some()
}

fn chat_message_id<'a>(path: &'a str, token: &str) -> Option<&'a str> {
    let rest = path.strip_prefix("/api/")?.strip_prefix(token)?;
    let rest = rest.strip_prefix("/chats/")?;
    let (id, tail) = rest.split_once('/')?;
    if tail == "messages" && is_id(id) {
        Some(id)
    } else {
        None
    }
}

fn is_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn dispatch(parts: &Parts, request: &Request) -> Response {
    let path = request.path.as_str();
    let token = parts.token.as_str();
    if request.method == "GET" && (path == "/sam" || path == "/sam/") {
        return Response {
            status: 302,
            reason: "Found",
            content_type: "",
            location: Some(format!("/dashboard/{token}")),
            body: Vec::new(),
        };
    }
    if request.method == "GET" && path == format!("/dashboard/{token}") {
        return Response {
            status: 200,
            reason: "OK",
            content_type: "text/html; charset=utf-8",
            location: None,
            body: b"<!doctype html><title>SAM</title>".to_vec(),
        };
    }
    if request.method == "GET" && path == "/media/pixel.png" {
        let bytes = STANDARD.decode(PIXEL_PNG_B64).unwrap_or_default();
        return Response {
            status: 200,
            reason: "OK",
            content_type: "image/png",
            location: None,
            body: bytes,
        };
    }
    if request.method == "GET" && (path == format!("/api/status/{token}") || path == "/api/status")
    {
        if path == "/api/status" && !status_authorized(request, token) {
            return empty(401);
        }
        let state = lock(&parts.state);
        if state.unavailable {
            return json_response(500, &json!({"error": "Dashboard data unavailable"}));
        }
        let mut body = build_status(&state);
        if let Some(actor) = query(request, "actor") {
            if let Some(rows) = body
                .get_mut("activity")
                .and_then(|value| value.as_array_mut())
            {
                rows.retain(|row| row.get("actor").and_then(|v| v.as_str()) == Some(actor));
            }
        }
        return json_response(200, &body);
    }
    if request.method == "GET" {
        if let Some(id) = chat_get_id(path, token) {
            let state = lock(&parts.state);
            return match state.chats.iter().find(|chat| chat.id == id) {
                Some(chat) => json_response(200, &chat_detail(&state, chat)),
                None => json_response(404, &json!({"error": "Chat not found"})),
            };
        }
    }
    if request.method == "POST" && path == format!("/api/{token}/chats") {
        return create_chat(parts, request);
    }
    if request.method == "POST" && path == format!("/api/{token}/config") {
        return save_config(parts, request);
    }
    if request.method == "POST" {
        if let Some(id) = action_id(path, token) {
            return decide(parts, request, id);
        }
        if let Some(id) = chat_profile_id(path, token) {
            return set_profile(parts, request, id);
        }
    }
    if request.method != "GET" && request.method != "POST" {
        return empty(405);
    }
    empty(404)
}

fn status_authorized(request: &Request, token: &str) -> bool {
    header(request, "authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value == token)
        .unwrap_or(false)
        || query(request, "token") == Some(token)
}

fn chat_get_id<'a>(path: &'a str, token: &str) -> Option<&'a str> {
    let rest = path
        .strip_prefix("/api/")?
        .strip_prefix(token)?
        .strip_prefix("/chats/")?;
    if is_id(rest) && !rest.contains('/') {
        Some(rest)
    } else {
        None
    }
}

fn action_id<'a>(path: &'a str, token: &str) -> Option<&'a str> {
    let rest = path
        .strip_prefix("/api/")?
        .strip_prefix(token)?
        .strip_prefix("/actions/")?;
    let (id, tail) = rest.split_once('/')?;
    if tail == "decide" && is_id(id) {
        Some(id)
    } else {
        None
    }
}

fn chat_profile_id<'a>(path: &'a str, token: &str) -> Option<&'a str> {
    let rest = path
        .strip_prefix("/api/")?
        .strip_prefix(token)?
        .strip_prefix("/chats/")?;
    let (id, tail) = rest.split_once('/')?;
    if tail == "profile" && is_id(id) {
        Some(id)
    } else {
        None
    }
}

fn message_turn(parts: &Parts, request: &Request) -> Response {
    let Some(chat_id) = chat_message_id(&request.path, &parts.token) else {
        return empty(404);
    };
    let chat_id = chat_id.to_string();
    let body = match read_post(request) {
        Ok(body) => body,
        Err(_) => return json_response(400, &json!({"error": GENERIC_MESSAGE_ERROR})),
    };
    let content = match body.get("content").and_then(|value| value.as_str()) {
        Some(content) if !content.trim().is_empty() && content.len() <= 12_000 => {
            content.to_string()
        }
        _ => return json_response(400, &json!({"error": GENERIC_MESSAGE_ERROR})),
    };
    {
        let state = lock(&parts.state);
        if !state.chats.iter().any(|chat| chat.id == chat_id) {
            return json_response(404, &json!({"error": "Chat not found"}));
        }
    }
    {
        let mut inflight = lock(&parts.inflight);
        if !inflight.insert(chat_id.clone()) {
            return json_response(
                409,
                &json!({"error": "This chat already has a response in progress"}),
            );
        }
    }
    let _guard = InflightGuard {
        inflight: Arc::clone(&parts.inflight),
        id: chat_id.clone(),
    };
    let fail = {
        let mut state = lock(&parts.state);
        let created_at = state.at.clone();
        let id = state.mint();
        if let Some(chat) = state.chat_mut(&chat_id) {
            chat.messages.push(ChatMessage {
                id,
                role: "user".into(),
                content,
                created_at: created_at.clone(),
                reaction: Some("👀".into()),
                partial: false,
            });
            chat.updated_at = created_at.clone();
            chat.last_message_at = Some(created_at);
        }
        state.fail_next.take()
    };
    if let Some(reason) = fail {
        clear_eyes(parts, &chat_id);
        return json_response(400, &json!({"error": public_model_error(&reason)}));
    }
    let hold = {
        let mut gate = lock(&parts.gate.inner);
        if gate.armed {
            gate.armed = false;
            true
        } else {
            false
        }
    };
    if hold {
        let staged = {
            let mut gate = lock(&parts.gate.inner);
            let staged = gate.staged_partial.take();
            gate.chat_id = Some(chat_id.clone());
            gate.waiting = true;
            staged
        };
        if let Some(text) = staged {
            parts_write_partial(parts, &chat_id, &text);
        }
        let timed_out = wait_for_release(&parts.gate);
        {
            let mut gate = lock(&parts.gate.inner);
            gate.waiting = false;
            gate.chat_id = None;
        }
        if timed_out {
            clear_eyes(parts, &chat_id);
            return json_response(400, &json!({"error": "Model request timed out"}));
        }
    }
    finish_turn(parts, &chat_id)
}

struct InflightGuard {
    inflight: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        lock(&self.inflight).remove(&self.id);
    }
}

fn wait_for_release(gate: &TurnGate) -> bool {
    let mut inner = lock(&gate.inner);
    let started = std::time::Instant::now();
    while !inner.release {
        let left = HOLD_WAIT.saturating_sub(started.elapsed());
        if left.is_zero() {
            return true;
        }
        let (guard, timeout) = gate.cv.wait_timeout(inner, left).unwrap_or_else(|poison| {
            let (guard, timeout) = poison.into_inner();
            (guard, timeout)
        });
        inner = guard;
        if timeout.timed_out() && !inner.release {
            return true;
        }
    }
    inner.release = false;
    false
}

fn parts_write_partial(parts: &Parts, chat_id: &str, text: &str) {
    let mut state = lock(&parts.state);
    write_partial(&mut state, chat_id, text);
}

fn write_partial(state: &mut DashboardState, chat_id: &str, text: &str) {
    let Some(index) = state.chats.iter().position(|chat| chat.id == chat_id) else {
        return;
    };
    if let Some(message_index) = state.chats[index]
        .messages
        .iter()
        .rposition(|message| message.role == "assistant" && message.partial)
    {
        state.chats[index].messages[message_index].content = text.to_string();
        return;
    }
    let created_at = state.at.clone();
    let id = state.mint();
    state.chats[index].messages.push(ChatMessage {
        id,
        role: "assistant".into(),
        content: text.to_string(),
        created_at,
        reaction: None,
        partial: true,
    });
}

fn clear_eyes(parts: &Parts, chat_id: &str) {
    let mut state = lock(&parts.state);
    if let Some(chat) = state.chat_mut(chat_id) {
        if let Some(message) = chat
            .messages
            .iter_mut()
            .rev()
            .find(|message| message.role == "user")
        {
            if message.reaction.as_deref() == Some("👀") {
                message.reaction = None;
            }
        }
    }
}

fn finish_turn(parts: &Parts, chat_id: &str) -> Response {
    let mut state = lock(&parts.state);
    let reply = state.reply.clone();
    let created_at = state.at.clone();
    let assistant_id = state.mint();
    let mut user_reaction = None;
    if let Some(chat) = state.chat_mut(chat_id) {
        if let Some(message) = chat
            .messages
            .iter_mut()
            .rev()
            .find(|message| message.role == "user")
        {
            if message.reaction.as_deref() == Some("👀") {
                message.reaction = Some("❤️".into());
                user_reaction = Some("❤️".to_string());
            } else {
                user_reaction = message.reaction.clone();
            }
        }
        if let Some(partial) = chat
            .messages
            .iter_mut()
            .rev()
            .find(|message| message.role == "assistant" && message.partial)
        {
            partial.content = reply.clone();
            partial.partial = false;
        } else {
            chat.messages.push(ChatMessage {
                id: assistant_id,
                role: "assistant".into(),
                content: reply.clone(),
                created_at: created_at.clone(),
                reaction: None,
                partial: false,
            });
        }
        chat.updated_at = created_at.clone();
        chat.last_message_at = Some(created_at);
    }
    state.usage.total.bump();
    state.usage.today.bump();
    state.usage.last_at = Some(state.at.clone());
    let actor = state
        .chats
        .iter()
        .find(|chat| chat.id == chat_id)
        .and_then(|chat| chat.agent_name.clone())
        .unwrap_or_else(|| "sam".into());
    if let Some((_, bucket)) = state
        .usage
        .by_actor
        .iter_mut()
        .find(|(name, _)| name == &actor)
    {
        bucket.bump();
    }
    state.activity.push(ActivityLine {
        actor,
        kind: "turn".into(),
        summary: format!("Answered in chat {}", &chat_id[..8]),
    });
    json_response(
        200,
        &json!({
            "reply": {"role": "assistant", "content": reply},
            "userReaction": user_reaction,
            "actions": [],
        }),
    )
}

fn public_model_error(raw: &str) -> String {
    const KNOWN: &[&str] = &[
        "Model not configured",
        "Chat history limit reached",
        "Remote model requires an API key",
        "Model request timed out",
        "Model network request failed",
        "Invalid model response content",
        "Model returned no safe visible content",
        "Model returned unterminated reasoning content",
        "Invalid model JSON response",
        "Model response too large",
        "Empty model response",
        "Unsafe model output",
        "Profile connector unavailable",
    ];
    if KNOWN.contains(&raw) {
        return raw.to_string();
    }
    if let Some(rest) = raw.strip_prefix("Model request failed (HTTP ") {
        if rest.len() == 4
            && rest.ends_with(')')
            && rest.as_bytes()[..3]
                .iter()
                .all(|byte| byte.is_ascii_digit())
        {
            return raw.to_string();
        }
    }
    GENERIC_MESSAGE_ERROR.to_string()
}

enum PostError {
    Rejected,
}

fn read_post(request: &Request) -> Result<Value, PostError> {
    if header(request, "x-sam-request") != Some("dashboard") {
        return Err(PostError::Rejected);
    }
    let content_type = header(request, "content-type").unwrap_or("");
    if !content_type.starts_with("application/json") {
        return Err(PostError::Rejected);
    }
    if request.body.len() > 16_000 {
        return Err(PostError::Rejected);
    }
    let value: Value = serde_json::from_str(&request.body).map_err(|_| PostError::Rejected)?;
    if !value.is_object() {
        return Err(PostError::Rejected);
    }
    Ok(value)
}

fn create_chat(parts: &Parts, request: &Request) -> Response {
    let body = match read_post(request) {
        Ok(body) => body,
        Err(_) => return json_response(400, &json!({"error": "Unable to create chat"})),
    };
    let Some(title) = body.get("title").and_then(|value| value.as_str()) else {
        return json_response(400, &json!({"error": "Unable to create chat"}));
    };
    let title = title.trim();
    if title.is_empty() || title.len() > 120 {
        return json_response(400, &json!({"error": "Unable to create chat"}));
    }
    let mut state = lock(&parts.state);
    let agent_name = match body.get("agent") {
        None => None,
        Some(value) if value.as_str() == Some("sam") => None,
        Some(value) => {
            let Some(name) = value.as_str() else {
                return json_response(400, &json!({"error": "Unable to create chat"}));
            };
            if !state.known_profile(name) || !valid_profile_name(name) {
                return json_response(400, &json!({"error": "Unable to create chat"}));
            }
            Some(name.to_string())
        }
    };
    let now = state.at.clone();
    let id = state.mint();
    let record = json!({
        "id": id.clone(),
        "title": title,
        "created_at": now.clone(),
        "updated_at": now.clone(),
        "agent_name": agent_name.clone(),
        "pinned": 0,
        "visitor": 0,
        "archived": 0,
    });
    state.chats.push(Chat {
        id: id.clone(),
        title: title.to_string(),
        agent_name,
        pinned: false,
        created_at: now.clone(),
        updated_at: now,
        last_message_at: None,
        last_skill: None,
        messages: Vec::new(),
        events: Vec::new(),
    });
    json_response(201, &record)
}

fn save_config(parts: &Parts, request: &Request) -> Response {
    let body = match read_post(request) {
        Ok(body) => body,
        Err(_) => return json_response(400, &json!({"error": "Invalid configuration"})),
    };
    let Some(object) = body.as_object() else {
        return json_response(400, &json!({"error": "Invalid configuration"}));
    };
    if object
        .keys()
        .any(|key| key != "defaultAgent" && key != "showTeamEvents")
    {
        return json_response(400, &json!({"error": "Invalid configuration"}));
    }
    let Some(agent) = object.get("defaultAgent").and_then(|value| value.as_str()) else {
        return json_response(400, &json!({"error": "Invalid configuration"}));
    };
    let Some(show) = object
        .get("showTeamEvents")
        .and_then(|value| value.as_bool())
    else {
        return json_response(400, &json!({"error": "Invalid configuration"}));
    };
    if !valid_profile_name(agent) {
        return json_response(400, &json!({"error": "Invalid configuration"}));
    }
    let mut state = lock(&parts.state);
    if !state.known_profile(agent) {
        return json_response(400, &json!({"error": "Invalid configuration"}));
    }
    state.default_agent = agent.to_string();
    state.show_team_events = show;
    json_response(
        200,
        &json!({"defaultAgent": state.default_agent, "showTeamEvents": state.show_team_events}),
    )
}

fn set_profile(parts: &Parts, request: &Request, chat_id: &str) -> Response {
    let body = match read_post(request) {
        Ok(body) => body,
        Err(_) => return json_response(400, &json!({"error": "Unable to update chat"})),
    };
    // null and "sam" both pin the chat back to the core profile, which the
    // status parser reads as agent "sam".
    let stored = match body.get("agent") {
        Some(Value::Null) => None,
        Some(Value::String(name)) if name == "sam" => None,
        Some(Value::String(name)) => Some(name.clone()),
        _ => return json_response(404, &json!({"error": "Chat not found or invalid input"})),
    };
    let mut state = lock(&parts.state);
    if let Some(name) = &stored {
        if !state.known_profile(name) || !valid_profile_name(name) {
            return json_response(404, &json!({"error": "Chat not found or invalid input"}));
        }
    }
    let now = state.at.clone();
    let Some(chat) = state.chat_mut(chat_id) else {
        return json_response(404, &json!({"error": "Chat not found or invalid input"}));
    };
    chat.agent_name = stored;
    chat.updated_at = now;
    json_response(200, &json!({"ok": true}))
}

fn decide(parts: &Parts, request: &Request, action_id: &str) -> Response {
    let body = match read_post(request) {
        Ok(body) => body,
        Err(_) => return json_response(400, &json!({"error": "Invalid action decision"})),
    };
    let decision = body.get("decision").and_then(|value| value.as_str());
    let approve = match decision {
        Some("approve") => true,
        Some("reject") => false,
        _ => return json_response(400, &json!({"error": "Invalid action decision"})),
    };
    let mut state = lock(&parts.state);
    let now = state.at.clone();
    let Some(action) = state
        .actions
        .iter_mut()
        .find(|action| action.id == action_id)
    else {
        return json_response(400, &json!({"error": "Invalid action decision"}));
    };
    action.status = if approve { "done" } else { "rejected" }.into();
    action.result = Some(if approve { "recorded" } else { "rejected" }.into());
    action.decided_at = Some(now);
    action.decided_by = Some("owner".into());
    json_response(200, &action_json(action))
}

fn valid_profile_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

fn build_status(state: &DashboardState) -> Value {
    let mut body = json!({
        "ok": true,
        "at": state.at,
        "chats": state.chats.iter().map(chat_summary).collect::<Vec<_>>(),
        "actions": state.actions.iter().map(action_json).collect::<Vec<_>>(),
        "agents": state.profiles.iter().map(profile_json).collect::<Vec<_>>(),
        "config": {"defaultAgent": state.default_agent, "showTeamEvents": state.show_team_events},
        "skills": state.skills.iter().map(skill_json).collect::<Vec<_>>(),
        "connectors": state.connectors.iter().map(connector_json).collect::<Vec<_>>(),
        "pairing": state.pairing.iter().map(pairing_json).collect::<Vec<_>>(),
        "models": state.models.iter().map(model_json).collect::<Vec<_>>(),
        "usage": usage_json(state),
        "engine": engine_json(&state.engine),
        "auth": auth_json(state),
        "activity": filtered_activity(state, None),
        "failures": state.failures.iter().map(|failure| json!({
            "actor": failure.actor,
            "reason": failure.reason,
        })).collect::<Vec<_>>(),
    });
    if state.serve_tools {
        body["tools"] = json!(state.tools.iter().map(tool_json).collect::<Vec<_>>());
    }
    if state.serve_channels {
        body["channels"] = json!(state.channels.iter().map(channel_json).collect::<Vec<_>>());
    }
    body
}

fn filtered_activity(state: &DashboardState, actor: Option<&str>) -> Vec<Value> {
    state
        .activity
        .iter()
        .filter(|line| actor.map(|actor| line.actor == actor).unwrap_or(true))
        .map(|line| {
            json!({
                "actor": line.actor,
                "kind": line.kind,
                "summary": line.summary,
            })
        })
        .collect()
}

fn chat_summary(chat: &Chat) -> Value {
    json!({
        "id": chat.id,
        "title": chat.title,
        "agent_name": chat.agent_name,
        "pinned": if chat.pinned { 1 } else { 0 },
        "created_at": chat.created_at,
        "updated_at": chat.updated_at,
        "lastMessageAt": chat.last_message_at,
        "messageCount": chat.messages.len(),
        "lastSkill": chat.last_skill.as_ref().map(|skill| json!({"skill": skill.skill, "at": skill.at})),
        "archived": 0,
    })
}

fn chat_detail(state: &DashboardState, chat: &Chat) -> Value {
    json!({
        "messages": chat.messages.iter().map(|message| message_json(&chat.id, message)).collect::<Vec<_>>(),
        "events": chat.events.iter().map(event_json).collect::<Vec<_>>(),
        "actions": state.actions.iter().filter(|action| action.chat_id.as_deref() == Some(chat.id.as_str())).map(action_json).collect::<Vec<_>>(),
    })
}

fn message_json(chat_id: &str, message: &ChatMessage) -> Value {
    json!({
        "id": message.id,
        "chat_id": chat_id,
        "role": message.role,
        "content": message.content,
        "created_at": message.created_at,
        "reaction": message.reaction,
        "partial": if message.partial { 1 } else { 0 },
    })
}

fn event_json(event: &TeamEvent) -> Value {
    json!({
        "id": event.id,
        "chat_id": "",
        "agent": event.agent,
        "kind": event.kind,
        "content": event.content,
        "created_at": event.created_at,
    })
}

fn action_json(action: &ActionRecord) -> Value {
    json!({
        "id": action.id,
        "actor": action.actor,
        "kind": action.kind,
        "title": action.title,
        "detail": action.detail,
        "status": action.status,
        "result": action.result,
        "risk": action.risk,
        "chatId": action.chat_id,
        "createdAt": action.created_at,
        "decidedAt": action.decided_at,
        "decidedBy": action.decided_by,
        "supersedes": null,
    })
}

fn profile_json(profile: &Profile) -> Value {
    json!({
        "id": profile.id,
        "name": profile.name,
        "instructions": profile.instructions,
        "created_at": profile.created_at,
        "model": profile.model,
        "connector_id": profile.connector_id,
        "provider": profile.provider,
    })
}

fn skill_json(skill: &Skill) -> Value {
    json!({
        "name": skill.name,
        "description": skill.description,
        "path": skill.path,
        "source": skill.source,
    })
}

fn tool_json(tool: &Tool) -> Value {
    json!({
        "name": tool.name,
        "source": tool.source,
        "tier": tool.tier,
        "description": tool.description,
    })
}

fn connector_json(connector: &Connector) -> Value {
    json!({
        "id": connector.id,
        "name": connector.name,
        "url": connector.url,
        "tokenEnv": connector.token_env,
        "enabled": connector.enabled,
        "allowedTools": connector.allowed_tools,
        "credentialPresent": connector.credential_present,
    })
}

fn channel_json(channel: &Channel) -> Value {
    json!({
        "name": channel.name,
        "kind": channel.kind,
        "profile": channel.profile,
        "enabled": channel.enabled,
        "tokenEnv": channel.token_env,
    })
}

fn pairing_json(pairing: &Pairing) -> Value {
    json!({
        "channel": pairing.channel,
        "profile": pairing.profile,
        "owners": pairing.owners,
        "lockedUntil": pairing.locked_until,
    })
}

fn model_json(route: &ModelRoute) -> Value {
    json!({
        "route": route.route,
        "model": route.model,
        "tier": route.tier,
        "source": route.source,
    })
}

fn buckets_json(rows: &[(String, UsageBucket)]) -> Value {
    let mut map = serde_json::Map::new();
    for (name, bucket) in rows {
        map.insert(name.clone(), bucket.json());
    }
    Value::Object(map)
}

fn usage_json(state: &DashboardState) -> Value {
    let mut usage = state.usage.total.json();
    if let Some(object) = usage.as_object_mut() {
        object.insert("byActor".into(), buckets_json(&state.usage.by_actor));
        object.insert("byModel".into(), buckets_json(&state.usage.by_model));
        object.insert("byRoute".into(), buckets_json(&state.usage.by_route));
        object.insert("byTier".into(), buckets_json(&state.usage.by_tier));
        object.insert(
            "lastAt".into(),
            state
                .usage
                .last_at
                .as_ref()
                .map(|at| Value::String(at.clone()))
                .unwrap_or(Value::Null),
        );
        if state.serve_usage_today {
            object.insert("today".into(), state.usage.today.json());
        }
    }
    usage
}

fn engine_json(engine: &EngineView) -> Value {
    json!({
        "installed": engine.installed,
        "binary": engine.binary,
        "queued": engine.queued,
        "running": engine.running,
        "done": engine.done,
        "blocked": engine.blocked,
        "failed": engine.failed,
        "recent": engine.recent.iter().map(|task| json!({
            "id": task.id,
            "actor": task.actor,
            "chatId": task.chat_id,
            "title": task.title,
            "status": task.status,
        })).collect::<Vec<_>>(),
        "connection": {
            "route": "cli-reuse",
            "connected": engine.connected,
            "stale": engine.stale,
            "record": if engine.connected {
                json!({
                    "route": "cli-reuse",
                    "binary": engine.binary,
                    "connectedAt": engine.connected_at,
                    "authState": "signed-in",
                    "authMethod": engine.auth_method,
                })
            } else {
                Value::Null
            },
        },
    })
}

fn auth_json(state: &DashboardState) -> Value {
    let chat_model = state
        .models
        .iter()
        .find(|route| route.route == "chat")
        .map(|route| route.model.as_str())
        .unwrap_or("grok-4");
    json!({
        "provider": state.auth.provider,
        "endpoint": state.auth.endpoint,
        "keyEnv": state.auth.key_env,
        "key": state.auth.key,
        "healthy": state.auth.healthy,
        "setupVerified": null,
        "routes": [{
            "route": "chat",
            "model": chat_model,
            "key": state.auth.key,
            "lastProbe": {"bucket": "ok"},
        }],
        "profiles": state.profiles.iter().map(|profile| json!({
            "profile": profile.name,
            "kind": "profile",
            "model": profile.model,
        })).collect::<Vec<_>>(),
        "engine": {
            "route": "cli-reuse",
            "installed": state.engine.installed,
            "connected": state.engine.connected,
            "stale": state.engine.stale,
        },
    })
}

/// One rendered frame. `lines` is the buffer's symbol grid, trailing
/// spaces removed, so a view test can assert on what a person would read.
pub struct Screen {
    pub width: u16,
    pub height: u16,
    pub lines: Vec<String>,
    buffer: Buffer,
}

impl Screen {
    pub fn plain(&self) -> String {
        let mut lines = self.lines.clone();
        while lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }
        lines.join("\n")
    }

    pub fn contains(&self, needle: &str) -> bool {
        self.plain().contains(needle)
    }

    pub fn buffer(&self) -> &Buffer {
        &self.buffer
    }
}

/// Draw `app` into an offscreen terminal of `width` by `height`.
pub fn render_screen(app: &mut App, width: u16, height: u16) -> Screen {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("test terminal");
    terminal.draw(|frame| ui::render(frame, app)).expect("draw");
    let buffer = terminal.backend().buffer().clone();
    let lines = (0..buffer.area.height)
        .map(|y| {
            let mut line = String::new();
            for x in 0..buffer.area.width {
                line.push_str(buffer[(x, y)].symbol());
            }
            line.trim_end().to_string()
        })
        .collect();
    Screen {
        width,
        height,
        lines,
        buffer,
    }
}

/// Assert the rendered text. A leading newline on `expected` is ignored
/// so the frame can sit in a raw string. Leading blank rows after that
/// are part of the frame (the splash is vertically centered). The failure
/// prints both frames.
pub fn assert_screen(screen: &Screen, expected: &str) {
    let actual = screen.plain();
    let expected = normalize_screen(expected);
    if actual == expected {
        return;
    }
    panic!(
        "screen {0}x{1} mismatch\n--- actual ---\n{actual}\n--- expected ---\n{expected}\n",
        screen.width, screen.height
    );
}

fn normalize_screen(value: &str) -> String {
    let value = value.strip_prefix('\n').unwrap_or(value);
    let mut lines: Vec<String> = value
        .lines()
        .map(|line| line.trim_end().to_string())
        .collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}
