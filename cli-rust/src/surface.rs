// Extra screen behavior for the flagship client. Kept beside `app` so
// the original chat, approval, and proof paths stay easy to read.

use crate::api::{ChatDetail, Message, TeamEvent};
use crate::app::{
    App, AttachUi, FooterHit, Key, PaletteUi, Screen, SearchUi, ViewLine, Zone,
};
use crate::attach;
use crate::clipboard::encode_osc52;
use crate::image_proto::display_text;
use crate::markdown::{render_markdown, SpanKind, StyledSpan};
use crate::palette::{rank, Candidate};
use crate::scroll::ScrollState;
use crate::search::{search, Hit};
use crate::statusbar::{connection_state, status_line};
use crate::status_view::Snapshot;
use crate::theme::{self, ThemeId};
use crate::thinking::{self, apply_event};
use std::collections::HashSet;

impl App {
    pub fn layout_thread(&mut self, inner_cols: usize, inner_rows: usize) {
        self.cols = inner_cols.max(8);
        self.viewport = inner_rows.max(1);
        self.relayout();
    }

    pub fn relayout(&mut self) {
        let mut lines = self.build_lines(self.cols);
        let view = self.viewport.max(1);
        self.transcript_scroll.sync(lines.len(), view);
        if let Some(message) = self.pending_reveal.take() {
            if let Some(at) = lines.iter().position(|line| line.message == Some(message)) {
                self.transcript_scroll.reveal(at, lines.len(), view);
            }
        }
        self.history = self.transcript_scroll.viewing_history(lines.len(), view);
        if let Some(hit) = self.current_hit() {
            for line in &mut lines {
                if line.message == Some(hit.message) {
                    line.hit = true;
                }
            }
        }
        self.view_lines = lines;
    }

    pub fn viewing_history(&self) -> bool {
        self.history
    }

    pub fn thread_title(&self) -> String {
        if self.viewing_history() && self.screen == Screen::Chat {
            "chat · viewing history".into()
        } else {
            self.screen.title().into()
        }
    }

    pub fn status_text(&self) -> String {
        let (tokens, calls, model) = match &self.snapshot {
            Some(snap) => (
                snap.boards.today_tokens,
                snap.boards.today_calls,
                snap.boards.model.clone(),
            ),
            None => (None, None, String::new()),
        };
        let elapsed = self
            .turn_started_ms
            .map(|start| self.now_ms.saturating_sub(start));
        let state = if self.busy {
            connection_state(self.connected, true, elapsed)
        } else if self.connected {
            "connected".into()
        } else if self.notice.starts_with("cannot reach") {
            "offline".into()
        } else {
            "connecting".into()
        };
        status_line(&self.profiles.active, &model, tokens, calls, &state)
    }

    pub fn page_rows(&self) -> Vec<String> {
        match self.screen {
            Screen::Approvals => self.approval_rows(),
            Screen::Status => self.status_rows(),
            Screen::Config => self.config_rows(),
            Screen::Skills => board_or(&self.snapshot, |s| s.boards.skills.clone(), "Skills"),
            Screen::Tools => board_or(&self.snapshot, |s| s.boards.tools.clone(), "Tools"),
            Screen::Connections => {
                board_or(&self.snapshot, |s| s.boards.connections.clone(), "Connections")
            }
            Screen::Claude => board_or(&self.snapshot, |s| s.boards.engine.clone(), "Claude Code"),
            Screen::Bridge => {
                board_or(&self.snapshot, |s| s.boards.bridge.clone(), "Desktop bridge")
            }
            _ => vec![],
        }
    }

    pub fn palette_matches(&self) -> Vec<Candidate> {
        let items = self.palette_candidates();
        let query = self.palette.as_ref().map(|p| p.query.as_str()).unwrap_or("");
        rank(query, &items).into_iter().cloned().collect()
    }

