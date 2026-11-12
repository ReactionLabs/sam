//! Drives the real sam-cli client and views against the loopback dashboard.

use sam_cli::api::resolve_endpoint;
use sam_cli::app::{App, Effect, Ev, Key, Screen};
use sam_cli::harness::{
    assert_screen, render_screen, FakeDashboard, CONNECTOR_ID, DEMO_TOKEN, PENDING_ACTION,
    SCRATCH_CHAT, SMOKE_CHAT,
};
use sam_cli::image_proto::ImageProtocol;
use sam_cli::status_view::parse_snapshot;
use serde_json::json;
use std::thread;
use std::time::{Duration, Instant};

fn wait_until(mut pred: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if pred() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    pred()
}

fn connect(dash: &FakeDashboard) -> App {
    let mut app = App::new(dash.origin(), ImageProtocol::None);
    let status = dash.client().status().expect("status");
    app.apply(Ev::Status(Ok(status)));
    let effects = app.on_key(Key::Char('1'));
    for effect in effects {
        if let Effect::LoadChat(id) = effect {
            let detail = dash.client().chat(&id).expect("chat");
            app.apply(Ev::Chat(Ok(detail)));
        }
    }
    app
}

#[test]
fn stable_door_resolves_the_fixture_token() {
    let dash = FakeDashboard::spawn();
    let endpoint = resolve_endpoint(&dash.door_url(), None).expect("door");
    assert_eq!(endpoint.origin, dash.origin());
    assert_eq!(endpoint.token, dash.token());
    assert_eq!(endpoint.token, DEMO_TOKEN);
    let explicit = resolve_endpoint(dash.origin(), Some(dash.token().into())).unwrap();
    assert_eq!(explicit.token, dash.token());
}

