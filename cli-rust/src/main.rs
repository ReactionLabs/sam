mod api;
mod app;
mod attach;
mod boards;
mod clipboard;
mod config;
mod headless;
mod image_proto;
mod markdown;
mod palette;
mod runtime;
mod scroll;
mod search;
mod status_view;
mod statusbar;
mod surface;
mod theme;
mod thinking;
mod ui;
mod wordmark;

use crate::api::{resolve_endpoint, Client};
use crate::app::{App, Effect, Key, Pointer};
use crate::config::load_session;
use crate::image_proto::detect_image_protocol;
use crate::runtime::Runtime;
use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::env;
use std::io::{self, stdout, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

struct Args {
    help: bool,
    base_url: Option<String>,
    token: Option<String>,
    config: Option<String>,
    script: Option<String>,
    dump_dir: Option<String>,
}

fn main() {
    if let Err(err) = run() {
        let _ = restore_terminal();
        eprintln!("sam-cli: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    if args.help {
        print_help();
        return Ok(());
    }
    let session = load_session(
        args.config.as_deref().map(std::path::Path::new),
        args.base_url.as_deref(),
        args.token.as_deref(),
    )?;
    let endpoint = resolve_endpoint(&session.connection.base_url, session.connection.token)?;
    let workspace = env::var_os("SAM_WORKSPACE").map(PathBuf::from);
    let client = Client::new(endpoint.clone(), workspace);
    let protocol = detect_image_protocol(|key| env::var(key).unwrap_or_default());
    let mut app = App::new(endpoint.origin, protocol);
    app.profiles = session.profiles;
    if let Some(id) = env::var("SAM_CLI_THEME")
        .ok()
        .and_then(|name| theme::parse_theme(&name))
    {
        app.theme_id = id;
        app.theme = theme::theme(id);
    }
    let script = args
        .script
        .or_else(|| env::var("SAM_CLI_SCRIPT").ok())
        .filter(|s| !s.trim().is_empty());
    if let Some(path) = script {
        let script = std::fs::read_to_string(&path).map_err(|e| format!("reading {path}: {e}"))?;
        let dump = args
            .dump_dir
            .or_else(|| env::var("SAM_CLI_DUMP_DIR").ok())
            .unwrap_or_else(|| "cli-rust/smoke-out".into());
        return headless::run_script(app, client, &script, std::path::Path::new(&dump));
    }
    if env::var("SAM_CLI_HEADLESS").ok().as_deref() == Some("1") {
        return Err("SAM_CLI_HEADLESS=1 needs a script (--script or SAM_CLI_SCRIPT)".into());
    }
    run_tui(app, client)
}

fn run_tui(mut app: App, client: Client) -> Result<(), String> {
    install_panic_hook();
    enable_raw_mode().map_err(|e| e.to_string())?;
    let mut out = stdout();
    execute!(
        out,
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    )
    .map_err(|e| e.to_string())?;
    let _guard = TerminalGuard;
    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend).map_err(|e| e.to_string())?;
    let runtime = Runtime::start(client);
    runtime.dispatch(&Effect::Refresh);
    let started = Instant::now();
    loop {
        app.tick(started.elapsed().as_millis() as u64);
        terminal
            .draw(|frame| ui::render(frame, &mut app))
            .map_err(|e| e.to_string())?;
        emit_image(&app);
        emit_clipboard(&mut app);
        if event::poll(Duration::from_millis(50)).map_err(|e| e.to_string())? {
            match event::read().map_err(|e| e.to_string())? {
                Event::Key(key)
                    if key.kind == KeyEventKind::Press || key.kind == KeyEventKind::Repeat =>
                {
                    if let Some(mapped) = map_key(key.code, key.modifiers) {
                        let effects = app.on_key(mapped);
                        if dispatch_keys(&runtime, effects) {
                            break;
                        }
                    }
                }
                Event::Paste(text) => {
                    let effects = app.on_paste(&text);
                    if dispatch_keys(&runtime, effects) {
                        break;
                    }
                }
                Event::Mouse(mouse) => {
                    if let Some(pointer) = map_mouse(mouse.kind, mouse.column, mouse.row) {
                        let effects = app.on_pointer(pointer);
                        if dispatch_keys(&runtime, effects) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
        while let Some(stamped) = runtime.try_recv() {
            let effects = runtime::accept(&mut app, stamped);
            if dispatch_keys(&runtime, effects) {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn dispatch_keys(runtime: &Runtime, effects: Vec<Effect>) -> bool {
    let quit = effects.iter().any(|e| matches!(e, Effect::Quit));
    for effect in &effects {
        runtime.dispatch(effect);
    }
    quit
}

fn emit_image(app: &App) {
    let (Some((x, y)), Some(sequence)) = (app.image_anchor, app.image_sequence.as_deref()) else {
        return;
    };
    let mut out = stdout();
    let _ = execute!(out, crossterm::cursor::MoveTo(x, y));
    let _ = write!(out, "{sequence}");
    let _ = out.flush();
}

fn map_key(code: KeyCode, modifiers: KeyModifiers) -> Option<Key> {
    let ctrl = modifiers.contains(KeyModifiers::CONTROL);
    let shift = modifiers.contains(KeyModifiers::SHIFT);
    if ctrl {
        return match code {
            KeyCode::Char('c') | KeyCode::Char('C') => Some(Key::CtrlC),
            KeyCode::Char('k') | KeyCode::Char('K') => Some(Key::CtrlK),
            KeyCode::Char('f') | KeyCode::Char('F') => Some(Key::CtrlF),
            KeyCode::Char('y') | KeyCode::Char('Y') => Some(Key::CtrlY),
            _ => None,
        };
    }
    match code {
        KeyCode::Enter => Some(Key::Enter),
        KeyCode::Esc => Some(Key::Esc),
        KeyCode::Backspace => Some(Key::Backspace),
        KeyCode::Up => Some(Key::Up),
        KeyCode::Down => Some(Key::Down),
        KeyCode::Left => Some(Key::Left),
        KeyCode::Right => Some(Key::Right),
        KeyCode::PageUp => Some(Key::PageUp),
        KeyCode::PageDown => Some(Key::PageDown),
        KeyCode::Home => Some(Key::Home),
        KeyCode::End => Some(Key::End),
        KeyCode::Char('j') | KeyCode::Char('J') if shift => Some(Key::ShiftJ),
        KeyCode::Char('k') | KeyCode::Char('K') if shift => Some(Key::ShiftK),
        KeyCode::Char(c) => Some(Key::Char(c)),
        _ => None,
    }
}

fn map_mouse(kind: MouseEventKind, x: u16, y: u16) -> Option<Pointer> {
    match kind {
        MouseEventKind::Down(MouseButton::Left) => Some(Pointer::Click { x, y }),
        MouseEventKind::ScrollUp => Some(Pointer::Wheel { x, y, up: true }),
        MouseEventKind::ScrollDown => Some(Pointer::Wheel { x, y, up: false }),
        _ => None,
    }
}

fn emit_clipboard(app: &mut App) {
    let Some(sequence) = app.clipboard.take() else {
        return;
    };
    let mut out = stdout();
    let _ = write!(out, "{sequence}");
    let _ = out.flush();
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = restore_terminal();
        previous(info);
    }));
}

fn restore_terminal() -> io::Result<()> {
    disable_raw_mode()?;
    execute!(
        stdout(),
        DisableMouseCapture,
        DisableBracketedPaste,
        LeaveAlternateScreen
    )?;
    Ok(())
}

struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = restore_terminal();
    }
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        help: false,
        base_url: None,
        token: None,
        config: None,
        script: None,
        dump_dir: None,
    };
    let mut it = env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut take = |name: &str| -> Result<String, String> {
            it.next().ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "-h" | "--help" => args.help = true,
            "--base-url" => args.base_url = Some(take("--base-url")?),
            "--token" => args.token = Some(take("--token")?),
            "--config" => args.config = Some(take("--config")?),
            "--script" => args.script = Some(take("--script")?),
            "--dump-dir" => args.dump_dir = Some(take("--dump-dir")?),
            other => return Err(format!("unknown argument {other} (try --help)")),
        }
    }
    Ok(args)
}

fn print_help() {
    println!(
        "\
sam-cli — terminal client for a running SAM

Usage:
  sam-cli [--base-url URL] [--token TOKEN] [--config FILE]
  sam-cli --script smoke.txt --dump-dir out/

Environment:
  SAM_BASE_URL     dashboard origin, the /sam door, or /dashboard/<token>
  SAM_TOKEN        dashboard token (not needed when the URL carries it)
  SAM_CONFIG       config file, default ~/.config/sam/cli.json
  SAM_WORKSPACE    optional folder for image paths named in a reply
  SAM_TUI_IMAGE    kitty | iterm2 | off
  SAM_CLI_THEME    muse (default) or harbor
  SAM_PROFILE      dip, trading, or second-shift

The config file must be mode 0600. Keys: 1 chat, 2 approvals, 3 status,
4 config, 5 skills, 6 tools, 7 connections, 8 claude code, 9 desktop bridge.
j/k move, J/K or pgup/pgdn scroll, i write, enter send, a attach, [ ] select,
y copy, c copy a code block, ctrl-k palette, ctrl-f search, p profiles,
t theme, ? help, q quit. Outgoing messages are stamped rust-cli.
"
    );
}