    pub fn search_hits(&self) -> Vec<Hit> {
        let Some(query) = self.search.as_ref().map(|s| s.query.clone()) else {
            return Vec::new();
        };
        let Some(detail) = &self.detail else {
            return Vec::new();
        };
        let refs: Vec<&str> = detail.messages.iter().map(|m| m.content.as_str()).collect();
        search(&refs, &query)
    }

    pub fn build_lines(&self, width: usize) -> Vec<ViewLine> {
        let width = width.max(8);
        let mut lines = Vec::new();
        if let Some(detail) = &self.detail {
            let last = detail.messages.len().saturating_sub(1);
            for (index, message) in detail.messages.iter().enumerate() {
                let drafting = self.busy && message.partial && message.role != "user" && index == last;
                if drafting {
                    continue;
                }
                if !self.busy && index == last && message.role != "user" {
                    if let Some(ms) = self.thought_ms {
                        let mut line = ViewLine::from_text(
                            format!("  {}", thinking::thought_line(ms)),
                            SpanKind::Dim,
                        );
                        line.message = Some(index);
                        lines.push(line);
                    }
                }
                lines.extend(self.message_view(index, message, width));
            }
            for action in detail.actions.iter().filter(|a| a.status == "pending") {
                lines.push(ViewLine::from_text(
                    format!("action  {} pending · {}", action.kind, action.title),
                    SpanKind::Warn,
                ));
            }
            for event in &detail.events {
                lines.push(ViewLine::from_text(format!("team  {event}"), SpanKind::Dim));
            }
        }
        if let Some(text) = &self.optimistic {
            let already = self.detail.as_ref().is_some_and(|d| {
                d.messages.iter().any(|m| m.role == "user" && m.content == *text)
            });
            if !already {
                lines.push(ViewLine {
                    spans: vec![
                        StyledSpan::new(format!("you  {text}"), SpanKind::Accent),
                        StyledSpan::new("  · rust-cli", SpanKind::Dim),
                    ],
                    message: None,
                    code_block: None,
                    hit: false,
                });
            }
        }
        if self.busy {
            let elapsed = self
                .turn_started_ms
                .map(|start| self.now_ms.saturating_sub(start))
                .unwrap_or(0);
            let reasoning = if self.thinking_reasoning.is_empty() {
                self.partial_text().unwrap_or_default()
            } else {
                self.thinking_reasoning.clone()
            };
            for spans in thinking::live_block(elapsed, &self.thinking_tools, &reasoning, width) {
                lines.push(ViewLine {
                    spans,
                    message: None,
                    code_block: None,
                    hit: false,
                });
            }
        }
        if let Some(label) = &self.proof.image_label {
            lines.push(ViewLine::from_text(label.clone(), SpanKind::Dim));
        }
        if lines.is_empty() {
            lines.push(ViewLine::from_text(
                "No messages yet. Press i to write.",
                SpanKind::Dim,
            ));
        }
        lines
    }

    pub fn key_palette(&mut self, key: Key) -> Vec<crate::app::Effect> {
        let Some(palette) = self.palette.as_mut() else {
            return vec![];
        };
        match key {
            Key::Esc => {
                self.palette = None;
                vec![]
            }
            Key::Enter => {
                let matches = self.palette_matches();
                let index = self.palette.as_ref().map(|p| p.index).unwrap_or(0);
                let Some(choice) = matches.get(index).cloned() else {
                    return vec![];
                };
                self.palette = None;
                self.run_palette(&choice.id)
            }
            Key::Up | Key::ShiftK => {
                if let Some(palette) = self.palette.as_mut() {
                    palette.index = palette.index.saturating_sub(1);
                }
                vec![]
            }
            Key::Down | Key::ShiftJ => {
                let len = self.palette_matches().len();
                if let Some(palette) = self.palette.as_mut() {
                    if palette.index + 1 < len {
                        palette.index += 1;
                    }
                }
                vec![]
            }
            Key::Backspace => {
                edit_backspace(&mut palette.query, &mut palette.cursor);
                palette.index = 0;
                vec![]
            }
            Key::Left => {
                edit_left(&mut palette.query, &mut palette.cursor);
                vec![]
            }
            Key::Right => {
                edit_right(&mut palette.query, &mut palette.cursor);
                vec![]
            }
            Key::Char(c) => {
                edit_insert(&mut palette.query, &mut palette.cursor, c, 80);
                palette.index = 0;
                vec![]
            }
            _ => vec![],
        }
    }

