// Scripted runner used by the smoke test. It draws the same widgets as
// the live terminal into a fixed buffer and writes that text to disk.

use crate::api::Client;
use crate::app::{App, Effect, Key, Screen};
use crate::runtime::Runtime;
use crate::ui;
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use std::fs;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

pub fn run_script(
    mut app: App,
    client: Client,
    script: &str,
    dump_dir: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dump_dir).map_err(|e| e.to_string())?;
    let runtime = Runtime::start(client);
    runtime.dispatch(&Effect::Refresh);
    for (number, raw) in script.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (word, arg) = line
            .split_once(' ')
            .map(|(w, a)| (w, a))
            .unwrap_or((line, ""));
        match word {
            "dump" => {
                if arg.is_empty() {
                    return Err(format!("line {}: dump needs a name", number + 1));
                }
                dump(&mut app, dump_dir, arg)?;
            }
            "key" => {
                let key = parse_key(arg).map_err(|e| format!("line {}: {e}", number + 1))?;
                let effects = app.on_key(key);
                if dispatch_all(&runtime, effects) {
                    break;
                }
            }
            "type" => {
                for ch in arg.chars() {
                    let effects = app.on_key(Key::Char(ch));
                    if dispatch_all(&runtime, effects) {
                        break;
                    }
                }
            }
            "wait" => {
                if arg.is_empty() {
                    return Err(format!("line {}: wait needs a condition", number + 1));
                }
                wait_for(&mut app, &runtime, arg, dump_dir)?;
            }
            "quit" => break,
            other => return Err(format!("line {}: unknown command {other}", number + 1)),
        }
    }
    write_proof(&app, dump_dir)?;
    Ok(())
}

fn dispatch_all(runtime: &Runtime, effects: Vec<Effect>) -> bool {
    let mut quit = false;
    for effect in effects {
        if matches!(effect, Effect::Quit) {
            quit = true;
        }
        runtime.dispatch(&effect);
    }
    quit
}

fn wait_for(app: &mut App, runtime: &Runtime, cond: &str, dump_dir: &Path) -> Result<(), String> {
    let started = Instant::now();
    let limit = if cond.starts_with("reply:") || cond.starts_with("reaction:") {
        Duration::from_secs(40)
    } else {
        Duration::from_secs(20)
    };
    loop {
        drain(app, runtime);
        if satisfied(app, cond) {
            return Ok(());
        }
        if started.elapsed() > limit {
            let _ = dump(app, dump_dir, "timeout");
            return Err(format!(
                "timed out waiting for {cond}; notice={}",
                if app.notice.is_empty() {
                    "(none)"
                } else {
                    app.notice.as_str()
                }
            ));
        }
        thread::sleep(Duration::from_millis(30));
    }
}

fn drain(app: &mut App, runtime: &Runtime) {
    while let Some(ev) = runtime.try_recv() {
        let effects = app.apply(ev);
        for effect in effects {
            runtime.dispatch(&effect);
        }
    }
}

fn satisfied(app: &App, cond: &str) -> bool {
    if let Some(text) = cond.strip_prefix("reply:") {
        // The proof records the POST body as soon as it returns. The view
        // is only ready once a later read of the chat contains that text.
        return app
            .detail
            .as_ref()
            .map(|d| {
                d.messages
                    .iter()
                    .any(|m| m.role != "user" && m.content.contains(text))
            })
            .unwrap_or(false);
    }
    if let Some(name) = cond.strip_prefix("reaction:") {
        return match name {
            "eyes" | "working" => app.proof.saw_working_reaction,
            "heart" => {
                app.proof.saw_heart_reaction
                    && app.detail.as_ref().is_some_and(|d| {
                        d.messages.iter().any(|m| {
                            m.reaction.as_deref().unwrap_or("").contains('❤')
                        })
                    })
            }
            _ => false,
        };
    }
    match cond {
        "splash" => app.screen == Screen::Splash,
        "connected" => app.connected,
        "chats" => app.proof.chats_loaded > 0 && app.proof.chat_open,
        "pending" => app
            .snapshot
            .as_ref()
            .map(|s| s.actions.iter().any(|a| a.status == "pending"))
            .unwrap_or(false),
        "approved" => app.proof.approval_status.as_deref() == Some("done"),
        "rejected" => app.proof.approval_status.as_deref() == Some("rejected"),
        "status" => app.screen == Screen::Status && app.snapshot.is_some(),
        "config" => app.screen == Screen::Config && app.snapshot.is_some(),
        "idle" => !app.busy && !app.inflight,
        _ => false,
    }
}

fn dump(app: &mut App, dir: &Path, name: &str) -> Result<(), String> {
    let text = render_text(app)?;
    fs::write(dir.join(format!("{name}.txt")), &text).map_err(|e| e.to_string())?;
    write_proof(app, dir)
}

fn render_text(app: &mut App) -> Result<String, String> {
    let backend = TestBackend::new(100, 40);
    let mut terminal = Terminal::new(backend).map_err(|e| e.to_string())?;
    terminal
        .draw(|frame| ui::render(frame, app))
        .map_err(|e| e.to_string())?;
    Ok(buffer_text(terminal.backend().buffer()))
}

fn buffer_text(buffer: &ratatui::buffer::Buffer) -> String {
    let mut lines = Vec::new();
    for y in 0..buffer.area.height {
        let mut line = String::new();
        for x in 0..buffer.area.width {
            line.push_str(buffer[(x, y)].symbol());
        }
        lines.push(line.trim_end().to_string());
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n") + "\n"
}

fn write_proof(app: &App, dir: &Path) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&app.proof).map_err(|e| e.to_string())?;
    fs::write(dir.join("proof.json"), json + "\n").map_err(|e| e.to_string())
}

fn parse_key(raw: &str) -> Result<Key, String> {
    Ok(match raw {
        "enter" => Key::Enter,
        "esc" => Key::Esc,
        "backspace" => Key::Backspace,
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "tab" => Key::Char('\t'),
        "question" => Key::Char('?'),
        "space" => Key::Char(' '),
        other if other.chars().count() == 1 => Key::Char(other.chars().next().unwrap()),
        other => return Err(format!("unknown key {other}")),
    })
}