#[test]
fn status_round_trip_sorts_pinned_chats_and_reads_lifetime_spend() {
    let dash = FakeDashboard::spawn();
    let (code, raw) = dash.get_json(&format!("/api/status/{}", dash.token()));
    assert_eq!(code, 200);
    assert_eq!(raw["chats"][0]["title"], "Scratch");
    assert_eq!(raw["usage"]["totalTokens"], 1200);
    assert_eq!(raw["usage"]["calls"], 12);
    assert_eq!(raw["usage"]["today"]["totalTokens"], 320);
    assert_eq!(raw["usage"]["today"]["calls"], 4);
    assert_eq!(raw["config"]["defaultAgent"], "dip");
    assert_eq!(raw["models"][1]["model"], "grok-4");
    assert_eq!(raw["skills"][0]["name"], "agent-reach");
    assert!(raw["agents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|agent| agent["name"] == "second-shift"));
    assert_eq!(raw["connectors"][0]["id"], CONNECTOR_ID);
    assert_eq!(raw["connectors"][0]["credentialPresent"], true);
    assert!(raw["connectors"][0].get("token").is_none());
    assert_eq!(raw["engine"]["connection"]["connected"], true);
    assert_eq!(raw["engine"]["running"], 1);
    assert_eq!(raw["tools"][0]["name"], "sam_memory_search");
    assert_eq!(raw["auth"]["key"], "present");
    assert_eq!(raw["auth"]["keyEnv"], "SAM_MODEL_API_KEY");

    let snap = dash.client().status().expect("client status");
    assert!(snap.ok);
    assert_eq!(snap.chats[0].id, SMOKE_CHAT);
    assert_eq!(snap.chats[0].title, "Smoke");
    assert!(snap.chats[0].pinned);
    assert_eq!(snap.chats[0].agent, "dip");
    assert_eq!(snap.chats[1].id, SCRATCH_CHAT);
    assert_eq!(snap.chats[1].agent, "trading");
    assert!(snap
        .surfaces
        .spend
        .iter()
        .any(|line| line.contains("1200 tokens")));
    assert!(snap
        .surfaces
        .spend
        .iter()
        .any(|line| line.contains("12 calls")));
    assert!(!snap.surfaces.spend.iter().any(|line| line.contains("320")));
    assert!(snap
        .surfaces
        .model
        .iter()
        .any(|line| line.contains("grok-4")));
    let rendered = format!("{:?}", snap.surfaces);
    // Spend names actors. It does not name skills, tools, or profile instructions.
    assert!(rendered.contains("second-shift"));
    assert!(!rendered.contains("sam_memory_search"));
    assert!(!rendered.contains("agent-reach"));
    assert!(!rendered.contains("Second Shift"));
}

#[test]
fn production_status_omits_unshipped_fields() {
    let dash = FakeDashboard::spawn_production();
    let (code, raw) = dash.get_json(&format!("/api/status/{}", dash.token()));
    assert_eq!(code, 200);
    assert!(raw.get("tools").is_none());
    assert!(raw.get("channels").is_none());
    assert!(raw["usage"].get("today").is_none());
    assert!(raw.get("skills").is_some());
    assert!(raw.get("agents").is_some());
    assert!(raw.get("connectors").is_some());
    assert!(raw.get("engine").is_some());
    assert!(raw.get("pairing").is_some());
    assert_eq!(raw["usage"]["totalTokens"], 1200);

    let mut app = connect(&dash);
    app.on_key(Key::Char('4'));
    let screen = render_screen(&mut app, 80, 24);
    assert!(screen.contains("pairing desk"));
    assert!(!screen.contains("SAM_CHANNEL_DESK"));
}

#[test]
fn proposed_channels_reach_the_existing_config_view() {
    let dash = FakeDashboard::spawn();
    let mut app = connect(&dash);
    app.on_key(Key::Char('4'));
    let screen = render_screen(&mut app, 80, 24);
    assert!(screen.contains("SAM_CHANNEL_DESK"));
    assert!(screen.contains("grok-4"));
}

#[test]
fn unauthenticated_status_is_rejected_and_errors_hide_the_token() {
    let dash = FakeDashboard::spawn();
    let (code, _) = dash.get_json("/api/status");
    assert_eq!(code, 401);
    let (code, _) = dash.get_json("/api/status?token=0123456789abcdef0123456789abcdef");
    assert_eq!(code, 200);
    let err = dash
        .client()
        .chat("not-a-real-chat")
        .expect_err("missing chat");
    assert!(!err.contains(DEMO_TOKEN), "{err}");
}

#[test]
fn create_send_and_decide_use_the_live_client() {
    let dash = FakeDashboard::spawn();
    let client = dash.client();
    let id = client.create_chat("Terminal").expect("create");
    let sent = client.send_message(&id, "hello").expect("send");
    assert_eq!(sent.reply, "Noted.");
    assert_eq!(sent.user_reaction.as_deref(), Some("❤️"));
    let detail = client.chat(&id).expect("detail");
    assert_eq!(detail.messages.len(), 2);
    assert!(detail
        .messages
        .iter()
        .any(|message| message.content == "hello"));
    let action = client.decide(PENDING_ACTION, true).expect("decide");
    assert_eq!(action.status, "done");
    assert_eq!(action.result.as_deref(), Some("recorded"));
    let snap = client.status().expect("status");
    assert!(snap
        .chats
        .iter()
        .any(|chat| chat.id == id && chat.title == "Terminal"));
    assert!(!snap.actions.iter().any(|action| action.status == "pending"));
    let posted = dash.requests();
    assert!(posted.iter().any(|request| {
        request.method == "POST"
            && request.path.contains("/decide")
            && request.dashboard_header.as_deref() == Some("dashboard")
            && request.body.contains("approve")
    }));
}

#[test]
fn message_post_without_the_dashboard_header_is_refused() {
    let dash = FakeDashboard::spawn();
    let (code, body) = dash.post_without_dashboard_header(
        &format!("/api/{}/chats/{SMOKE_CHAT}/messages", dash.token()),
        &json!({"content": "nope"}),
    );
    assert_eq!(code, 400);
    assert_eq!(
        body["error"],
        "Message failed. Check model configuration and server logs."
    );
    let detail = dash.client().chat(SMOKE_CHAT).unwrap();
    assert!(!detail
        .messages
        .iter()
        .any(|message| message.content == "nope"));
}

#[test]
fn unknown_model_failure_is_not_echoed() {
    let dash = FakeDashboard::spawn();
    dash.update(|state| state.fail_next = Some("boom secret-token-text".into()));
    let err = dash
        .client()
        .send_message(SMOKE_CHAT, "fail")
        .expect_err("fail");
    assert!(err.contains("Message failed"));
    assert!(!err.contains("boom"));
    assert!(!err.contains("secret-token-text"));
    let known = dash.client();
    dash.update(|state| state.fail_next = Some("Model not configured".into()));
    let err = known.send_message(SMOKE_CHAT, "again").expect_err("known");
    assert!(err.contains("Model not configured"));
}

#[test]
fn held_turn_shows_eyes_then_a_partial_then_the_reply() {
    let dash = FakeDashboard::spawn();
    dash.hold_next_turn();
    let client = dash.client();
    let handle = thread::spawn(move || client.send_message(SMOKE_CHAT, "Hold please"));
    assert!(wait_until(|| dash.turn_is_waiting()));
    dash.push_partial("Still thinking");
    let detail = dash.client().chat(SMOKE_CHAT).expect("poll");
    assert!(detail
        .messages
        .iter()
        .any(|message| message.reaction.as_deref() == Some("👀")));
    assert!(detail
        .messages
        .iter()
        .any(|message| message.content == "Still thinking"));
    let (code, raw) = dash.get_json(&format!("/api/{}/chats/{SMOKE_CHAT}", dash.token()));
    assert_eq!(code, 200);
    let partial = raw["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["content"] == "Still thinking")
        .expect("partial row");
    assert_eq!(partial["partial"], 1);

    let (busy, _) = dash.post_json(
        &format!("/api/{}/chats/{SMOKE_CHAT}/messages", dash.token()),
        &json!({"content": "second"}),
    );
    assert_eq!(busy, 409);

    dash.release_turn();
    let sent = handle.join().expect("thread").expect("reply");
    assert_eq!(sent.reply, "Noted.");
    assert_eq!(sent.user_reaction.as_deref(), Some("❤️"));
    let after = dash.client().chat(SMOKE_CHAT).unwrap();
    let finished = after
        .messages
        .iter()
        .find(|message| message.content == "Noted.")
        .expect("final");
    assert_eq!(finished.role, "assistant");
    let (code, raw) = dash.get_json(&format!("/api/{}/chats/{SMOKE_CHAT}", dash.token()));
    assert_eq!(code, 200);
    let row = raw["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["content"] == "Noted.")
        .unwrap();
    assert_eq!(row["partial"], 0);
}

#[test]
fn profile_switch_uses_config_and_the_chat_profile_route() {
    let dash = FakeDashboard::spawn();
    let (code, body) = dash.post_json(
        &format!("/api/{}/config", dash.token()),
        &json!({"defaultAgent": "trading", "showTeamEvents": true}),
    );
    assert_eq!(code, 200);
    assert_eq!(body["defaultAgent"], "trading");
    let (code, _) = dash.post_json(
        &format!("/api/{}/config", dash.token()),
        &json!({"defaultAgent": "nope", "showTeamEvents": true}),
    );
    assert_eq!(code, 400);
    let (code, _) = dash.post_json(
        &format!("/api/{}/chats/{SMOKE_CHAT}/profile", dash.token()),
        &json!({"agent": "second-shift"}),
    );
    assert_eq!(code, 200);
    let snap = dash.client().status().unwrap();
    let smoke = snap
        .chats
        .iter()
        .find(|chat| chat.id == SMOKE_CHAT)
        .unwrap();
    assert_eq!(smoke.agent, "second-shift");
    let (code, _) = dash.post_json(
        &format!("/api/{}/chats/{SMOKE_CHAT}/profile", dash.token()),
        &json!({"agent": "nope"}),
    );
    assert_eq!(code, 404);
    let (code, _) = dash.post_json(
        &format!("/api/{}/chats/{SMOKE_CHAT}/profile", dash.token()),
        &json!({"agent": "sam"}),
    );
    assert_eq!(code, 200);
    let snap = dash.client().status().unwrap();
    assert_eq!(
        snap.chats
            .iter()
            .find(|chat| chat.id == SMOKE_CHAT)
            .unwrap()
            .agent,
        "sam"
    );
    assert_eq!(dash.status_json()["config"]["defaultAgent"], "trading");
}

#[test]
fn same_origin_image_in_a_reply_is_hydrated() {
    let dash = FakeDashboard::spawn();
    let origin = dash.origin().to_string();
    dash.update(|state| {
        state.reply = format!("see ![pixel]({origin}/media/pixel.png)");
    });
    let sent = dash.client().send_message(SMOKE_CHAT, "picture").unwrap();
    assert!(sent.reply.contains("/media/pixel.png"));
    let detail = dash.client().chat(SMOKE_CHAT).unwrap();
    assert!(
        detail.images.iter().any(|image| !image.bytes.is_empty()),
        "expected a decoded image"
    );
}

#[test]
fn views_render_from_a_fixture_fed_app() {
    let dash = FakeDashboard::spawn();
    let mut app = connect(&dash);
    assert_eq!(app.screen, Screen::Chat);
    let chat = render_screen(&mut app, 80, 24);
    assert!(chat.contains("Smoke"));
    assert!(chat.contains("Status?"));
    assert!(chat.contains("The ledger is quiet."));
    assert!(chat.contains("checked the ledger"));
    assert!(chat.contains("approvals"));
    let again = render_screen(&mut app, 80, 24);
    assert_eq!(chat.plain(), again.plain());

    app.on_key(Key::Char('2'));
    let approvals = render_screen(&mut app, 80, 24);
    assert!(approvals.contains("Save the ledger note"));
    assert!(approvals.contains("1 pending"));

    app.on_key(Key::Char('3'));
    let status = render_screen(&mut app, 80, 24);
    assert!(status.contains("1200 tokens"));
    assert!(status.contains("12 calls"));
    assert!(!status.contains("320"));
    assert!(!status.contains("sam_memory_search"));
    assert!(!status.contains("agent-reach"));
    assert!(!status.contains("Second Shift"));

    let mut splash = App::new(dash.origin(), ImageProtocol::None);
    let screen = render_screen(&mut splash, 60, 18);
    assert_screen(
        &screen,
        r#"


                  ██████     █████     ███   ███
                 ██         ██   ██    ████ ████
             >_   █████     ███████    ██ ███ ██
                      ██    ██   ██    ██  █  ██
                 ██████  ██ ██   ██ ██ ██     ██

                 Self-directed AI Workforce

                         connecting…
         any key continues   ·   ? help   ·   q quit
"#,
    );
}

#[test]
fn parser_ignores_proposed_fields_on_the_fixture_document() {
    let dash = FakeDashboard::spawn();
    let raw = dash.status_json();
    let snap = parse_snapshot(&raw).unwrap();
    assert!(snap
        .surfaces
        .spend
        .iter()
        .any(|line| line == "1200 tokens · 12 calls"));
    assert!(!format!("{:?}", snap).contains("320"));
}