    pub fn key_search(&mut self, key: Key) -> Vec<crate::app::Effect> {
        let Some(search) = self.search.as_mut() else {
            return vec![];
        };
        match key {
            Key::Esc => {
                self.search = None;
                vec![]
            }
            Key::Enter | Key::Down | Key::ShiftJ => {
                let len = self.search_hits().len();
                if let Some(search) = self.search.as_mut() {
                    if let Some(next) = crate::search::move_hit(len, search.current, 1) {
                        search.current = next;
                    }
                }
                self.sync_search();
                vec![]
            }
            Key::Up | Key::ShiftK => {
                let len = self.search_hits().len();
                if let Some(search) = self.search.as_mut() {
                    if let Some(next) = crate::search::move_hit(len, search.current, -1) {
                        search.current = next;
                    }
                }
                self.sync_search();
                vec![]
            }
            Key::Backspace => {
                edit_backspace(&mut search.query, &mut search.cursor);
                if let Some(search) = self.search.as_mut() {
                    search.current = 0;
                }
                self.sync_search();
                vec![]
            }
            Key::Char(c) => {
                edit_insert(&mut search.query, &mut search.cursor, c, 200);
                if let Some(search) = self.search.as_mut() {
                    search.current = 0;
                }
                self.sync_search();
                vec![]
            }
            _ => vec![],
        }
    }

    pub fn key_profiles(&mut self, key: Key) -> Vec<crate::app::Effect> {
        let n = self.profiles.slots.len();
        match key {
            Key::Esc | Key::Char('p') => {
                self.profiles_open = false;
                vec![]
            }
            Key::Up | Key::Char('k') | Key::ShiftK => {
                self.profile_index = self.profile_index.saturating_sub(1);
                vec![]
            }
            Key::Down | Key::Char('j') | Key::ShiftJ => {
                if n > 0 && self.profile_index + 1 < n {
                    self.profile_index += 1;
                }
                vec![]
            }
            Key::Char(c @ '1'..='3') => {
                self.profile_index = (c as usize) - ('1' as usize);
                self.switch_to_index(self.profile_index)
            }
            Key::Enter => self.switch_to_index(self.profile_index),
            _ => vec![],
        }
    }

    pub fn key_attach(&mut self, key: Key) -> Vec<crate::app::Effect> {
        let Some(attach) = self.attach.as_mut() else {
            return vec![];
        };
        match key {
            Key::Esc => {
                self.attach = None;
                vec![]
            }
            Key::Enter => {
                let path = self.attach.as_ref().map(|a| a.path.clone()).unwrap_or_default();
                self.attach = None;
                self.finish_attach(&path)
            }
            Key::Backspace => {
                edit_backspace(&mut attach.path, &mut attach.cursor);
                vec![]
            }
            Key::Left => {
                edit_left(&mut attach.path, &mut attach.cursor);
                vec![]
            }
            Key::Right => {
                edit_right(&mut attach.path, &mut attach.cursor);
                vec![]
            }
            Key::Char(c) => {
                edit_insert(&mut attach.path, &mut attach.cursor, c, 512);
                vec![]
            }
            _ => vec![],
        }
    }

