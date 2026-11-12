// Screen state for the terminal client. The app never stores a copy of
// SAM's memory or gate; it only holds the last API response it drew.

use crate::api::{ChatDetail, SendResult};
use crate::attach;
use crate::config::ProfileSet;
use crate::image_proto::{encode_iterm2, encode_kitty, image_label, ImageProtocol};
use crate::markdown::{SpanKind, StyledSpan};
use crate::scroll::ScrollState;
use crate::status_view::{Action, Snapshot};
use crate::theme::{self, Theme, ThemeId};
use crate::thinking::ToolLine;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    Splash,
    Chat,
    Approvals,
    Status,
    Config,
    Skills,
    Tools,
    Connections,
    Claude,
    Bridge,
}

impl Screen {
    pub fn title(self) -> &'static str {
        match self {
            Screen::Splash => "splash",
            Screen::Chat => "chat",
            Screen::Approvals => "approvals",
            Screen::Status => "status",
            Screen::Config => "config",
            Screen::Skills => "skills",
            Screen::Tools => "tools",
            Screen::Connections => "connections",
            Screen::Claude => "claude code",
            Screen::Bridge => "desktop bridge",
        }
    }

    pub fn index(self) -> usize {
        match self {
            Screen::Splash => 0,
            Screen::Chat => 1,
            Screen::Approvals => 2,
            Screen::Status => 3,
            Screen::Config => 4,
            Screen::Skills => 5,
            Screen::Tools => 6,
            Screen::Connections => 7,
            Screen::Claude => 8,
            Screen::Bridge => 9,
        }
    }

    fn from_key(key: char) -> Option<Self> {
        Some(match key {
            '1' => Screen::Chat,
            '2' => Screen::Approvals,
            '3' => Screen::Status,
            '4' => Screen::Config,
            '5' => Screen::Skills,
            '6' => Screen::Tools,
            '7' => Screen::Connections,
            '8' => Screen::Claude,
            '9' => Screen::Bridge,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug)]
pub enum Key {
    Char(char),
    Enter,
    Esc,
    Backspace,
    Up,
    Down,
    Left,
    Right,
    CtrlC,
    CtrlK,
    CtrlF,
    CtrlY,
    PageUp,
    PageDown,
    ShiftJ,
    ShiftK,
    Home,
    End,
}

#[derive(Clone, Copy, Debug)]
pub enum Pointer {
    Click { x: u16, y: u16 },
    Wheel { x: u16, y: u16, up: bool },
}

#[derive(Clone, Debug)]
pub enum Effect {
    Quit,
    Refresh,
    LoadChat(String),
    Send { chat_id: String, content: String },
    Decide { id: String, approve: bool },
    CreateChat(String),
    UseProfile {
        base_url: String,
        token: Option<String>,
    },
}

pub enum Ev {
    Status(Result<Snapshot, String>),
    Chat(Result<ChatDetail, String>),
    Poll(ChatDetail),
    Sent(Result<SendResult, String>),
    Decided(Result<Action, String>),
    Created(Result<String, String>),
    Switched {
        epoch: u64,
        result: Result<String, String>,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct Proof {
    pub chats_loaded: usize,
    pub chat_open: bool,
    pub reply: Option<String>,
    pub saw_working_reaction: bool,
    pub saw_heart_reaction: bool,
    pub approval_id: Option<String>,
    pub approval_status: Option<String>,
    pub image_protocol: String,
    pub image_label: Option<String>,
    pub image_sequence_prefix: Option<String>,
    pub status_ok: bool,
    pub origin: String,
}

#[derive(Clone, Debug)]
pub struct ViewLine {
    pub spans: Vec<StyledSpan>,
    pub message: Option<usize>,
    pub code_block: Option<usize>,
    pub hit: bool,
}

impl ViewLine {
    pub(crate) fn plain(&self) -> String {
        self.spans.iter().map(|span| span.text.as_str()).collect()
    }

    pub(crate) fn from_text(text: impl Into<String>, kind: SpanKind) -> Self {
        Self {
            spans: vec![StyledSpan::new(text, kind)],
            message: None,
            code_block: None,
            hit: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PaletteUi {
    pub query: String,
    pub cursor: usize,
    pub index: usize,
}

#[derive(Clone, Debug)]
pub struct SearchUi {
    pub query: String,
    pub cursor: usize,
    pub current: usize,
}

#[derive(Clone, Debug)]
pub struct AttachUi {
    pub path: String,
    pub cursor: usize,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Zone {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

impl Zone {
    pub fn contains(self, x: u16, y: u16) -> bool {
        self.w > 0
            && self.h > 0
            && x >= self.x
            && y >= self.y
            && x < self.x.saturating_add(self.w)
            && y < self.y.saturating_add(self.h)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FooterHit {
    pub x0: u16,
    pub x1: u16,
    pub y: u16,
    pub screen: Screen,
}

pub struct App {
    pub origin: String,
    pub screen: Screen,
    pub help: bool,
    pub snapshot: Option<Snapshot>,
    pub detail: Option<ChatDetail>,
    pub chat_id: Option<String>,
    pub list_index: usize,
    pub approval_index: usize,
    pub page_scroll: [usize; 10],
    pub composer: String,
    pub cursor: usize,
    pub insert: bool,
    pub busy: bool,
    pub inflight: bool,
    pub notice: String,
    pub connected: bool,
    pub protocol: ImageProtocol,
    pub proof: Proof,
    pub optimistic: Option<String>,
    pub image_sequence: Option<String>,
    pub image_anchor: Option<(u16, u16)>,
    pub theme_id: ThemeId,
    pub theme: Theme,
    pub profiles: ProfileSet,
    pub epoch: u64,
    pub transcript_scroll: ScrollState,
    pub history: bool,
    pub cols: usize,
    pub viewport: usize,
    pub view_lines: Vec<ViewLine>,
    pub selected_message: Option<usize>,
    pub code_focus: usize,
    pub clipboard: Option<String>,
    pub palette: Option<PaletteUi>,
    pub search: Option<SearchUi>,
    pub profiles_open: bool,
    pub profile_index: usize,
    pub pending_profile: Option<String>,
    pub attach: Option<AttachUi>,
    pub attachment: Option<String>,
    pub attachment_name: Option<String>,
    pub now_ms: u64,
    pub turn_started_ms: Option<u64>,
    pub thought_ms: Option<u64>,
    pub thinking_tools: Vec<ToolLine>,
    pub thinking_reasoning: String,
    pub turn_events: HashSet<String>,
    pub pending_reveal: Option<usize>,
    pub hit_list: Zone,
    pub hit_thread: Zone,
    pub hit_page: Zone,
    pub hit_composer: Zone,
    pub footer_hits: Vec<FooterHit>,
}

impl App {
    pub fn new(origin: impl Into<String>, protocol: ImageProtocol) -> Self {
        let origin = origin.into();
        Self {
            proof: Proof {
                chats_loaded: 0,
                chat_open: false,
                reply: None,
                saw_working_reaction: false,
                saw_heart_reaction: false,
                approval_id: None,
                approval_status: None,
                image_protocol: protocol.as_str().into(),
                image_label: None,
                image_sequence_prefix: None,
                status_ok: false,
                origin: origin.clone(),
            },
            origin,
            screen: Screen::Splash,
            help: false,
            snapshot: None,
            detail: None,
            chat_id: None,
            list_index: 0,
            approval_index: 0,
            page_scroll: [0; 10],
            composer: String::new(),
            cursor: 0,
            insert: false,
            busy: false,
            inflight: false,
            notice: "connecting…".into(),
            connected: false,
            protocol,
            optimistic: None,
            image_sequence: None,
            image_anchor: None,
            theme_id: ThemeId::Muse,
            theme: theme::default_theme(),
            profiles: ProfileSet::bare("dip"),
            epoch: 0,
            transcript_scroll: ScrollState::pinned(),
            history: false,
            cols: 80,
            viewport: 16,
            view_lines: Vec::new(),
            selected_message: None,
            code_focus: 0,
            clipboard: None,
            palette: None,
            search: None,
            profiles_open: false,
            profile_index: 0,
            pending_profile: None,
            attach: None,
            attachment: None,
            attachment_name: None,
            now_ms: 0,
            turn_started_ms: None,
            thought_ms: None,
            thinking_tools: Vec::new(),
            thinking_reasoning: String::new(),
            turn_events: HashSet::new(),
            pending_reveal: None,
            hit_list: Zone::default(),
            hit_thread: Zone::default(),
            hit_page: Zone::default(),
            hit_composer: Zone::default(),
            footer_hits: Vec::new(),
        }
    }

    pub fn tick(&mut self, now_ms: u64) {
        self.now_ms = now_ms;
    }

    pub fn on_key(&mut self, key: Key) -> Vec<Effect> {
        if matches!(key, Key::CtrlC) {
            return vec![Effect::Quit];
        }
        if matches!(key, Key::CtrlK) {
            self.toggle_palette();
            return vec![];
        }
        if self.help {
            return match key {
                Key::Char('?') | Key::Esc => {
                    self.help = false;
                    vec![]
                }
                Key::Char('q') => vec![Effect::Quit],
                _ => vec![],
            };
        }
        if self.palette.is_some() {
            return self.key_palette(key);
        }
        if matches!(key, Key::CtrlF) {
            self.toggle_search();
            return vec![];
        }
        if matches!(key, Key::CtrlY) {
            return self.yank_selected(true);
        }
        if self.search.is_some() {
            return self.key_search(key);
        }
        if self.profiles_open {
            return self.key_profiles(key);
        }
        if self.attach.is_some() {
            return self.key_attach(key);
        }
        if !self.insert {
            match key {
                Key::Char('q') => return vec![Effect::Quit],
                Key::Char('?') => {
                    self.help = true;
                    return vec![];
                }
                Key::Char(c @ '1'..='9') => return self.goto(c),
                Key::Char('p') => {
                    self.open_profiles();
                    return vec![];
                }
                Key::Char('t') => {
                    self.cycle_theme();
                    return vec![];
                }
                _ => {}
            }
        }
        if matches!(
            key,
            Key::PageUp | Key::PageDown | Key::ShiftJ | Key::ShiftK | Key::Home | Key::End
        ) {
            return self.key_scroll(key);
        }
        if !self.insert && matches!(key, Key::Char('J')) {
            return self.key_scroll(Key::ShiftJ);
        }
        if !self.insert && matches!(key, Key::Char('K')) {
            return self.key_scroll(Key::ShiftK);
        }
        match self.screen {
            Screen::Splash => self.key_splash(key),
            Screen::Chat => self.key_chat(key),
            Screen::Approvals => self.key_approvals(key),
            _ => {
                self.nudge_page(&key);
                vec![]
            }
        }
    }

    pub fn on_paste(&mut self, text: &str) -> Vec<Effect> {
        if self.help || self.palette.is_some() || self.profiles_open {
            return vec![];
        }
        let flat: String = text
            .chars()
            .map(|ch| match ch {
                '\n' | '\r' | '\t' => ' ',
                other => other,
            })
            .collect();
        let flat = flat.trim();
        if flat.is_empty() {
            return vec![];
        }
        if let Some(search) = self.search.as_mut() {
            crate::surface::push_text(&mut search.query, &mut search.cursor, flat, 200);
            self.sync_search();
            return vec![];
        }
        if let Some(attach) = self.attach.as_mut() {
            crate::surface::push_text(&mut attach.path, &mut attach.cursor, flat, 512);
            return vec![];
        }
        self.insert = true;
        let before = self.composer.chars().count();
        for ch in flat.chars() {
            self.insert_char(ch);
        }
        if self.composer.chars().count() == 4000 && before + flat.chars().count() > 4000 {
            self.notice = "Paste truncated to the composer limit.".into();
        }
        vec![]
    }

    pub fn on_pointer(&mut self, pointer: Pointer) -> Vec<Effect> {
        if self.help || self.palette.is_some() || self.search.is_some() || self.profiles_open {
            if let Pointer::Click { .. } = pointer {
                self.help = false;
                self.palette = None;
                self.search = None;
                self.profiles_open = false;
            }
            return vec![];
        }
        match pointer {
            Pointer::Wheel { x, y, up } => self.wheel(x, y, up),
            Pointer::Click { x, y } => self.click(x, y),
        }
    }

    pub fn apply(&mut self, ev: Ev) -> Vec<Effect> {
        match ev {
            Ev::Status(result) => self.on_status(result),
            Ev::Chat(result) => {
                self.inflight = false;
                match result {
                    Ok(detail) => {
                        self.note_detail(&detail);
                        self.detail = Some(detail);
                        self.proof.chat_open = true;
                        self.latch();
                        if !self.busy {
                            self.notice.clear();
                        }
                    }
                    Err(err) => self.notice = err,
                }
                vec![]
            }
            Ev::Poll(detail) => {
                self.note_detail(&detail);
                self.detail = Some(detail);
                self.proof.chat_open = true;
                self.latch();
                vec![]
            }
            Ev::Sent(result) => {
                self.busy = false;
                self.inflight = false;
                self.optimistic = None;
                if let Some(start) = self.turn_started_ms.take() {
                    if result.is_ok() {
                        self.thought_ms = Some(self.now_ms.saturating_sub(start));
                    }
                }
                self.thinking_tools.clear();
                self.thinking_reasoning.clear();
                match result {
                    Ok(send) => {
                        if !send.reply.is_empty() {
                            self.proof.reply = Some(send.reply);
                        }
                        self.note_reaction(send.user_reaction.as_deref());
                        self.notice.clear();
                        let mut effects = Vec::new();
                        if let Some(id) = self.chat_id.clone() {
                            effects.push(Effect::LoadChat(id));
                        }
                        effects.push(Effect::Refresh);
                        effects
                    }
                    Err(err) => {
                        self.notice = err;
                        vec![]
                    }
                }
            }
            Ev::Decided(result) => {
                self.inflight = false;
                match result {
                    Ok(action) => {
                        self.proof.approval_id = Some(action.id.clone());
                        self.proof.approval_status = Some(action.status.clone());
                        if let Some(snap) = &mut self.snapshot {
                            if let Some(existing) =
                                snap.actions.iter_mut().find(|a| a.id == action.id)
                            {
                                *existing = action;
                            } else {
                                snap.actions.push(action);
                            }
                        }
                        self.clamp_approval();
                        self.notice.clear();
                        vec![Effect::Refresh]
                    }
                    Err(err) => {
                        self.notice = err;
                        vec![]
                    }
                }
            }
            Ev::Created(result) => {
                self.inflight = false;
                match result {
                    Ok(id) => {
                        self.chat_id = Some(id.clone());
                        self.screen = Screen::Chat;
                        self.notice = "Chat created.".into();
                        vec![Effect::Refresh, Effect::LoadChat(id)]
                    }
                    Err(err) => {
                        self.notice = err;
                        vec![]
                    }
                }
            }
            Ev::Switched { epoch, result } => {
                if epoch >= self.epoch {
                    self.epoch = epoch;
                }
                let pending = self.pending_profile.take();
                match result {
                    Ok(origin) => {
                        if let Some(name) = pending {
                            self.profiles.active = name;
                        }
                        self.origin = origin.clone();
                        self.proof.origin = origin;
                        self.detail = None;
                        self.chat_id = None;
                        self.list_index = 0;
                        self.selected_message = None;
                        self.busy = false;
                        self.inflight = false;
                        self.optimistic = None;
                        self.transcript_scroll = ScrollState::pinned();
                        self.history = false;
                        self.screen = Screen::Chat;
                        self.notice = format!("Now talking to {}.", self.profiles.active);
                        vec![]
                    }
                    Err(err) => {
                        self.notice = format!("Stayed on {}: {err}", self.profiles.active);
                        vec![]
                    }
                }
            }
        }
    }

    pub fn prepare_image(&mut self, cols: u16) {
        self.image_sequence = None;
        self.image_anchor = None;
        let Some(image) = self.detail.as_ref().and_then(|d| d.images.last().cloned()) else {
            self.proof.image_label = None;
            self.proof.image_sequence_prefix = None;
            return;
        };
        self.proof.image_label = Some(image_label(&image.name, self.protocol));
        self.image_sequence = match self.protocol {
            ImageProtocol::Kitty => Some(encode_kitty(&image.bytes)),
            ImageProtocol::Iterm2 => Some(encode_iterm2(&image.bytes, &image.name, cols.max(1))),
            ImageProtocol::None => None,
        };
        self.proof.image_sequence_prefix = self.image_sequence.as_deref().map(sequence_prefix);
    }

    #[allow(dead_code)]
    pub fn transcript(&self) -> Vec<String> {
        self.build_lines(80)
            .into_iter()
            .map(|line| line.plain())
            .collect()
    }

    pub fn chat_rows(&self) -> Vec<String> {
        let Some(snap) = &self.snapshot else {
            return vec!["loading…".into()];
        };
        if snap.chats.is_empty() {
            return vec!["No chats yet.".into(), "n creates one.".into()];
        }
        snap.chats
            .iter()
            .map(|chat| {
                let mark = if Some(&chat.id) == self.chat_id.as_ref() {
                    ">"
                } else {
                    " "
                };
                let pin = if chat.pinned { "*" } else { " " };
                format!("{mark}{pin} {} ({})", chat.title, chat.agent)
            })
            .collect()
    }

    pub fn approval_rows(&self) -> Vec<String> {
        let Some(snap) = &self.snapshot else {
            return vec!["Approvals not loaded yet.".into()];
        };
        let pending: Vec<&Action> = snap
            .actions
            .iter()
            .filter(|a| a.status == "pending")
            .collect();
        let mut lines = vec![format!("{} pending", pending.len())];
        if pending.is_empty() {
            lines.push("No pending approvals.".into());
        }
        for (i, action) in pending.iter().enumerate() {
            let mark = if i == self.approval_index { ">" } else { " " };
            let risk = action.risk.as_deref().unwrap_or("risk not set");
            lines.push(format!(
                "{mark} {} · {} · {risk}",
                action.kind, action.actor
            ));
            lines.push(format!("  {}", action.title));
            let detail: String = action.detail.chars().take(240).collect();
            if !detail.is_empty() {
                lines.push(format!("  {detail}"));
            }
            lines.push("  y approve    x reject".into());
        }
        lines.push(String::new());
        lines.push("Recent decisions".into());
        let mut decided: Vec<&Action> = snap
            .actions
            .iter()
            .filter(|a| a.status != "pending")
            .collect();
        decided.reverse();
        if decided.is_empty() {
            lines.push("  none yet".into());
        }
        for action in decided.into_iter().take(8) {
            let result = action.result.as_deref().unwrap_or("");
            lines.push(format!(
                "  {} · {} · {} {result}",
                action.status, action.kind, action.title
            ));
        }
        lines
    }

    pub fn status_rows(&self) -> Vec<String> {
        let Some(snap) = &self.snapshot else {
            return vec!["Status not loaded yet.".into()];
        };
        let mut lines = Vec::new();
        if let Some(at) = &snap.at {
            lines.push(format!("as of {at}"));
        }
        lines.push("Provider health".into());
        lines.extend(snap.surfaces.provider_health.iter().cloned());
        lines.push(String::new());
        lines.push("Per-agent activity".into());
        lines.extend(snap.surfaces.activity.iter().cloned());
        lines.push(String::new());
        lines.push("Spend".into());
        lines.extend(snap.surfaces.spend.iter().cloned());
        lines.push(String::new());
        lines.push("Failures".into());
        lines.extend(snap.surfaces.failures.iter().cloned());
        lines
    }

    pub fn config_rows(&self) -> Vec<String> {
        let Some(snap) = &self.snapshot else {
            return vec!["Config not loaded yet.".into()];
        };
        let mut lines = Vec::new();
        lines.push("Model".into());
        lines.extend(snap.surfaces.model.iter().cloned());
        lines.push(String::new());
        lines.push("Auth".into());
        lines.extend(snap.surfaces.auth.iter().cloned());
        lines.push(String::new());
        lines.push("Channels".into());
        lines.extend(snap.surfaces.channels.iter().cloned());
        lines
    }

    fn on_status(&mut self, result: Result<Snapshot, String>) -> Vec<Effect> {
        match result {
            Ok(snap) => {
                self.connected = true;
                self.proof.status_ok = snap.ok;
                self.proof.chats_loaded = snap.chats.len();
                if self.notice == "connecting…" || self.notice.starts_with("cannot reach") {
                    self.notice.clear();
                }
                let mut effects = Vec::new();
                if self.screen == Screen::Chat && self.chat_id.is_none() {
                    if let Some(id) = snap.chats.first().map(|c| c.id.clone()) {
                        self.chat_id = Some(id.clone());
                        self.list_index = 0;
                        effects.push(Effect::LoadChat(id));
                    }
                }
                if let Some(id) = &self.chat_id {
                    if let Some(index) = snap.chats.iter().position(|c| &c.id == id) {
                        self.list_index = index;
                    }
                }
                self.snapshot = Some(snap);
                self.clamp_approval();
                effects
            }
            Err(err) => {
                self.connected = false;
                self.notice = format!("cannot reach SAM: {err}");
                vec![]
            }
        }
    }

    fn goto(&mut self, key: char) -> Vec<Effect> {
        let Some(screen) = Screen::from_key(key) else {
            return vec![];
        };
        self.open_screen(screen)
    }

    fn open_screen(&mut self, screen: Screen) -> Vec<Effect> {
        self.insert = false;
        if screen == Screen::Chat {
            return self.enter_chat();
        }
        self.screen = screen;
        vec![Effect::Refresh]
    }

    fn enter_chat(&mut self) -> Vec<Effect> {
        self.screen = Screen::Chat;
        self.insert = false;
        if self.chat_id.is_none() {
            if let Some(id) = self
                .snapshot
                .as_ref()
                .and_then(|s| s.chats.first().map(|c| c.id.clone()))
            {
                self.chat_id = Some(id.clone());
                self.list_index = 0;
                return vec![Effect::LoadChat(id)];
            }
        }
        vec![]
    }

    fn key_splash(&mut self, key: Key) -> Vec<Effect> {
        match key {
            Key::Char('q') | Key::CtrlC => vec![Effect::Quit],
            _ => self.enter_chat(),
        }
    }

    fn key_chat(&mut self, key: Key) -> Vec<Effect> {
        if self.insert {
            return match key {
                Key::Enter => self.send(),
                Key::Esc => {
                    self.insert = false;
                    vec![]
                }
                Key::Backspace => {
                    self.backspace();
                    vec![]
                }
                Key::Left => {
                    self.cursor_left();
                    vec![]
                }
                Key::Right => {
                    self.cursor_right();
                    vec![]
                }
                Key::Char(c) => {
                    self.insert_char(c);
                    vec![]
                }
                _ => vec![],
            };
        }
        match key {
            Key::Char('i') => {
                self.insert = true;
                vec![]
            }
            Key::Char('a') => {
                self.attach = Some(AttachUi {
                    path: String::new(),
                    cursor: 0,
                });
                vec![]
            }
            Key::Char('y') => self.yank_selected(false),
            Key::Char('c') => self.copy_block(),
            Key::Char('x') if self.attachment.is_some() => {
                self.attachment = None;
                self.attachment_name = None;
                self.notice = "Attachment removed.".into();
                vec![]
            }
            Key::Char(']') => {
                self.move_selection(1);
                vec![]
            }
            Key::Char('[') => {
                self.move_selection(-1);
                vec![]
            }
            Key::Char('n') if !self.inflight => {
                self.inflight = true;
                vec![Effect::CreateChat("Terminal".into())]
            }
            Key::Char('j') | Key::Down => self.move_list(1),
            Key::Char('k') | Key::Up => self.move_list(-1),
            Key::Enter => {
                if self.attachment.is_some() || !self.composer.trim().is_empty() {
                    self.send()
                } else if let Some(id) = self.chat_id.clone() {
                    vec![Effect::LoadChat(id)]
                } else {
                    vec![]
                }
            }
            _ => vec![],
        }
    }

    fn key_approvals(&mut self, key: Key) -> Vec<Effect> {
        match key {
            Key::Char('j') | Key::Down => {
                let n = self.pending_count();
                if n > 0 && self.approval_index + 1 < n {
                    self.approval_index += 1;
                }
                vec![]
            }
            Key::Char('k') | Key::Up => {
                self.approval_index = self.approval_index.saturating_sub(1);
                vec![]
            }
            Key::Char('y') => self.decide(true),
            Key::Char('x') => self.decide(false),
            _ => vec![],
        }
    }

    fn decide(&mut self, approve: bool) -> Vec<Effect> {
        if self.inflight {
            return vec![];
        }
        let Some(id) = self.selected_pending() else {
            self.notice = "No pending approval.".into();
            return vec![];
        };
        self.inflight = true;
        vec![Effect::Decide { id, approve }]
    }

    fn send(&mut self) -> Vec<Effect> {
        if self.busy || self.inflight {
            return vec![];
        }
        let Some(id) = self.chat_id.clone() else {
            self.notice = "Select or create a chat first.".into();
            return vec![];
        };
        let text = match &self.attachment {
            Some(markdown) => match attach::join_attachment(&self.composer, markdown) {
                Ok(text) => text,
                Err(err) => {
                    self.notice = err;
                    return vec![];
                }
            },
            None => self.composer.trim().to_string(),
        };
        if text.trim().is_empty() {
            return vec![];
        }
        self.composer.clear();
        self.cursor = 0;
        self.insert = false;
        self.attachment = None;
        self.attachment_name = None;
        self.busy = true;
        self.inflight = true;
        self.optimistic = Some(text.clone());
        self.turn_started_ms = Some(self.now_ms);
        self.thought_ms = None;
        self.thinking_tools.clear();
        self.thinking_reasoning.clear();
        self.turn_events = self.event_keys();
        self.transcript_scroll = ScrollState::pinned();
        self.history = false;
        self.notice.clear();
        vec![Effect::Send {
            chat_id: id,
            content: text,
        }]
    }

    fn move_list(&mut self, delta: isize) -> Vec<Effect> {
        let Some(ids) = self
            .snapshot
            .as_ref()
            .map(|s| s.chats.iter().map(|c| c.id.clone()).collect::<Vec<_>>())
        else {
            return vec![];
        };
        if ids.is_empty() {
            return vec![];
        }
        let len = ids.len() as isize;
        let next = (self.list_index as isize + delta).clamp(0, len - 1) as usize;
        self.list_index = next;
        let id = ids[next].clone();
        if self.chat_id.as_deref() == Some(id.as_str()) {
            return vec![];
        }
        self.chat_id = Some(id.clone());
        vec![Effect::LoadChat(id)]
    }

    fn nudge_page(&mut self, key: &Key) {
        match key {
            Key::Char('j') | Key::Down => self.bump_page(1, false),
            Key::Char('k') | Key::Up => self.bump_page(-1, false),
            _ => {}
        }
    }

    pub(crate) fn bump_page(&mut self, delta: isize, page: bool) {
        let step = if page {
            self.viewport.max(1).saturating_sub(1).max(1)
        } else {
            1
        };
        let slot = &mut self.page_scroll[self.screen.index()];
        if delta < 0 {
            *slot = slot.saturating_sub(step);
        } else {
            *slot = slot.saturating_add(step);
        }
    }

    fn pending_count(&self) -> usize {
        self.snapshot
            .as_ref()
            .map(|s| s.actions.iter().filter(|a| a.status == "pending").count())
            .unwrap_or(0)
    }

    fn selected_pending(&self) -> Option<String> {
        self.snapshot.as_ref().and_then(|s| {
            s.actions
                .iter()
                .filter(|a| a.status == "pending")
                .nth(self.approval_index)
                .map(|a| a.id.clone())
        })
    }

    fn clamp_approval(&mut self) {
        let n = self.pending_count();
        if n == 0 {
            self.approval_index = 0;
        } else if self.approval_index >= n {
            self.approval_index = n - 1;
        }
    }

    fn latch(&mut self) {
        let reactions: Vec<Option<String>> = self
            .detail
            .as_ref()
            .map(|detail| detail.messages.iter().map(|m| m.reaction.clone()).collect())
            .unwrap_or_default();
        for reaction in reactions {
            self.note_reaction(reaction.as_deref());
        }
    }

    fn note_reaction(&mut self, reaction: Option<&str>) {
        let Some(reaction) = reaction else { return };
        if reaction.contains("👀") {
            self.proof.saw_working_reaction = true;
        }
        if reaction.contains('❤') {
            self.proof.saw_heart_reaction = true;
        }
    }

    fn insert_char(&mut self, c: char) {
        if self.composer.chars().count() >= 4000 {
            return;
        }
        self.composer.insert(self.cursor, c);
        self.cursor += c.len_utf8();
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        if let Some(ch) = self.composer[..self.cursor].chars().next_back() {
            let start = self.cursor - ch.len_utf8();
            self.composer.replace_range(start..self.cursor, "");
            self.cursor = start;
        }
    }

    fn cursor_left(&mut self) {
        if let Some(ch) = self.composer[..self.cursor].chars().next_back() {
            self.cursor -= ch.len_utf8();
        }
    }

    fn cursor_right(&mut self) {
        if let Some(ch) = self.composer[self.cursor..].chars().next() {
            self.cursor += ch.len_utf8();
        }
    }
}

fn sequence_prefix(sequence: &str) -> String {
    sequence
        .chars()
        .take(32)
        .collect::<String>()
        .replace('\u{1b}', "\\u001b")
        .replace('\u{7}', "\\u0007")
}

pub const HELP: &str = "\
sam-cli is a face for the running SAM. It keeps no agent state.

q              quit          ?            this help
esc            close a panel, or leave the composer
1-4            chat, approvals, status, config
5-9            skills, tools, connections, claude code, bridge
j k            next / previous in the list or page
J K            scroll the transcript one line
pgup pgdn      scroll a page     home end   top / latest
i              write            enter        send
n              new chat titled Terminal
a              attach an image by path (data URL, 12000 character cap)
[ ]            select a message    y   copy it (OSC 52)
c              copy the selected message's code block
ctrl-k         command palette     ctrl-f   search this chat
p              switch profile (dip, trading, second-shift)
t              toggle theme (Muse, Harbor)
y x            on approvals: approve / reject

The transcript follows the latest line until you scroll up.
\"viewing history\" means new messages will not yank the view down.
Paste is bracketed: it lands in the composer and is not a command.
A desktop bridge that is not paired says so. It is not Telegram.

Connect with SAM_BASE_URL and SAM_TOKEN, or a mode-0600 config
file. Profiles live in that file under \"profiles\". A base URL
ending in /sam follows the stable-door redirect.
";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{ChatDetail, Message};
    use crate::image_proto::InlineImage;

    fn app_with_thread(protocol: ImageProtocol) -> App {
        let mut app = App::new("http://127.0.0.1:4317", protocol);
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        app.detail = Some(ChatDetail {
            messages: vec![
                Message {
                    id: "u".into(),
                    role: "user".into(),
                    content: "ping".into(),
                    created_at: "".into(),
                    reaction: Some("👀".into()),
                    partial: false,
                    source: None,
                },
                Message {
                    id: "a".into(),
                    role: "assistant".into(),
                    content: format!("pong from mock\n![pixel](data:image/png;base64,{png})"),
                    created_at: "".into(),
                    reaction: None,
                    partial: false,
                    source: None,
                },
            ],
            events: vec![],
            team: vec![],
            actions: vec![],
            images: vec![InlineImage {
                name: "pixel".into(),
                bytes: vec![0x89, b'P', b'N', b'G'],
            }],
        });
        app.latch();
        app
    }

    #[test]
    fn transcript_shows_the_working_reaction_and_a_placeholder() {
        let mut app = app_with_thread(ImageProtocol::None);
        app.prepare_image(80);
        let lines = app.transcript();
        let joined = lines.join("\n");
        assert!(joined.contains("you  ping  👀"), "{joined}");
        assert!(joined.contains("pong from mock"), "{joined}");
        assert!(
            joined.contains("[image: pixel · no graphics protocol]"),
            "{joined}"
        );
        assert!(!joined.contains("base64"), "{joined}");
        assert!(app.proof.saw_working_reaction);
        assert!(app.image_sequence.is_none());
    }

    #[test]
    fn kitty_protocol_is_planned_when_the_terminal_asks_for_it() {
        let mut app = app_with_thread(ImageProtocol::Kitty);
        app.prepare_image(80);
        let sequence = app.image_sequence.clone().expect("kitty sequence");
        assert!(sequence.starts_with("\u{1b}_Ga=T,f=100,t=d"));
        assert!(app
            .proof
            .image_sequence_prefix
            .as_deref()
            .unwrap()
            .starts_with("\\u001b_G"));
        assert!(app
            .transcript()
            .iter()
            .any(|l| l.contains("kitty protocol")));
    }

    #[test]
    fn q_quits_and_question_mark_opens_help() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        assert!(matches!(app.on_key(Key::Char('?'))[..], []));
        assert!(app.help);
        assert!(matches!(app.on_key(Key::Char('q'))[..], [Effect::Quit]));
    }

    #[test]
    fn heart_reaction_is_latched_from_a_poll() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        let detail = ChatDetail {
            messages: vec![Message {
                id: "u".into(),
                role: "user".into(),
                content: "ping".into(),
                created_at: "".into(),
                reaction: Some("❤️".into()),
                partial: false,
                source: None,
            }],
            events: vec![],
            team: vec![],
            actions: vec![],
            images: vec![],
        };
        app.apply(Ev::Poll(detail));
        assert!(app.proof.saw_heart_reaction);
    }

    fn detail(messages: Vec<Message>) -> ChatDetail {
        ChatDetail {
            messages,
            events: vec![],
            team: vec![],
            actions: vec![],
            images: vec![],
        }
    }

    fn message(role: &str, content: &str) -> Message {
        Message {
            id: role.into(),
            role: role.into(),
            content: content.into(),
            created_at: "".into(),
            reaction: None,
            partial: false,
            source: None,
        }
    }

    #[test]
    fn bracketed_paste_is_text_not_a_command() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        app.screen = Screen::Chat;
        let effects = app.on_paste("q\n1");
        assert!(effects.is_empty());
        assert!(app.insert);
        assert_eq!(app.composer, "q 1");
        assert!(!matches!(app.on_key(Key::Char('q'))[..], [Effect::Quit]));
    }

    #[test]
    fn scrolling_up_marks_history_until_the_tail_is_pinned_again() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        app.screen = Screen::Chat;
        app.viewport = 6;
        app.cols = 40;
        let body = (0..30)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        app.detail = Some(detail(vec![message("assistant", &body)]));
        app.on_key(Key::PageUp);
        assert!(app.viewing_history(), "page up leaves the tail");
        app.on_key(Key::End);
        assert!(!app.viewing_history());
        app.on_key(Key::ShiftK);
        assert!(app.viewing_history());
    }

    #[test]
    fn yank_uses_osc52_and_code_copy_uses_the_block_source() {
        use crate::clipboard::decode_osc52_payload;
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        app.screen = Screen::Chat;
        app.detail = Some(detail(vec![
            message("user", "ping"),
            message("assistant", "```rust\nfn main() {}\n```"),
        ]));
        app.on_key(Key::Char(']'));
        app.on_key(Key::Char(']'));
        app.on_key(Key::Char('y'));
        let yanked = app.clipboard.clone().expect("yank");
        let text = String::from_utf8(decode_osc52_payload(&yanked).unwrap()).unwrap();
        assert!(text.contains("fn main"), "{text}");
        app.clipboard = None;
        app.on_key(Key::Char('c'));
        let copied = app.clipboard.clone().expect("code");
        assert_eq!(
            String::from_utf8(decode_osc52_payload(&copied).unwrap())
                .unwrap()
                .trim(),
            "fn main() {}"
        );
    }

    #[test]
    fn palette_fuzzy_opens_approvals_and_theme_toggles() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        assert_eq!(app.theme_id, ThemeId::Muse);
        app.on_key(Key::CtrlK);
        assert!(app.palette.is_some());
        for ch in "appr".chars() {
            app.on_key(Key::Char(ch));
        }
        assert_eq!(app.palette_matches()[0].label, "Approvals");
        app.on_key(Key::Enter);
        assert_eq!(app.screen, Screen::Approvals);
        app.on_key(Key::Char('t'));
        assert_eq!(app.theme_id, ThemeId::Harbor);
        app.on_key(Key::Char('t'));
        assert_eq!(app.theme_id, ThemeId::Muse);
    }

    #[test]
    fn search_jumps_to_the_matching_message() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        app.screen = Screen::Chat;
        app.detail = Some(detail(vec![
            message("user", "ping"),
            message("assistant", "Pong from mock"),
        ]));
        app.on_key(Key::CtrlF);
        for ch in "pong".chars() {
            app.on_key(Key::Char(ch));
        }
        assert_eq!(app.selected_message, Some(1));
        let hits = app.search_hits();
        assert_eq!(hits.len(), 1);
        assert_eq!(&"Pong from mock"[hits[0].start..hits[0].end], "Pong");
    }

    #[test]
    fn an_unconfigured_profile_is_not_invented() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        app.screen = Screen::Chat;
        app.on_key(Key::Char('p'));
        app.on_key(Key::Down);
        let effects = app.on_key(Key::Enter);
        assert!(effects.is_empty(), "{effects:?}");
        assert!(app.notice.contains("not configured"), "{}", app.notice);
        assert_eq!(app.profiles.active, "dip");
        app.profiles.slots[1].base_url = Some("http://127.0.0.1:9".into());
        app.profiles.slots[1].token = Some("secret-token".into());
        app.on_key(Key::Char('p'));
        app.on_key(Key::Down);
        let effects = app.on_key(Key::Enter);
        match effects.as_slice() {
            [Effect::UseProfile { base_url, token }] => {
                assert_eq!(base_url, "http://127.0.0.1:9");
                assert_eq!(token.as_deref(), Some("secret-token"));
            }
            other => panic!("expected a switch, got {other:?}"),
        }
        assert!(!app.notice.contains("secret-token"), "{}", app.notice);
    }

    #[test]
    fn a_user_message_shows_its_source_and_an_old_server_stays_quiet() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        let mut from_cli = message("user", "ping");
        from_cli.source = Some("rust-cli".into());
        let mut from_desk = message("user", "from the desk");
        from_desk.source = Some("dashboard".into());
        app.detail = Some(detail(vec![
            from_cli,
            from_desk,
            message("user", "legacy"),
            message("assistant", "reply"),
        ]));
        let joined = app.transcript().join("\n");
        assert!(joined.contains("you  ping") && joined.contains("· rust-cli"), "{joined}");
        assert!(joined.contains("· dashboard"), "{joined}");
        assert!(
            joined.contains("legacy") && !joined.contains("· unknown"),
            "{joined}"
        );
        let legacy = app
            .transcript()
            .into_iter()
            .find(|line| line.contains("legacy"))
            .unwrap();
        assert!(!legacy.contains('·'), "{legacy}");
        assert!(!joined.lines().any(|line| line.contains("reply") && line.contains('·')));
        assert!(app.build_lines(80).iter().any(|line| {
            line.spans
                .iter()
                .any(|span| span.text.contains("rust-cli") && span.kind == SpanKind::Dim)
        }));
    }

    #[test]
    fn sections_five_through_nine_open() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        app.screen = Screen::Chat;
        for (key, screen) in [
            ('5', Screen::Skills),
            ('6', Screen::Tools),
            ('7', Screen::Connections),
            ('8', Screen::Claude),
            ('9', Screen::Bridge),
        ] {
            app.on_key(Key::Char(key));
            assert_eq!(app.screen, screen);
        }
    }
}
