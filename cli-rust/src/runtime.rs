// One background thread talks to SAM so the terminal stays responsive
// while a turn is in flight. During a send it polls the chat, which is
// how the working (eyes) and heart reactions show up before the reply.

use crate::api::{Client, SendResult};
use crate::app::{Effect, Ev};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

enum Cmd {
    Refresh,
    LoadChat(String),
    Send { chat_id: String, content: String },
    Decide { id: String, approve: bool },
    CreateChat(String),
}

pub struct Runtime {
    tx: Sender<Cmd>,
    rx: Receiver<Ev>,
}

impl Runtime {
    pub fn start(client: Client) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (ev_tx, ev_rx) = mpsc::channel();
        thread::Builder::new()
            .name("sam-cli-http".into())
            .spawn(move || worker(client, cmd_rx, ev_tx))
            .expect("http thread");
        Self {
            tx: cmd_tx,
            rx: ev_rx,
        }
    }

    pub fn dispatch(&self, effect: &Effect) {
        let cmd = match effect {
            Effect::Quit => return,
            Effect::Refresh => Cmd::Refresh,
            Effect::LoadChat(id) => Cmd::LoadChat(id.clone()),
            Effect::Send { chat_id, content } => Cmd::Send {
                chat_id: chat_id.clone(),
                content: content.clone(),
            },
            Effect::Decide { id, approve } => Cmd::Decide {
                id: id.clone(),
                approve: *approve,
            },
            Effect::CreateChat(title) => Cmd::CreateChat(title.clone()),
        };
        let _ = self.tx.send(cmd);
    }

    pub fn try_recv(&self) -> Option<Ev> {
        self.rx.try_recv().ok()
    }
}

fn worker(client: Client, cmd_rx: Receiver<Cmd>, ev_tx: Sender<Ev>) {
    while let Ok(cmd) = cmd_rx.recv() {
        match cmd {
            Cmd::Refresh => {
                let _ = ev_tx.send(Ev::Status(client.status()));
            }
            Cmd::LoadChat(id) => {
                let _ = ev_tx.send(Ev::Chat(client.chat(&id)));
            }
            Cmd::Send { chat_id, content } => send(&client, &ev_tx, chat_id, content),
            Cmd::Decide { id, approve } => {
                let _ = ev_tx.send(Ev::Decided(client.decide(&id, approve)));
            }
            Cmd::CreateChat(title) => {
                let _ = ev_tx.send(Ev::Created(client.create_chat(&title)));
            }
        }
    }
}

fn send(client: &Client, ev_tx: &Sender<Ev>, chat_id: String, content: String) {
    let poster = client.clone();
    let id_for_post = chat_id.clone();
    let (done_tx, done_rx) = mpsc::channel::<Result<SendResult, String>>();
    thread::spawn(move || {
        let _ = done_tx.send(poster.send_message(&id_for_post, &content));
    });
    let started = Instant::now();
    loop {
        match done_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(result) => {
                let _ = ev_tx.send(Ev::Sent(result));
                break;
            }
            Err(RecvTimeoutError::Timeout) => {
                if started.elapsed() > Duration::from_secs(90) {
                    let _ = ev_tx.send(Ev::Sent(Err("timed out waiting for SAM".into())));
                    break;
                }
                if let Ok(detail) = client.chat(&chat_id) {
                    let _ = ev_tx.send(Ev::Poll(detail));
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}