    pub fn key_scroll(&mut self, key: Key) -> Vec<crate::app::Effect> {
        if self.screen == Screen::Chat {
            let lines = self.build_lines(self.cols);
            let view = self.viewport.max(1);
            match key {
                Key::PageUp => self.transcript_scroll.page(true, lines.len(), view),
                Key::PageDown => self.transcript_scroll.page(false, lines.len(), view),
                Key::ShiftK => self.transcript_scroll.scroll_by(-1, lines.len(), view),
                Key::ShiftJ => self.transcript_scroll.scroll_by(1, lines.len(), view),
                Key::Home => self.transcript_scroll.jump_top(),
                Key::End => self.transcript_scroll.jump_bottom(lines.len(), view),
                _ => {}
            }
            self.history = self.transcript_scroll.viewing_history(lines.len(), view);
        } else {
            match key {
                Key::PageUp | Key::ShiftK => self.bump_page(-1, matches!(key, Key::PageUp)),
                Key::PageDown | Key::ShiftJ | Key::End => {
                    self.bump_page(1, matches!(key, Key::PageDown | Key::End))
                }
                Key::Home => {
                    self.page_scroll[self.screen.index()] = 0;
                }
                _ => {}
            }
        }
        vec![]
    }

    pub fn wheel(&mut self, x: u16, y: u16, up: bool) -> Vec<crate::app::Effect> {
        if self.screen == Screen::Chat && self.hit_thread.contains(x, y) {
            let lines = self.build_lines(self.cols);
            let view = self.viewport.max(1);
            self.transcript_scroll
                .scroll_by(if up { -3 } else { 3 }, lines.len(), view);
            self.history = self.transcript_scroll.viewing_history(lines.len(), view);
            return vec![];
        }
        if self.screen == Screen::Chat && self.hit_list.contains(x, y) {
            return self.move_list_pub(if up { -1 } else { 1 });
        }
        if self.hit_page.contains(x, y) || self.screen != Screen::Chat {
            self.bump_page(if up { -1 } else { 1 }, false);
        }
        vec![]
    }

    pub fn click(&mut self, x: u16, y: u16) -> Vec<crate::app::Effect> {
        if let Some(hit) = self
            .footer_hits
            .iter()
            .copied()
            .find(|hit| y == hit.y && x >= hit.x0 && x < hit.x1)
        {
            return self.open_screen_pub(hit.screen);
        }
        if self.screen == Screen::Chat && self.hit_composer.contains(x, y) {
            self.insert = true;
            return vec![];
        }
        if self.screen == Screen::Chat && self.hit_list.contains(x, y) {
            let row = y.saturating_sub(self.hit_list.y).saturating_sub(1) as usize;
            let ids = self.chat_ids();
            if row < ids.len() {
                self.list_index = row;
                let id = ids[row].clone();
                if self.chat_id.as_deref() != Some(id.as_str()) {
                    self.chat_id = Some(id.clone());
                    self.selected_message = None;
                    self.transcript_scroll = ScrollState::pinned();
                    return vec![crate::app::Effect::LoadChat(id)];
                }
            }
            return vec![];
        }
        if self.screen == Screen::Chat && self.hit_thread.contains(x, y) {
            let row = y.saturating_sub(self.hit_thread.y).saturating_sub(1) as usize;
            let index = self.transcript_scroll.offset + row;
            if let Some(line) = self.view_lines.get(index) {
                if let Some(message) = line.message {
                    self.selected_message = Some(message);
                    if let Some(block) = line.code_block {
                        self.code_focus = block;
                    }
                }
            }
        }
        vec![]
    }

    pub fn note_detail(&mut self, detail: &ChatDetail) {
        if !self.busy {
            return;
        }
        for event in &detail.team {
            let key = event_key(event);
            if self.turn_events.insert(key) {
                apply_event(&mut self.thinking_tools, &event.kind, &event.content);
            }
        }
        if let Some(text) = detail
            .messages
            .iter()
            .rev()
            .find(|m| m.partial && m.role != "user")
        {
            self.thinking_reasoning = display_text(&text.content);
        }
    }

