use crate::app::{App, Screen, HELP};
use crate::wordmark::{sam_wordmark, TAGLINE};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

const CYAN: Color = Color::Rgb(34, 211, 238);
const DIM: Color = Color::Rgb(148, 163, 184);
const TEXT: Color = Color::Rgb(226, 232, 240);
const RED: Color = Color::Rgb(248, 113, 113);
const GREEN: Color = Color::Rgb(52, 211, 153);
const BG: Color = Color::Rgb(16, 17, 19);
const PANEL: Color = Color::Rgb(23, 24, 27);

const ROW_COLORS: [Color; 5] = [
    Color::Rgb(165, 243, 252),
    Color::Rgb(103, 232, 249),
    Color::Rgb(34, 211, 238),
    Color::Rgb(6, 182, 212),
    Color::Rgb(8, 145, 178),
];

pub fn render(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    frame.render_widget(Block::default().style(Style::default().bg(BG)), area);
    app.prepare_image(area.width);
    match app.screen {
        Screen::Splash => splash(frame, area, app),
        Screen::Chat => chat(frame, area, app),
        Screen::Approvals => {
            let rows = app.approval_rows();
            page(frame, area, app, "approvals", &rows);
        }
        Screen::Status => {
            let rows = scrolled(&app.status_rows(), app.status_scroll, area.height);
            page(frame, area, app, "status", &rows);
        }
        Screen::Config => {
            let rows = scrolled(&app.config_rows(), app.config_scroll, area.height);
            page(frame, area, app, "config", &rows);
        }
    }
    if app.help {
        help(frame, area);
    }
}

fn splash(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines = Vec::new();
    let pad = area.height.saturating_sub(14) / 2;
    for _ in 0..pad {
        lines.push(Line::raw(""));
    }
    for (i, row) in sam_wordmark().into_iter().enumerate() {
        lines.push(Line::from(Span::styled(
            row,
            Style::default()
                .fg(ROW_COLORS[i])
                .add_modifier(Modifier::BOLD),
        )));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(TAGLINE, Style::default().fg(CYAN))));
    lines.push(Line::raw(""));
    let link = if app.connected {
        format!("{}  ·  connected", app.origin)
    } else if app.notice.is_empty() {
        "connecting…".into()
    } else {
        app.notice.clone()
    };
    lines.push(Line::from(Span::styled(link, Style::default().fg(DIM))));
    lines.push(Line::from(Span::styled(
        "any key continues   ·   ? help   ·   q quit",
        Style::default().fg(DIM),
    )));
    frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), area);
}

fn chat(frame: &mut Frame, area: Rect, app: &mut App) {
    let (body, composer, notice, foot) = split_main(area, !app.notice.is_empty());
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(28), Constraint::Min(20)])
        .split(body);
    let list = Paragraph::new(join_lines(&app.chat_rows()))
        .block(panel("chats"))
        .wrap(Wrap { trim: false });
    let thread_lines = app.transcript();
    let room = cols[1].height.saturating_sub(2) as usize;
    let offset = thread_lines.len().saturating_sub(room.max(1)) as u16;
    let thread = Paragraph::new(join_lines(&thread_lines))
        .block(panel("chat"))
        .scroll((offset, 0))
        .wrap(Wrap { trim: false });
    frame.render_widget(list, cols[0]);
    frame.render_widget(thread, cols[1]);
    if app.image_sequence.is_some() {
        let y = cols[1].y + cols[1].height.saturating_sub(2);
        app.image_anchor = Some((cols[1].x.saturating_add(1), y));
    }
    let prompt = if app.busy {
        "SAM is working…".to_string()
    } else if app.insert {
        let mut shown = app.composer.clone();
        let at = app.cursor.min(shown.len());
        shown.insert(at, '▌');
        format!("> {shown}")
    } else {
        "i to write   ·   enter sends   ·   n new chat".into()
    };
    frame.render_widget(Paragraph::new(prompt).block(panel("composer")), composer);
    paint_notice_and_footer(frame, app, notice, foot);
}

fn page(frame: &mut Frame, area: Rect, app: &App, title: &str, rows: &[String]) {
    let (body, _composer, notice, foot) = split_main(area, !app.notice.is_empty());
    // Status and config use the whole body; the composer row becomes a hint.
    let hint = match app.screen {
        Screen::Approvals => "j/k select   ·   y approve   ·   x reject",
        Screen::Status => "j/k scroll   ·   provider health, activity, spend, failures",
        Screen::Config => "j/k scroll   ·   model, auth, channels",
        _ => "",
    };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(1)])
        .split(body);
    frame.render_widget(
        Paragraph::new(join_lines(rows))
            .block(panel(title))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    frame.render_widget(
        Paragraph::new(hint).style(Style::default().fg(DIM)),
        chunks[1],
    );
    let _ = _composer;
    paint_notice_and_footer(frame, app, notice, foot);
}

fn split_main(area: Rect, with_notice: bool) -> (Rect, Rect, Option<Rect>, Rect) {
    let mut constraints = vec![
        Constraint::Min(5),
        Constraint::Length(3),
        Constraint::Length(1),
    ];
    if with_notice {
        constraints.insert(2, Constraint::Length(1));
    }
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);
    if with_notice {
        (chunks[0], chunks[1], Some(chunks[2]), chunks[3])
    } else {
        (chunks[0], chunks[1], None, chunks[2])
    }
}

fn paint_notice_and_footer(frame: &mut Frame, app: &App, notice: Option<Rect>, foot: Rect) {
    if let Some(area) = notice {
        let style = if app.notice.starts_with("cannot") || app.notice.starts_with("No ") {
            Style::default().fg(RED)
        } else {
            Style::default().fg(GREEN)
        };
        frame.render_widget(Paragraph::new(app.notice.clone()).style(style), area);
    }
    frame.render_widget(Paragraph::new(footer_line()), foot);
}

fn footer_line() -> Line<'static> {
    let dim = Style::default().fg(DIM);
    let key = Style::default().fg(CYAN).add_modifier(Modifier::BOLD);
    Line::from(vec![
        Span::styled("1", key),
        Span::styled(" chat  ", dim),
        Span::styled("2", key),
        Span::styled(" approvals  ", dim),
        Span::styled("3", key),
        Span::styled(" status  ", dim),
        Span::styled("4", key),
        Span::styled(" config  ", dim),
        Span::styled("?", key),
        Span::styled(" help  ", dim),
        Span::styled("q", key),
        Span::styled(" quit", dim),
    ])
}

fn help(frame: &mut Frame, area: Rect) {
    let popup = centered(area, 72, 20);
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Paragraph::new(HELP)
            .block(panel("help"))
            .wrap(Wrap { trim: false })
            .style(Style::default().fg(TEXT)),
        popup,
    );
}

fn panel(title: &str) -> Block<'_> {
    Block::default()
        .title(format!(" {title} "))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Rgb(48, 49, 55)))
        .style(Style::default().bg(PANEL).fg(TEXT))
}

fn join_lines(rows: &[String]) -> String {
    rows.join("\n")
}

fn scrolled(rows: &[String], scroll: usize, height: u16) -> Vec<String> {
    let room = height.saturating_sub(6) as usize;
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
