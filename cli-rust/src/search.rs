// In-chat message search. Hits are byte ranges in the original message
// when ASCII case-folding does not change the length (the common case).
// A fold that changes length still records the message so jump-to-match
// works; the range collapses to the start of the message.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
    pub message: usize,
    pub start: usize,
    pub end: usize,
}

pub fn search(messages: &[&str], query: &str) -> Vec<Hit> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for (message, text) in messages.iter().enumerate() {
        let folded = text.to_lowercase();
        let same_len = folded.len() == text.len();
        let mut from = 0;
        while from < folded.len() {
            let Some(rel) = folded[from..].find(&needle) else {
                break;
            };
            let start = from + rel;
            let end = start + needle.len();
            if same_len {
                hits.push(Hit {
                    message,
                    start,
                    end,
                });
            } else {
                hits.push(Hit {
                    message,
                    start: 0,
                    end: 0,
                });
            }
            from = end.max(from + 1);
        }
    }
    hits
}

pub fn move_hit(len: usize, current: usize, delta: isize) -> Option<usize> {
    if len == 0 {
        return None;
    }
    let current = current.min(len - 1) as isize;
    let len = len as isize;
    Some(current.wrapping_add(delta).rem_euclid(len) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_is_case_insensitive_and_jumps_between_hits() {
        let messages = ["ping", "Pong from mock", "pong again, pong"];
        let hits = search(&messages, "PONG");
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].message, 1);
        assert_eq!(&messages[1][hits[0].start..hits[0].end], "Pong");
        assert_eq!(hits[1].message, 2);
        assert_eq!(hits[2].start, messages[2].rfind("pong").unwrap());
        assert!(search(&messages, "   ").is_empty());
        assert!(search(&messages, "absent").is_empty());
        assert_eq!(move_hit(hits.len(), 0, 1), Some(1));
        assert_eq!(move_hit(hits.len(), 2, 1), Some(0));
        assert_eq!(move_hit(hits.len(), 0, -1), Some(2));
        assert_eq!(move_hit(0, 0, 1), None);
    }
}