    pub fn toggle_palette(&mut self) {
        self.help = false;
        self.search = None;
        self.profiles_open = false;
        self.attach = None;
        if self.palette.is_some() {
            self.palette = None;
        } else {
            self.palette = Some(PaletteUi {
                query: String::new(),
                cursor: 0,
                index: 0,
            });
        }
    }

    pub fn toggle_search(&mut self) {
        if self.screen != Screen::Chat {
            self.screen = Screen::Chat;
        }
        if self.search.is_some() {
            self.search = None;
        } else {
            self.search = Some(SearchUi {
                query: String::new(),
                cursor: 0,
                current: 0,
            });
            self.insert = false;
        }
    }

    pub fn open_profiles(&mut self) {
        self.profile_index = self
            .profiles
            .slots
            .iter()
            .position(|slot| slot.name == self.profiles.active)
            .unwrap_or(0);
        self.profiles_open = true;
    }

    pub fn cycle_theme(&mut self) {
        self.theme_id = theme::cycle(self.theme_id);
        self.theme = theme::theme(self.theme_id);
        self.notice = format!("Theme: {}.", self.theme_id.label());
    }

    pub fn yank_selected(&mut self, fallback_latest: bool) -> Vec<crate::app::Effect> {
        let index = match self.selected_message {
            Some(index) => index,
            None if fallback_latest => self
                .detail
                .as_ref()
                .filter(|d| !d.messages.is_empty())
                .map(|d| d.messages.len() - 1)
                .unwrap_or(usize::MAX),
            None => {
                self.notice = "Select a message with [ and ], then y to copy it.".into();
                return vec![];
            }
        };
        if index == usize::MAX {
            self.notice = "No message to copy.".into();
            return vec![];
        }
        let Some(text) = self
            .detail
            .as_ref()
            .and_then(|d| d.messages.get(index))
            .map(|m| display_text(&m.content))
        else {
            self.notice = "No message to copy.".into();
            return vec![];
        };
        self.selected_message = Some(index);
        self.clipboard = Some(encode_osc52(&text));
        self.notice = "Copied the message.".into();
        vec![]
    }

    pub fn copy_block(&mut self) -> Vec<crate::app::Effect> {
        let Some(index) = self.selected_message else {
            self.notice = "Select a message with [ and ], then c to copy its code.".into();
            return vec![];
        };
        let Some(content) = self
            .detail
            .as_ref()
            .and_then(|d| d.messages.get(index))
            .map(|m| display_text(&m.content))
        else {
            self.notice = "No message selected.".into();
            return vec![];
        };
        let doc = render_markdown(&content, self.cols);
        let Some(block) = doc
            .code_blocks
            .get(self.code_focus)
            .or_else(|| doc.code_blocks.first())
        else {
            self.notice = "That message has no code block.".into();
            return vec![];
        };
        let lang = if block.lang.is_empty() {
            "code".to_string()
        } else {
            block.lang.clone()
        };
        self.clipboard = Some(encode_osc52(&block.source));
        self.notice = format!("Copied the {lang} block.");
        vec![]
    }

