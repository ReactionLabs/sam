use crate::app::{App, FooterHit, Screen, Zone, HELP};
use crate::markdown::SpanKind;
use crate::theme::Theme;
use crate::wordmark::{sam_wordmark, TAGLINE};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

pub fn render(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    let theme = app.theme;
    frame.render_widget(Block::default().style(Style::default().bg(theme.bg)), area);
    app.prepare_image(area.width);
    let (main, status, foot) = split_chrome(area);
    match app.screen {
        Screen::Splash => splash(frame, main, app),
        Screen::Chat => chat(frame, main, app),
        _ => page(frame, main, app),
    }
    paint_status(frame, app, status);
    paint_footer(frame, app, foot);
    if app.palette.is_some() {
        palette(frame, area, app);
    }
    if app.profiles_open {
        profiles(frame, area, app);
    }
    if app.help {
        help(frame, area, app);
    }
}

fn splash(frame: &mut Frame, area: Rect, app: &App) {
    let theme = app.theme;
    let mut lines = Vec::new();
    let pad = area.height.saturating_sub(14) / 2;
    for _ in 0..pad {
        lines.push(Line::raw(""));
    }
    for (i, row) in sam_wordmark().into_iter().enumerate() {
        let color = if i == 2 { theme.accent } else { theme.text };
        lines.push(Line::from(Span::styled(
            row,
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        )));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        TAGLINE,
        Style::default().fg(theme.accent),
    )));
    lines.push(Line::raw(""));
    let link = if app.connected {
        format!("{}  ·  connected", app.origin)
    } else if app.notice.is_empty() {
        "connecting…".into()
    } else {
        app.notice.clone()
    };
    lines.push(Line::from(Span::styled(link, Style::default().fg(theme.dim))));
    lines.push(Line::from(Span::styled(
        "any key continues   ·   ? help   ·   q quit",
        Style::default().fg(theme.dim),
    )));
    frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), area);
}

fn chat(frame: &mut Frame, area: Rect, app: &mut App) {
    let theme = app.theme;
    let (body, composer, notice) = split_body(area, !app.notice.is_empty());
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(28), Constraint::Min(20)])
        .split(body);
    app.hit_list = zone(cols[0]);
    app.hit_thread = zone(cols[1]);
    app.hit_composer = zone(composer);
    app.hit_page = Zone::default();
    app.layout_thread(
        cols[1].width.saturating_sub(2) as usize,
        cols[1].height.saturating_sub(2) as usize,
    );
    let title = app.thread_title();
    let list = Paragraph::new(join_lines(&app.chat_rows()))
        .block(panel(theme, "chats"))
        .wrap(Wrap { trim: false });
    let thread = Paragraph::new(styled(&app.view_lines, theme))
        .block(panel(theme, title.as_str()))
        .scroll((
            app.transcript_scroll.offset.min(u16::MAX as usize) as u16,
            0,
        ))
        .wrap(Wrap { trim: false });
    frame.render_widget(list, cols[0]);
    frame.render_widget(thread, cols[1]);
    if app.image_sequence.is_some() {
        let y = cols[1].y + cols[1].height.saturating_sub(2);
        app.image_anchor = Some((cols[1].x.saturating_add(1), y));
    }
    frame.render_widget(
        Paragraph::new(composer_line(app)).block(panel(theme, composer_title(app))),
        composer,
    );
    paint_notice(frame, app, notice);
}

fn page(frame: &mut Frame, area: Rect, app: &mut App) {
    let theme = app.theme;
    let (body, hint_area, notice) = split_body(area, !app.notice.is_empty());
    app.hit_list = Zone::default();
    app.hit_thread = Zone::default();
    app.hit_composer = Zone::default();
    app.hit_page = zone(body);
    let rows = scrolled(
        &app.page_rows(),
        app.page_scroll[app.screen.index()],
        body.height,
    );
    frame.render_widget(
        Paragraph::new(join_lines(&rows))
            .block(panel(theme, app.screen.title()))
            .wrap(Wrap { trim: false }),
        body,
    );
    frame.render_widget(
        Paragraph::new(page_hint(app.screen)).style(Style::default().fg(theme.dim)),
        hint_area,
    );
    paint_notice(frame, app, notice);
}

