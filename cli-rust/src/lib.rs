//! Terminal client for a running SAM.
//!
//! The binary is a thin `main`. Tests and the view work link this library.
//! [`harness`] is the loopback dashboard and the ratatui screen snapshots.
//! The HTTP contract, including fields the real server does not send yet,
//! is `cli-rust/API.md`.

pub mod api;
pub mod app;
pub mod attach;
pub mod boards;
pub mod clipboard;
pub mod config;
pub mod harness;
pub mod headless;
pub mod image_proto;
pub mod markdown;
pub mod palette;
pub mod runtime;
pub mod scroll;
pub mod search;
pub mod status_view;
pub mod statusbar;
pub mod surface;
pub mod theme;
pub mod thinking;
pub mod ui;
pub mod wordmark;

pub use harness::{assert_screen, render_screen, FakeDashboard, Screen};
