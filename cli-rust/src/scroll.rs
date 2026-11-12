// Transcript scroll. `follow` means the view is pinned to the latest
// line; new messages keep the tail in view. Scrolling up clears the pin
// and the caller shows a "viewing history" indicator until the tail is
// visible again.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScrollState {
    pub offset: usize,
    pub follow: bool,
}

impl ScrollState {
    pub fn pinned() -> Self {
        Self {
            offset: 0,
            follow: true,
        }
    }

    pub fn max_offset(total: usize, viewport: usize) -> usize {
        total.saturating_sub(viewport.max(1))
    }

    pub fn sync(&mut self, total: usize, viewport: usize) {
        let max = Self::max_offset(total, viewport);
        if self.follow || self.offset >= max {
            self.offset = max;
            self.follow = true;
        }
    }

    pub fn viewing_history(&self, total: usize, viewport: usize) -> bool {
        let max = Self::max_offset(total, viewport);
        !self.follow && self.offset < max && total > viewport.max(1)
    }

    pub fn scroll_by(&mut self, delta: isize, total: usize, viewport: usize) {
        let max = Self::max_offset(total, viewport);
        if delta < 0 {
            self.follow = false;
            self.offset = self.offset.saturating_sub(delta.unsigned_abs());
        } else {
            self.offset = self.offset.saturating_add(delta as usize).min(max);
            if self.offset >= max {
                self.offset = max;
                self.follow = true;
            } else {
                self.follow = false;
            }
        }
    }

    pub fn page(&mut self, up: bool, total: usize, viewport: usize) {
        let step = viewport.max(1).saturating_sub(1).max(1) as isize;
        self.scroll_by(if up { -step } else { step }, total, viewport);
    }

    pub fn jump_top(&mut self) {
        self.offset = 0;
        self.follow = false;
    }

    pub fn jump_bottom(&mut self, total: usize, viewport: usize) {
        self.follow = true;
        self.sync(total, viewport);
    }

    /// Put `line` inside the viewport without pinning, unless it is the tail.
    pub fn reveal(&mut self, line: usize, total: usize, viewport: usize) {
        let viewport = viewport.max(1);
        let max = Self::max_offset(total, viewport);
        if line <= self.offset {
            self.offset = line.min(max);
        } else if line >= self.offset + viewport {
            self.offset = line.saturating_sub(viewport - 1).min(max);
        }
        self.follow = self.offset >= max;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follow_bottom_until_the_reader_scrolls_up() {
        let mut scroll = ScrollState::pinned();
        scroll.sync(100, 10);
        assert_eq!(scroll.offset, 90);
        assert!(!scroll.viewing_history(100, 10));

        scroll.page(true, 100, 10);
        assert!(scroll.viewing_history(100, 10));
        assert!(!scroll.follow);
        assert_eq!(scroll.offset, 81);

        let held = scroll.offset;
        scroll.sync(120, 10);
        assert_eq!(scroll.offset, held);
        assert!(scroll.viewing_history(120, 10));

        scroll.scroll_by(1, 40, 10);
        scroll.jump_bottom(120, 10);
        assert!(scroll.follow);
        assert_eq!(scroll.offset, 110);
        assert!(!scroll.viewing_history(120, 10));
    }

    #[test]
    fn wheel_and_shift_move_by_a_line_and_the_tail_repins() {
        let mut scroll = ScrollState::pinned();
        scroll.sync(30, 10);
        scroll.scroll_by(-1, 30, 10);
        assert_eq!(scroll.offset, 19);
        assert!(scroll.viewing_history(30, 10));
        scroll.scroll_by(1, 30, 10);
        assert!(scroll.follow);
        assert!(!scroll.viewing_history(30, 10));
    }

    #[test]
    fn reveal_puts_a_match_on_screen() {
        let mut scroll = ScrollState::pinned();
        scroll.sync(80, 10);
        scroll.reveal(4, 80, 10);
        assert_eq!(scroll.offset, 4);
        assert!(scroll.viewing_history(80, 10));
        scroll.reveal(70, 80, 10);
        assert!(scroll.offset <= 70 && 70 < scroll.offset + 10);
    }
}