fn palette(frame: &mut Frame, area: Rect, app: &App) {
    let theme = app.theme;
    let popup = centered(area, 68, 16);
    frame.render_widget(Clear, popup);
    let matches = app.palette_matches();
    let query = app.palette.as_ref().map(|p| p.query.as_str()).unwrap_or("");
    let index = app.palette.as_ref().map(|p| p.index).unwrap_or(0);
    let mut lines = vec![Line::from(Span::styled(
        format!("find  {query}▌"),
        Style::default().fg(theme.text),
    ))];
    if matches.is_empty() {
        lines.push(Line::from(Span::styled(
            "no matches",
            Style::default().fg(theme.dim),
        )));
    }
    for (i, item) in matches.iter().take(12).enumerate() {
        let style = if i == index {
            Style::default()
                .fg(theme.accent)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme.text)
        };
        lines.push(Line::from(vec![
            Span::styled(format!("{:<12}", item.group), Style::default().fg(theme.dim)),
            Span::styled(item.label.clone(), style),
        ]));
    }
    frame.render_widget(
        Paragraph::new(lines).block(panel(theme, "commands")),
        popup,
    );
}

fn profiles(frame: &mut Frame, area: Rect, app: &App) {
    let theme = app.theme;
    let popup = centered(area, 64, 9);
    frame.render_widget(Clear, popup);
    let mut lines = vec![Line::from(Span::styled(
        "Switch SAM without leaving the terminal",
        Style::default().fg(theme.dim),
    ))];
    for (i, slot) in app.profiles.slots.iter().enumerate() {
        let mark = if i == app.profile_index { ">" } else { " " };
        let state = if slot.name == app.profiles.active {
            "this SAM"
        } else if slot.base_url.is_some() {
            "ready"
        } else {
            "not configured"
        };
        let host = slot
            .base_url
            .as_deref()
            .map(short_host)
            .unwrap_or_default();
        let style = if i == app.profile_index {
            Style::default().fg(theme.accent)
        } else {
            Style::default().fg(theme.text)
        };
        lines.push(Line::from(Span::styled(
            format!("{mark} {:<14} {state:<16} {host}", slot.name),
            style,
        )));
    }
    frame.render_widget(
        Paragraph::new(lines).block(panel(theme, "profiles")),
        popup,
    );
}

fn help(frame: &mut Frame, area: Rect, app: &App) {
    let popup = centered(area, 76, 24);
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Paragraph::new(HELP)
            .block(panel(app.theme, "help"))
            .wrap(Wrap { trim: false })
            .style(Style::default().fg(app.theme.text)),
        popup,
    );
}

fn split_chrome(area: Rect) -> (Rect, Rect, Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(5),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(area);
    (chunks[0], chunks[1], chunks[2])
}

fn split_body(area: Rect, with_notice: bool) -> (Rect, Rect, Option<Rect>) {
    let mut constraints = vec![Constraint::Min(3), Constraint::Length(3)];
    if with_notice {
        constraints.push(Constraint::Length(1));
    }
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);
    if with_notice {
        (chunks[0], chunks[1], Some(chunks[2]))
    } else {
        (chunks[0], chunks[1], None)
    }
}

fn paint_notice(frame: &mut Frame, app: &App, notice: Option<Rect>) {
    let Some(area) = notice else {
        return;
    };
    let theme = app.theme;
    let bad = app.notice.starts_with("cannot")
        || app.notice.starts_with("No ")
        || app.notice.starts_with("Stayed")
        || app.notice.contains("not configured")
        || app.notice.contains("too large")
        || app.notice.contains("refusing");
    let style = if bad {
        Style::default().fg(theme.warn)
    } else {
        Style::default().fg(theme.ok)
    };
    frame.render_widget(Paragraph::new(app.notice.clone()).style(style), area);
}