    fn message_view(&self, index: usize, message: &Message, width: usize) -> Vec<ViewLine> {
        let user = message.role == "user";
        let who = if user { "you" } else { "sam" };
        let who_kind = if user { SpanKind::Accent } else { SpanKind::Text };
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
        let body = display_text(&message.content);
        let doc = render_markdown(&body, width.saturating_sub(4));
        let mut lines = Vec::new();
        let mut first = true;
        for md in &doc.lines {
            let mut spans = Vec::new();
            if first {
                spans.push(StyledSpan::new(format!("{who}  "), who_kind));
                if !when.is_empty() {
                    spans.push(StyledSpan::new(when.clone(), SpanKind::Dim));
                }
                spans.extend(md.spans.clone());
                if !reaction.is_empty() {
                    spans.push(StyledSpan::new(reaction.clone(), SpanKind::Text));
                }
                if user {
                    if let Some(source) = &message.source {
                        spans.push(StyledSpan::new(format!("  · {source}"), SpanKind::Dim));
                    }
                }
                if message.partial && !self.busy {
                    spans.push(StyledSpan::new("  · incomplete", SpanKind::Dim));
                }
                first = false;
            } else if md.spans.iter().all(|s| s.text.is_empty()) {
                continue;
            } else {
                spans.push(StyledSpan::new("    ", SpanKind::Text));
                spans.extend(md.spans.clone());
            }
            if md.fence_header && self.selected_message == Some(index) {
                let focus = self.code_focus.min(doc.code_blocks.len().saturating_sub(1));
                if md.code_block == Some(focus) {
                    spans.push(StyledSpan::new("   · c copies this block", SpanKind::Dim));
                }
            }
            lines.push(ViewLine {
                spans,
                message: Some(index),
                code_block: md.code_block,
                hit: false,
            });
        }
        if lines.is_empty() {
            lines.push(ViewLine {
                spans: vec![StyledSpan::new(format!("{who}  {reaction}"), who_kind)],
                message: Some(index),
                code_block: None,
                hit: false,
            });
        }
        lines
    }

    fn finish_attach(&mut self, raw: &str) -> Vec<crate::app::Effect> {
        let path = attach::expand_path(raw);
        match attach::load_attachment(&path, &self.composer) {
            Ok((name, markdown)) => {
                self.attachment = Some(markdown);
                self.attachment_name = Some(name);
                self.insert = true;
                self.notice = "Attached. Enter sends it with the composer.".into();
            }
            Err(err) => self.notice = err,
        }
        vec![]
    }

    fn run_palette(&mut self, id: &str) -> Vec<crate::app::Effect> {
        use crate::app::Effect;
        if let Some(name) = id.strip_prefix("screen:") {
            let screen = match name {
                "chat" => Screen::Chat,
                "approvals" => Screen::Approvals,
                "status" => Screen::Status,
                "config" => Screen::Config,
                "skills" => Screen::Skills,
                "tools" => Screen::Tools,
                "connections" => Screen::Connections,
                "claude" => Screen::Claude,
                "bridge" => Screen::Bridge,
                _ => return vec![],
            };
            return self.open_screen_pub(screen);
        }
        if let Some(name) = id.strip_prefix("profile:") {
            return self.request_switch(name);
        }
        if let Some(chat) = id.strip_prefix("chat:") {
            self.chat_id = Some(chat.to_string());
            self.screen = Screen::Chat;
            self.insert = false;
            if let Some(index) = self
                .snapshot
                .as_ref()
                .and_then(|s| s.chats.iter().position(|c| c.id == chat))
            {
                self.list_index = index;
            }
            return vec![Effect::LoadChat(chat.to_string())];
        }
        if let Some(action) = id.strip_prefix("approval:") {
            self.screen = Screen::Approvals;
            if let Some(index) = self.snapshot.as_ref().and_then(|s| {
                s.actions
                    .iter()
                    .filter(|a| a.status == "pending")
                    .position(|a| a.id == action)
            }) {
                self.approval_index = index;
            }
            return vec![Effect::Refresh];
        }
        match id {
            "action:new-chat" => {
                if self.inflight {
                    return vec![];
                }
                self.inflight = true;
                vec![Effect::CreateChat("Terminal".into())]
            }
            "action:theme" => {
                self.cycle_theme();
                vec![]
            }
            "action:search" => {
                self.toggle_search();
                vec![]
            }
            "action:attach" => {
                self.screen = Screen::Chat;
                self.attach = Some(AttachUi {
                    path: String::new(),
                    cursor: 0,
                });
                vec![]
            }
            "action:yank" => self.yank_selected(true),
            "action:help" => {
                self.help = true;
                vec![]
            }
            "action:quit" => vec![Effect::Quit],
            _ => vec![],
        }
    }

