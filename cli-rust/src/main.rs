use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use sam_cli::api::{resolve_endpoint, Client};
use sam_cli::app::{App, Effect, Key};
use sam_cli::config::load_connection;
use sam_cli::headless;
use sam_cli::image_proto::detect_image_protocol;
use sam_cli::runtime::Runtime;
use sam_cli::ui;
use std::env;
use std::io::{self, stdout, Write};
use std::path::PathBuf;
use std::time::Duration;

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
    let connection = load_connection(
        args.config.as_deref().map(std::path::Path::new),
        args.base_url.as_deref(),
        args.token.as_deref(),
    )?;
    let endpoint = resolve_endpoint(&connection.base_url, connection.token)?;
    let workspace = env::var_os("SAM_WORKSPACE").map(PathBuf::from);
    let client = Client::new(endpoint.clone(), workspace);
    let protocol = detect_image_protocol(|key| env::var(key).unwrap_or_default());
    let app = App::new(endpoint.origin, protocol);
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
    execute!(out, EnterAlternateScreen).map_err(|e| e.to_string())?;
    let _guard = TerminalGuard;
    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend).map_err(|e| e.to_string())?;
    let runtime = Runtime::start(client);
    runtime.dispatch(&Effect::Refresh);
    loop {
        terminal
            .draw(|frame| ui::render(frame, &mut app))
            .map_err(|e| e.to_string())?;
        emit_image(&app);
        if event::poll(Duration::from_millis(50)).map_err(|e| e.to_string())? {
            if let Event::Key(key) = event::read().map_err(|e| e.to_string())? {
                if key.kind == KeyEventKind::Press || key.kind == KeyEventKind::Repeat {
                    let mapped = map_key(key.code, key.modifiers);
                    if let Some(mapped) = mapped {
                        let effects = app.on_key(mapped);
                        let quit = effects.iter().any(|e| matches!(e, Effect::Quit));
                        for effect in &effects {
                            runtime.dispatch(effect);
                        }
                        if quit {
                            break;
                        }
                    }
                }
            }
        }
        while let Some(ev) = runtime.try_recv() {
            let effects = app.apply(ev);
            let quit = effects.iter().any(|e| matches!(e, Effect::Quit));
            for effect in &effects {
                runtime.dispatch(effect);
            }
            if quit {
                return Ok(());
            }
        }
    }
    Ok(())
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
    if modifiers.contains(KeyModifiers::CONTROL)
        && matches!(code, KeyCode::Char('c') | KeyCode::Char('C'))
    {
        return Some(Key::CtrlC);
    }
    Some(match code {
        KeyCode::Enter => Key::Enter,
        KeyCode::Esc => Key::Esc,
        KeyCode::Backspace => Key::Backspace,
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::Left => Key::Left,
        KeyCode::Right => Key::Right,
        KeyCode::Char(c) => Key::Char(c),
        _ => return None,
    })
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
    execute!(stdout(), LeaveAlternateScreen)?;
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

The config file must be mode 0600. Keys: 1 chat, 2 approvals, 3 status,
4 config, j/k move, i write, enter send, y approve, x reject, ? help, q quit.
"
    );
}