fn paint_status(frame: &mut Frame, app: &App, area: Rect) {
    let theme = app.theme;
    frame.render_widget(
        Paragraph::new(app.status_text()).style(Style::default().fg(theme.dim).bg(theme.bg)),
        area,
    );
}

fn paint_footer(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let sections = [
        (Screen::Chat, "1 chat"),
        (Screen::Approvals, "2 approvals"),
        (Screen::Status, "3 status"),
        (Screen::Config, "4 config"),
        (Screen::Skills, "5 skills"),
        (Screen::Tools, "6 tools"),
        (Screen::Connections, "7 links"),
        (Screen::Claude, "8 claude"),
        (Screen::Bridge, "9 bridge"),
    ];
    let mut spans = Vec::new();
    let mut hits = Vec::new();
    let mut x = area.x;
    for (screen, label) in sections {
        let text = format!("{label}  ");
        let width = text.chars().count() as u16;
        hits.push(FooterHit {
            x0: x,
            x1: x.saturating_add(width),
            y: area.y,
            screen,
        });
        let style = if app.screen == screen {
            Style::default()
                .fg(theme.accent)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme.dim)
        };
        spans.push(Span::styled(text, style));
        x = x.saturating_add(width);
    }
    spans.push(Span::styled("? ", Style::default().fg(theme.accent)));
    spans.push(Span::styled("help  ", Style::default().fg(theme.dim)));
    spans.push(Span::styled("q ", Style::default().fg(theme.accent)));
    spans.push(Span::styled("quit", Style::default().fg(theme.dim)));
    app.footer_hits = hits;
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(theme.bg)),
        area,
    );
}

fn composer_line(app: &App) -> String {
    if let Some(attach) = &app.attach {
        let mut shown = attach.path.clone();
        let at = attach.cursor.min(shown.len());
        shown.insert(at, '▌');
        return format!("path  {shown}");
    }
    if let Some(search) = &app.search {
        let n = app.search_hits().len();
        return format!(
            "find  {}   ·   {n} match{}",
            search.query,
            if n == 1 { "" } else { "es" }
        );
    }
    if app.busy {
        let elapsed_ms = app
            .now_ms
            .saturating_sub(app.turn_started_ms.unwrap_or(app.now_ms));
        return format!(
            "{} {} · {}",
            crate::thinking::spinner_frame(elapsed_ms),
            crate::thinking::verb(elapsed_ms),
            crate::thinking::elapsed_label(elapsed_ms)
        );
    }
    if app.insert {
        let mut shown = app.composer.clone();
        let at = app.cursor.min(shown.len());
        shown.insert(at, '▌');
        let prefix = app
            .attachment_name
            .as_ref()
            .map(|name| format!("attached {name}  ·  "))
            .unwrap_or_default();
        return format!("{prefix}> {shown}");
    }
    if let Some(name) = &app.attachment_name {
        return format!("attached {name}  ·  enter sends  ·  x removes");
    }
    "i write   ·   a attach   ·   ^K commands   ·   ^F search".into()
}

fn composer_title(app: &App) -> &'static str {
    if app.attach.is_some() {
        "attach"
    } else if app.search.is_some() {
        "search"
    } else {
        "composer"
    }
}

fn page_hint(screen: Screen) -> &'static str {
    match screen {
        Screen::Approvals => "j/k select   ·   y approve   ·   x reject   ·   pgup/pgdn scroll",
        Screen::Status => "j/k scroll   ·   provider health, activity, spend, failures",
        Screen::Config => "j/k scroll   ·   model, auth, channels",
        Screen::Skills => "j/k scroll   ·   installed skills and allowlists",
        Screen::Tools => "j/k scroll   ·   connector tools and code commands",
        Screen::Connections => "j/k scroll   ·   MCP connections, env names only",
        Screen::Claude => "j/k scroll   ·   engine status and the connect marker",
        Screen::Bridge => "j/k scroll   ·   desktop bridge, honest when it is not paired",
        _ => "",
    }
}

fn panel(theme: Theme, title: &str) -> Block<'_> {
    Block::default()
        .title(format!(" {title} "))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme.hairline))
        .style(Style::default().bg(theme.surface).fg(theme.text))
}