    fn palette_candidates(&self) -> Vec<Candidate> {
        let mut items = vec![
            cand("screen:chat", "Chat", "section"),
            cand("screen:approvals", "Approvals", "section"),
            cand("screen:status", "Status", "section"),
            cand("screen:config", "Config", "section"),
            cand("screen:skills", "Skills", "section"),
            cand("screen:tools", "Tools", "section"),
            cand("screen:connections", "Connections", "section"),
            cand("screen:claude", "Claude Code", "section"),
            cand("screen:bridge", "Desktop bridge", "section"),
            cand("action:new-chat", "New chat", "action"),
            cand("action:theme", "Toggle theme", "action"),
            cand("action:search", "Search messages", "action"),
            cand("action:attach", "Attach image", "action"),
            cand("action:yank", "Copy selected message", "action"),
            cand("action:help", "Help", "action"),
            cand("action:quit", "Quit", "action"),
            cand("profile:dip", "Profile dip", "profile"),
            cand("profile:trading", "Profile trading", "profile"),
            cand("profile:second-shift", "Profile second-shift", "profile"),
        ];
        if let Some(snap) = &self.snapshot {
            for chat in &snap.chats {
                items.push(Candidate {
                    id: format!("chat:{}", chat.id),
                    label: chat.title.clone(),
                    group: "chat".into(),
                });
            }
            for action in snap.actions.iter().filter(|a| a.status == "pending") {
                items.push(Candidate {
                    id: format!("approval:{}", action.id),
                    label: format!("Approval {}", action.title),
                    group: "approval".into(),
                });
            }
        }
        items
    }

    fn request_switch(&mut self, name: &str) -> Vec<crate::app::Effect> {
        let name = crate::config::canonical_profile(name);
        self.profiles_open = false;
        if name == self.profiles.active && self.pending_profile.is_none() {
            self.notice = format!("Already talking to {name}.");
            return vec![];
        }
        let Some(slot) = self.profiles.get(&name).cloned() else {
            self.notice = format!("{name} is not configured.");
            return vec![];
        };
        let Some(base_url) = slot.base_url else {
            self.notice = format!("{name} is not configured.");
            return vec![];
        };
        self.pending_profile = Some(name.clone());
        self.notice = format!("Switching to {name}…");
        vec![crate::app::Effect::UseProfile {
            base_url,
            token: slot.token,
        }]
    }

    fn switch_to_index(&mut self, index: usize) -> Vec<crate::app::Effect> {
        let Some(name) = self.profiles.slots.get(index).map(|s| s.name.clone()) else {
            return vec![];
        };
        self.request_switch(&name)
    }

    pub(crate) fn sync_search(&mut self) {
        let hits = self.search_hits();
        if hits.is_empty() {
            return;
        }
        let current = self.search.as_ref().map(|s| s.current).unwrap_or(0) % hits.len();
        if let Some(search) = self.search.as_mut() {
            search.current = current;
        }
        let hit = hits[current];
        self.selected_message = Some(hit.message);
        self.pending_reveal = Some(hit.message);
        self.relayout();
    }

    fn current_hit(&self) -> Option<Hit> {
        let hits = self.search_hits();
        let current = self.search.as_ref()?.current;
        hits.get(current).copied()
    }

    pub(crate) fn move_selection(&mut self, delta: isize) {
        let n = self.detail.as_ref().map(|d| d.messages.len()).unwrap_or(0);
        if n == 0 {
            self.notice = "No messages to select.".into();
            return;
        }
        let next = match self.selected_message {
            None => {
                if delta < 0 {
                    n - 1
                } else {
                    0
                }
            }
            Some(current) => (current as isize + delta).clamp(0, n as isize - 1) as usize,
        };
        self.selected_message = Some(next);
        self.code_focus = 0;
        self.pending_reveal = Some(next);
        self.notice.clear();
    }

