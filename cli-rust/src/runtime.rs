// One background thread talks to SAM so the terminal stays responsive
// while a turn is in flight. During a send it polls the chat, which is
// how the working (eyes) and heart reactions show up before the reply.
// A profile switch is applied on that same thread without waiting for
// the turn to finish. Events carry the epoch they were started under,
// so a reply from the SAM you just left is not drawn on the new one.

use crate::api::{resolve_endpoint, Client, SendResult};
use crate::app::{Effect, Ev};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

enum Cmd {
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

pub struct Stamped {
    pub epoch: u64,
    pub ev: Ev,
}

struct Inflight {
    chat_id: String,
    started: Instant,
    done_rx: Receiver<Result<SendResult, String>>,
    epoch: u64,
}

pub struct Runtime {
    tx: Sender<Cmd>,
    rx: Receiver<Stamped>,
}

impl Runtime {
    pub fn start(client: Client) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (ev_tx, ev_rx) = mpsc::channel();
        thread::Builder::new()
            .name("sam-cli-http".into())
            .spawn(move || worker(client, cmd_rx, ev_tx))
            .expect("http thread");
        Self { tx: cmd_tx, rx: ev_rx }
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
            Effect::UseProfile { base_url, token } => Cmd::UseProfile {
                base_url: base_url.clone(),
                token: token.clone(),
            },
        };
        let _ = self.tx.send(cmd);
    }

    pub fn try_recv(&self) -> Option<Stamped> {
        self.rx.try_recv().ok()
    }
}

fn worker(mut client: Client, cmd_rx: Receiver<Cmd>, ev_tx: Sender<Stamped>) {
    let mut epoch = 0u64;
    let mut inflight: Option<Inflight> = None;
    loop {
        let incoming = if inflight.is_some() {
            match cmd_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(cmd) => Some(cmd),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match cmd_rx.recv() {
                Ok(cmd) => Some(cmd),
                Err(_) => break,
            }
        };
        if let Some(cmd) = incoming {
            match cmd {
                Cmd::Refresh => {
                    let _ = ev_tx.send(stamp(epoch, Ev::Status(client.status())));
                }
                Cmd::LoadChat(id) => {
                    let _ = ev_tx.send(stamp(epoch, Ev::Chat(client.chat(&id))));
                }
                Cmd::Send { chat_id, content } if inflight.is_none() => {
                    inflight = Some(start_send(&client, chat_id, content, epoch));
                }
                Cmd::Send { .. } => {}
                Cmd::Decide { id, approve } => {
                    let _ = ev_tx.send(stamp(epoch, Ev::Decided(client.decide(&id, approve))));
                }
                Cmd::CreateChat(title) => {
                    let _ = ev_tx.send(stamp(epoch, Ev::Created(client.create_chat(&title))));
                }
                Cmd::UseProfile { base_url, token } => {
                    epoch = epoch.saturating_add(1);
                    match resolve_endpoint(&base_url, token) {
                        Ok(endpoint) => {
                            let origin = endpoint.origin.clone();
                            let workspace = client.workspace();
                            client = Client::new(endpoint, workspace);
                            let _ = ev_tx.send(stamp(
                                epoch,
                                Ev::Switched {
                                    epoch,
                                    result: Ok(origin),
                                },
                            ));
                            let _ = ev_tx.send(stamp(epoch, Ev::Status(client.status())));
                        }
                        Err(err) => {
                            let _ = ev_tx.send(stamp(
                                epoch,
                                Ev::Switched {
                                    epoch,
                                    result: Err(err),
                                },
                            ));
                        }
                    }
                }
            }
        }
        inflight = poll_inflight(inflight, &client, epoch, &ev_tx);
    }
}

fn start_send(client: &Client, chat_id: String, content: String, epoch: u64) -> Inflight {
    let poster = client.clone();
    let id_for_post = chat_id.clone();
    let (done_tx, done_rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = done_tx.send(poster.send_message(&id_for_post, &content));
    });
    Inflight {
        chat_id,
        started: Instant::now(),
        done_rx,
        epoch,
    }
}

fn poll_inflight(
    inflight: Option<Inflight>,
    client: &Client,
    epoch: u64,
    ev_tx: &Sender<Stamped>,
) -> Option<Inflight> {
    let Some(flight) = inflight else {
        return None;
    };
    match flight.done_rx.try_recv() {
        Ok(result) => {
            let _ = ev_tx.send(stamp(flight.epoch, Ev::Sent(result)));
            None
        }
        Err(TryRecvError::Disconnected) => None,
        Err(TryRecvError::Empty) => {
            if flight.started.elapsed() > Duration::from_secs(90) {
                let _ = ev_tx.send(stamp(
                    flight.epoch,
                    Ev::Sent(Err("timed out waiting for SAM".into())),
                ));
                return None;
            }
            if flight.epoch == epoch {
                if let Ok(detail) = client.chat(&flight.chat_id) {
                    let _ = ev_tx.send(stamp(flight.epoch, Ev::Poll(detail)));
                }
            }
            Some(flight)
        }
    }
}

fn stamp(epoch: u64, ev: Ev) -> Stamped {
    Stamped { epoch, ev }
}

/// Drop events from a SAM the operator has already switched away from.
pub fn accept(app: &mut crate::app::App, stamped: Stamped) -> Vec<Effect> {
    if let Ev::Switched { epoch, .. } = &stamped.ev {
        if *epoch < app.epoch {
            return Vec::new();
        }
        app.epoch = *epoch;
    } else if stamped.epoch != app.epoch {
        return Vec::new();
    }
    app.apply(stamped.ev)
}