fn styled(lines: &[crate::app::ViewLine], theme: Theme) -> Vec<Line<'static>> {
    lines
        .iter()
        .map(|line| {
            let mut spans: Vec<Span> = line
                .spans
                .iter()
                .map(|span| {
                    let mut style = paint(theme, span.kind);
                    if line.hit {
                        style = style.bg(theme.raised);
                    }
                    Span::styled(span.text.clone(), style)
                })
                .collect();
            if spans.is_empty() {
                spans.push(Span::raw(""));
            }
            Line::from(spans)
        })
        .collect()
}

fn paint(theme: Theme, kind: SpanKind) -> Style {
    let fg = match kind {
        SpanKind::Text | SpanKind::Strong => theme.text,
        SpanKind::Dim | SpanKind::Comment => theme.dim,
        SpanKind::Accent | SpanKind::Keyword | SpanKind::Code => theme.accent,
        SpanKind::String => theme.string,
        SpanKind::Ok => theme.ok,
        SpanKind::Warn => theme.warn,
    };
    let mut style = Style::default().fg(fg);
    if kind == SpanKind::Strong {
        style = style.add_modifier(Modifier::BOLD);
    }
    if kind == SpanKind::Code {
        style = style.bg(theme.raised);
    }
    style
}

fn join_lines(rows: &[String]) -> String {
    rows.join("\n")
}

fn scrolled(rows: &[String], scroll: usize, height: u16) -> Vec<String> {
    let room = height.saturating_sub(2) as usize;
    let room = room.max(1);
    let max_start = rows.len().saturating_sub(room);
    let start = scroll.min(max_start);
    rows.iter().skip(start).cloned().collect()
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    }
}

fn zone(rect: Rect) -> Zone {
    Zone {
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
    }
}

fn short_host(url: &str) -> String {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    rest.split('/').next().unwrap_or(rest).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Key;
    use crate::image_proto::ImageProtocol;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn buffer_text(buffer: &ratatui::buffer::Buffer) -> String {
        let mut lines = Vec::new();
        for y in 0..buffer.area.height {
            let mut line = String::new();
            for x in 0..buffer.area.width {
                line.push_str(buffer[(x, y)].symbol());
            }
            lines.push(line.trim_end().to_string());
        }
        lines.join("\n")
    }

    #[test]
    fn rendering_uses_the_muse_surfaces_and_highlights_code() {
        let mut app = App::new("http://127.0.0.1:1", ImageProtocol::None);
        app.screen = Screen::Chat;
        app.connected = true;
        app.detail = Some(crate::api::ChatDetail {
            messages: vec![crate::api::Message {
                id: "a".into(),
                role: "assistant".into(),
                content: "```rust\nfn main() { let s = \"hi\"; }\n```".into(),
                created_at: "".into(),
                reaction: None,
                partial: false,
                source: None,
            }],
            events: vec![],
            team: vec![],
            actions: vec![],
            images: vec![],
        });
        app.on_key(Key::Char(']'));
        let backend = TestBackend::new(100, 32);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let text = buffer_text(&buffer);
        assert!(text.contains("fn"), "{text}");
        assert!(text.contains("main"), "{text}");
        assert!(
            text.contains("copies this block") || text.contains("rust"),
            "{text}"
        );
        assert!(text.contains("dip"), "{text}");
        assert_eq!(buffer[(0, 0)].bg, app.theme.surface, "panels sit above the base");
        assert_eq!(buffer[(0, 0)].fg, app.theme.hairline, "borders stay hairline");
        assert_eq!(buffer[(0, 30)].bg, app.theme.bg, "the status row is the base layer");
        let keyword = buffer
            .content()
            .iter()
            .find(|cell| cell.symbol() == "f")
            .expect("fn");
        assert_eq!(keyword.fg, app.theme.accent);
        app.viewport = 4;
        app.detail.as_mut().unwrap().messages[0].content = (0..40)
            .map(|n| format!("row {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        app.on_key(Key::PageUp);
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("viewing history"), "{text}");
    }
}
