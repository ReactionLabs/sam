// Fuzzy ranking for the Ctrl+K palette. A query is a subsequence of the
// label. Consecutive letters and word starts score higher, so "appr"
// lands on Approvals before anything that merely contains those letters
// scattered. An empty query keeps the original order.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub label: String,
    pub group: String,
}

pub fn fuzzy_score(query: &str, label: &str) -> Option<i64> {
    let q: Vec<char> = query.trim().chars().flat_map(|c| c.to_lowercase()).collect();
    if q.is_empty() {
        return Some(0);
    }
    let chars: Vec<char> = label.chars().collect();
    let mut score = 0i64;
    let mut qi = 0;
    let mut prev: Option<usize> = None;
    for (i, ch) in chars.iter().enumerate() {
        if qi >= q.len() {
            break;
        }
        let folded: Vec<char> = ch.to_lowercase().collect();
        if folded.len() == 1 && folded[0] == q[qi] {
            score += 2;
            if prev == Some(i.saturating_sub(1)) {
                score += 8;
            }
            let boundary = i == 0
                || !chars[i - 1].is_alphanumeric()
                || (chars[i - 1].is_lowercase() && ch.is_uppercase());
            if boundary {
                score += 5;
            }
            if qi == 0 && i == 0 {
                score += 6;
            }
            prev = Some(i);
            qi += 1;
        }
    }
    if qi == q.len() {
        Some(score)
    } else {
        None
    }
}

pub fn rank<'a>(query: &str, items: &'a [Candidate]) -> Vec<&'a Candidate> {
    let mut scored: Vec<(i64, usize, &'a Candidate)> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| fuzzy_score(query, &item.label).map(|score| (score, index, item)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, item)| item).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items() -> Vec<Candidate> {
        ["Chat", "Approvals", "Status", "Skills", "Tools", "Connections"]
            .into_iter()
            .map(|label| Candidate {
                id: label.to_ascii_lowercase(),
                label: label.into(),
                group: "section".into(),
            })
            .collect()
    }

    #[test]
    fn fuzzy_match_prefers_the_compact_hit_and_drops_misses() {
        let items = items();
        let ranked = rank("appr", &items);
        assert_eq!(ranked[0].label, "Approvals");
        assert!(ranked.iter().all(|item| item.label != "Chat"));
        assert!(rank("zzz", &items).is_empty());
        assert!(fuzzy_score("sk", "Skills").unwrap() > fuzzy_score("sk", "Status").unwrap_or(0));
    }

    #[test]
    fn an_empty_query_keeps_palette_order() {
        let items = items();
        let ranked = rank("  ", &items);
        let labels: Vec<_> = ranked.iter().map(|item| item.label.as_str()).collect();
        assert_eq!(
            labels,
            vec!["Chat", "Approvals", "Status", "Skills", "Tools", "Connections"]
        );
    }
}