    fn open_screen_pub(&mut self, screen: Screen) -> Vec<crate::app::Effect> {
        self.insert = false;
        if screen == Screen::Chat {
            self.screen = Screen::Chat;
            if self.chat_id.is_none() {
                if let Some(id) = self
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.chats.first().map(|c| c.id.clone()))
                {
                    self.chat_id = Some(id.clone());
                    self.list_index = 0;
                    return vec![crate::app::Effect::LoadChat(id)];
                }
            }
            return vec![];
        }
        self.screen = screen;
        vec![crate::app::Effect::Refresh]
    }

    fn move_list_pub(&mut self, delta: isize) -> Vec<crate::app::Effect> {
        let ids = self.chat_ids();
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
        self.selected_message = None;
        self.transcript_scroll = ScrollState::pinned();
        self.history = false;
        vec![crate::app::Effect::LoadChat(id)]
    }

    fn chat_ids(&self) -> Vec<String> {
        self.snapshot
            .as_ref()
            .map(|s| s.chats.iter().map(|c| c.id.clone()).collect())
            .unwrap_or_default()
    }

    pub(crate) fn event_keys(&self) -> HashSet<String> {
        self.detail
            .as_ref()
            .map(|d| d.team.iter().map(event_key).collect())
            .unwrap_or_default()
    }

    fn partial_text(&self) -> Option<String> {
        self.detail.as_ref().and_then(|d| {
            d.messages
                .iter()
                .rev()
                .find(|m| m.partial && m.role != "user")
                .map(|m| display_text(&m.content))
        })
    }
}

fn event_key(event: &TeamEvent) -> String {
    format!(
        "{}|{}|{}|{}",
        event.created_at, event.kind, event.agent, event.content
    )
}

fn board_or(
    snapshot: &Option<Snapshot>,
    pick: impl Fn(&Snapshot) -> Vec<String>,
    title: &str,
) -> Vec<String> {
    match snapshot {
        Some(snap) => pick(snap),
        None => vec![format!("{title} not loaded yet.")],
    }
}

fn cand(id: &str, label: &str, group: &str) -> Candidate {
    Candidate {
        id: id.into(),
        label: label.into(),
        group: group.into(),
    }
}

pub fn push_text(buf: &mut String, cursor: &mut usize, text: &str, limit: usize) {
    for ch in text.chars() {
        edit_insert(buf, cursor, ch, limit);
    }
}

fn edit_insert(buf: &mut String, cursor: &mut usize, ch: char, limit: usize) {
    if buf.chars().count() >= limit || ch.is_control() {
        return;
    }
    let at = (*cursor).min(buf.len());
    buf.insert(at, ch);
    *cursor = at + ch.len_utf8();
}

fn edit_backspace(buf: &mut String, cursor: &mut usize) {
    if *cursor == 0 {
        return;
    }
    let at = (*cursor).min(buf.len());
    if let Some(ch) = buf[..at].chars().next_back() {
        let start = at - ch.len_utf8();
        buf.replace_range(start..at, "");
        *cursor = start;
    }
}

fn edit_left(buf: &str, cursor: &mut usize) {
    let at = (*cursor).min(buf.len());
    if let Some(ch) = buf[..at].chars().next_back() {
        *cursor = at - ch.len_utf8();
    }
}

fn edit_right(buf: &str, cursor: &mut usize) {
    let at = (*cursor).min(buf.len());
    if let Some(ch) = buf[at..].chars().next() {
        *cursor = at + ch.len_utf8();
    }
}

// Silence unused import if a future edit drops ThemeId from this file.
#[allow(dead_code)]
fn _theme_name(id: ThemeId) -> &'static str {
    id.label()
}

// Zone and FooterHit are re-exported for the UI through App's public fields.
#[allow(dead_code)]
fn _zone_touch(zone: Zone, hit: FooterHit) -> bool {
    zone.contains(hit.x0, hit.y)
}
