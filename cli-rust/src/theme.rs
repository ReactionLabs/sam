// Two calm themes. Muse is the default: warm near-black surfaces, a
// hairline border, and one quiet accent. Harbor is the cooler sibling.
// Neither uses the saturated blue the dashboard is retiring.

use ratatui::style::Color;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeId {
    Muse,
    Harbor,
}

impl ThemeId {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            ThemeId::Muse => "muse",
            ThemeId::Harbor => "harbor",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ThemeId::Muse => "Muse",
            ThemeId::Harbor => "Harbor",
        }
    }
}

pub fn parse_theme(name: &str) -> Option<ThemeId> {
    match name.trim().to_ascii_lowercase().as_str() {
        "muse" | "default" | "calm" => Some(ThemeId::Muse),
        "harbor" | "ink" => Some(ThemeId::Harbor),
        _ => None,
    }
}

pub fn cycle(id: ThemeId) -> ThemeId {
    match id {
        ThemeId::Muse => ThemeId::Harbor,
        ThemeId::Harbor => ThemeId::Muse,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub id: ThemeId,
    pub bg: Color,
    pub surface: Color,
    pub raised: Color,
    pub hairline: Color,
    pub text: Color,
    pub dim: Color,
    pub accent: Color,
    pub ok: Color,
    pub warn: Color,
    pub string: Color,
}

pub fn theme(id: ThemeId) -> Theme {
    match id {
        ThemeId::Muse => Theme {
            id,
            bg: Color::Rgb(22, 22, 20),
            surface: Color::Rgb(30, 30, 27),
            raised: Color::Rgb(39, 38, 34),
            hairline: Color::Rgb(62, 60, 54),
            text: Color::Rgb(228, 224, 214),
            dim: Color::Rgb(140, 136, 124),
            accent: Color::Rgb(184, 164, 124),
            ok: Color::Rgb(138, 164, 140),
            warn: Color::Rgb(184, 132, 120),
            string: Color::Rgb(168, 176, 150),
        },
        ThemeId::Harbor => Theme {
            id,
            bg: Color::Rgb(16, 20, 26),
            surface: Color::Rgb(22, 28, 36),
            raised: Color::Rgb(30, 38, 48),
            hairline: Color::Rgb(52, 64, 78),
            text: Color::Rgb(220, 228, 234),
            dim: Color::Rgb(132, 148, 162),
            accent: Color::Rgb(130, 172, 186),
            ok: Color::Rgb(130, 170, 160),
            warn: Color::Rgb(196, 140, 132),
            string: Color::Rgb(168, 190, 176),
        },
    }
}

pub fn default_theme() -> Theme {
    theme(ThemeId::Muse)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn muse_is_the_default_and_harbor_is_the_other_face() {
        assert_eq!(ThemeId::Muse.as_str(), "muse");
        assert_eq!(ThemeId::Harbor.as_str(), "harbor");
        assert_eq!(parse_theme("muse"), Some(ThemeId::Muse));
        assert_eq!(parse_theme("  Default "), Some(ThemeId::Muse));
        assert_eq!(parse_theme("harbor"), Some(ThemeId::Harbor));
        assert_eq!(parse_theme("ink"), Some(ThemeId::Harbor));
        assert_eq!(parse_theme("neon"), None);
        assert_eq!(default_theme().id, ThemeId::Muse);
        assert_eq!(cycle(ThemeId::Muse), ThemeId::Harbor);
        assert_eq!(cycle(ThemeId::Harbor), ThemeId::Muse);
    }

    #[test]
    fn themes_are_layered_and_the_accent_is_quiet() {
        for id in [ThemeId::Muse, ThemeId::Harbor] {
            let theme = theme(id);
            assert_ne!(theme.bg, theme.surface, "{id:?} needs two surfaces");
            assert_ne!(theme.surface, theme.raised, "{id:?} needs a raised layer");
            assert_ne!(theme.hairline, theme.text, "{id:?} hairline should recede");
            assert_ne!(theme.accent, theme.text);
            assert_ne!(
                theme.accent,
                Color::Rgb(8, 100, 204),
                "the saturated dashboard blue stays retired"
            );
        }
        assert_ne!(theme(ThemeId::Muse).accent, theme(ThemeId::Harbor).accent);
        assert_ne!(theme(ThemeId::Muse).bg, theme(ThemeId::Harbor).bg);
    }
}
