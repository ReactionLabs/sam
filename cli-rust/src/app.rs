// Screen state for the terminal client. The app never stores a copy of
// SAM's memory or gate; it only holds the last API response it drew.

use crate::api::{ChatDetail, Message, SendResult};
use crate::image_proto::{display_text, encode_iterm2, encode_kitty, image_label, ImageProtocol};
use crate::status_view::{Action, Snapshot};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    Splash,
    Chat,
    Approvals,
    Status,
    Config,
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
}

#[derive(Clone, Debug)]
pub enum Effect {
    Quit,
    Refresh,
    LoadChat(String),
    Send { chat_id: String, content: String },
    Decide { id: String, approve: bool },
    CreateChat(String),
}

pub enum Ev {
    Status(Result<Snapshot, String>),
    Chat(Result<ChatDetail, String>),
    Poll(ChatDetail),
    Sent(Result<SendResult, String>),
    Decided(Result<Action, String>),
    Created(Result<String, String>),
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

pub struct App {
    pub origin: String,
    pub screen: Screen,
    pub help: bool,
    pub snapshot: Option<Snapshot>,
    pub detail: Option<ChatDetail>,
    pub chat_id: Option<String>,
    pub list_index: usize,
    pub approval_index: usize,
    pub status_scroll: usize,
    pub config_scroll: usize,
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
            status_scroll: 0,
            config_scroll: 0,
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
        }
    }

    pub fn on_key(&mut self, key: Key) -> Vec<Effect> {
        if self.help {
            return match key {
                Key::Char('?') | Key::Esc => {
                    self.help = false;
                    vec![]
                }
                Key::Char('q') | Key::CtrlC => vec![Effect::Quit],
                _ => vec![],
            };
        }
        if !self.insert {
            match key {
                Key::CtrlC | Key::Char('q') => return vec![Effect::Quit],
                Key::Char('?') => {
                    self.help = true;
                    return vec![];
                }
                Key::Char(c @ '1'..='4') => return self.goto(c),
                _ => {}
            }
        }
        match self.screen {
            Screen::Splash => self.key_splash(key),
            Screen::Chat => self.key_chat(key),
            Screen::Approvals => self.key_approvals(key),
            Screen::Status => {
                self.nudge_scroll(key, true);
                vec![]
            }
            Screen::Config => {
                self.nudge_scroll(key, false);
                vec![]
            }
        }
    }

    pub fn apply(&mut self, ev: Ev) -> Vec<Effect> {
        match ev {
            Ev::Status(result) => self.on_status(result),
            Ev::Chat(result) => {
                self.inflight = false;
                match result {
                    Ok(detail) => {
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
                self.detail = Some(detail);
                self.proof.chat_open = true;
                self.latch();
                vec![]
            }
            Ev::Sent(result) => {
                self.busy = false;
                self.inflight = false;
                self.optimistic = None;
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

    pub fn transcript(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(detail) = &self.detail {
            for message in &detail.messages {
                lines.extend(message_lines(message));
            }
            for action in detail.actions.iter().filter(|a| a.status == "pending") {
                lines.push(format!(
                    "action  {} pending · {}",
                    action.kind, action.title
                ));
            }
            for event in &detail.events {
                lines.push(format!("team  {event}"));
            }
        }
        if let Some(text) = &self.optimistic {
            let already = self
                .detail
                .as_ref()
                .map(|d| {
                    d.messages
                        .iter()
                        .any(|m| m.role == "user" && m.content == *text)
                })
                .unwrap_or(false);
            if !already {
                lines.push(format!("you  {text}"));
            }
        }
        if self.busy {
            lines.push("sam  SAM is working…".into());
        }
        if let Some(label) = &self.proof.image_label {
            lines.push(label.clone());
        }
        if lines.is_empty() {
            lines.push("No messages yet. Press i to write.".into());
        }
        lines
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
        self.insert = false;
        match key {
            '1' => self.enter_chat(),
            '2' => {
                self.screen = Screen::Approvals;
                vec![Effect::Refresh]
            }
            '3' => {
                self.screen = Screen::Status;
                vec![Effect::Refresh]
            }
            '4' => {
                self.screen = Screen::Config;
                vec![Effect::Refresh]
            }
            _ => vec![],
        }
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
            Key::Char('n') if !self.inflight => {
                self.inflight = true;
                vec![Effect::CreateChat("Terminal".into())]
            }
            Key::Char('j') | Key::Down => self.move_list(1),
            Key::Char('k') | Key::Up => self.move_list(-1),
            Key::Enter => {
                if let Some(id) = self.chat_id.clone() {
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
        let text = self.composer.trim().to_string();
        if text.is_empty() {
            return vec![];
        }
        self.composer.clear();
        self.cursor = 0;
        self.insert = false;
        self.busy = true;
        self.inflight = true;
        self.optimistic = Some(text.clone());
        self.notice = "SAM is working…".into();
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

    fn nudge_scroll(&mut self, key: Key, status: bool) {
        let delta: isize = match key {
            Key::Char('j') | Key::Down => 1,
            Key::Char('k') | Key::Up => -1,
            _ => return,
        };
        let slot = if status {
            &mut self.status_scroll
        } else {
            &mut self.config_scroll
        };
        if delta < 0 {
            *slot = slot.saturating_sub(delta.unsigned_abs());
        } else {
            *slot = slot.saturating_add(delta as usize);
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

fn message_lines(message: &Message) -> Vec<String> {
    let who = if message.role == "user" { "you" } else { "sam" };
    let when = message
        .created_at
        .get(11..19)
        .filter(|t| t.chars().all(|c| c.is_ascii_digit() || c == ':'))
        .map(|t| format!("{t}  "))
        .unwrap_or_default();
    let reaction = message
        .reaction
        .as_deref()
        .filter(|r| !r.is_empty())
        .map(|r| format!("  {r}"))
        .unwrap_or_default();
    let text = display_text(&message.content);
    let mut lines = Vec::new();
    let mut first = true;
    for line in text.split('\n') {
        if first {
            lines.push(format!("{who}  {when}{line}{reaction}"));
            first = false;
        } else if !line.is_empty() {
            lines.push(format!("    {line}"));
        }
    }
    if lines.is_empty() {
        lines.push(format!("{who}  {reaction}"));
    }
    lines
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

q            quit
?            toggle this help
esc          close help, or leave the composer
1 2 3 4      chat, approvals, status, config
j k          next / previous
i            write in the chat composer
enter        send the composer
n            new chat titled Terminal
y            approve the selected card
x            reject the selected card

Images use the kitty or iTerm2 graphics protocol when this
terminal supports it (or when SAM_TUI_IMAGE says so). Otherwise
the transcript shows a text placeholder.

Connect with SAM_BASE_URL and SAM_TOKEN, or a mode-0600 config
file. A base URL ending in /sam follows the stable-door redirect.
";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ChatDetail;
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
                },
                Message {
                    id: "a".into(),
                    role: "assistant".into(),
                    content: format!("pong from mock\n![pixel](data:image/png;base64,{png})"),
                    created_at: "".into(),
                    reaction: None,
                },
            ],
            events: vec![],
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
            }],
            events: vec![],
            actions: vec![],
            images: vec![],
        };
        app.apply(Ev::Poll(detail));
        assert!(app.proof.saw_heart_reaction);
    }
}
