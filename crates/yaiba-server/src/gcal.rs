//! Mapping a yaiba plan onto Google Calendar events.
//!
//! Everything here is pure: it turns a schedule and a list of events
//! already on the calendar into the calls that would make the second
//! agree with the first. Nothing in this module talks to Google, which
//! is deliberate — the parts that are easy to get wrong (which day an
//! all-day event ends on, which events are ours to delete) are the parts
//! that would otherwise only be checkable against a live account.
//!
//! Two decisions remove almost all of the state this could have needed.
//!
//! **The event id is derived from the task id.** `events.insert` takes a
//! client-supplied `id` drawn from the base32hex alphabet — lowercase
//! `a`–`v` and `0`–`9` — between 5 and 1024 characters, unique per
//! calendar. A task id is a UUID: 16 bytes, which is exactly 26
//! characters of that alphabet. So the mapping between a task and its
//! event is a function rather than a table, and it runs backwards as
//! well, which is what makes an orphaned event findable at all.
//!
//! **The run is a full reconcile.** Nothing is remembered between runs:
//! no last-pushed snapshot, no high-water mark. Ask the calendar what it
//! has, compute what it should have, and emit the difference. Running it
//! twice is a no-op the second time, and two replicas pointed at one
//! calendar derive the same ids and so converge rather than duplicating.

pub mod client;
pub mod oauth;
pub mod push;

use chrono::{Duration, NaiveDate};
use yaiba_core::{
    graph::Schedule,
    model::{Task, TaskId},
};

/// base32hex, per RFC 4648 §7 — the alphabet Google documents for a
/// client-supplied event id. Note it is *not* RFC 4648 §6 base32: the
/// digits lead, so the encoding preserves sort order.
const ALPHABET: &[u8; 32] = b"0123456789abcdefghijklmnopqrstuv";

/// 128 bits of UUID at 5 bits per character, rounded up.
const EVENT_ID_LEN: usize = 26;

/// The key yaiba stamps on every event it creates, under
/// `extendedProperties.private`.
///
/// Redundant with the id on the happy path and load-bearing anyway: an
/// id that decodes is not proof the event is ours, because Google's own
/// generated ids are drawn from the same alphabet at the same length and
/// a quarter of them decode cleanly. Deleting on the strength of the id
/// alone would eventually delete somebody's meeting.
pub const STAMP_KEY: &str = "yaibaTask";

/// What a project's calendar is called.
const TITLE_PREFIX: &str = "yaiba: ";

/// The calendar title for a project.
pub fn calendar_title(project: &str) -> String {
    format!("{TITLE_PREFIX}{project}")
}

/// Whether a calendar still carries the name yaiba gave it.
///
/// A project renamed in yaiba should take its calendar's name with it,
/// or `:rename` leaves the two disagreeing forever with nothing to say
/// so. A calendar renamed on the *Google* side should not be renamed
/// back — that was somebody deciding what to call their own calendar,
/// and taking it from them on the next push is the same overreach as
/// deleting an event yaiba did not create.
///
/// The prefix is what tells the two apart. It cannot distinguish
/// "renamed to something else with the same prefix", which is a person
/// choosing a name yaiba would have chosen and losing nothing by it.
pub fn is_yaiba_title(title: &str) -> bool {
    title.starts_with(TITLE_PREFIX)
}

/// The event id for a task: base32hex of the UUID's 16 bytes.
pub fn event_id(task: TaskId) -> String {
    let mut out = String::with_capacity(EVENT_ID_LEN);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in task.as_bytes() {
        acc = (acc << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(ALPHABET[((acc >> bits) & 0x1f) as usize]));
        }
    }
    // 128 is not a multiple of 5, so three bits are left over and the
    // last character carries them padded with two zeroes — which is what
    // `task_id` checks on the way back.
    if bits > 0 {
        out.push(char::from(ALPHABET[((acc << (5 - bits)) & 0x1f) as usize]));
    }
    out
}

/// The task an event id names, or `None` if it cannot have come from
/// `event_id`.
///
/// The length, the alphabet and the two padding bits are all checked.
/// That still does not make a match *proof* the event is ours — see
/// [`STAMP_KEY`] — it only rules out the ids that obviously are not.
pub fn task_id(event_id: &str) -> Option<TaskId> {
    if event_id.len() != EVENT_ID_LEN {
        return None;
    }
    let mut bytes = [0u8; 16];
    let mut written = 0usize;
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for byte in event_id.bytes() {
        let value = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'v' => byte - b'a' + 10,
            _ => return None,
        };
        acc = (acc << 5) | u32::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes[written] = ((acc >> bits) & 0xff) as u8;
            written += 1;
        }
    }
    // Two bits of padding are left, and `event_id` writes them as zero.
    if acc & ((1 << bits) - 1) != 0 {
        return None;
    }
    Some(TaskId::from_bytes(bytes))
}

/// The `end.date` for an all-day event whose last covered day is
/// `last_day`.
///
/// RFC 5545 writes `DTEND;VALUE=DATE` as non-inclusive and Google's
/// `end.date` follows it, so a one-day event on the 9th ends on the
/// 10th. Everything yaiba stores is the other convention: `Scheduled`
/// carries the last day the bar covers, and `actual_end` is a date
/// somebody typed meaning "this is when it finished".
///
/// This is the only place the two conventions meet. Passing a yaiba date
/// straight through as `end.date` compiles, uploads, returns 200 and
/// makes every bar a day short — and a one-day task, the common case,
/// zero-length.
fn exclusive_end(last_day: NaiveDate) -> NaiveDate {
    last_day
        .checked_add_signed(Duration::days(1))
        .unwrap_or(NaiveDate::MAX)
}

/// An all-day event as yaiba wants it to exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// Derived from `task` — carried rather than recomputed so the
    /// caller writing the request body cannot reach for a different one.
    pub id: String,
    pub task: TaskId,
    pub summary: String,
    pub start: NaiveDate,
    /// Exclusive, per [`exclusive_end`].
    pub end: NaiveDate,
}

/// An all-day event already on the calendar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEvent {
    pub id: String,
    /// The task named by this event's [`STAMP_KEY`] property, if it
    /// carries one. `None` means somebody else made this event, and
    /// [`reconcile`] will neither touch nor delete it.
    pub task: Option<TaskId>,
    pub summary: String,
    pub start: NaiveDate,
    /// Exclusive, as Google returns it.
    pub end: NaiveDate,
}

/// One call to make against the calendar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Insert(Event),
    Patch(Event),
    Delete(String),
}

/// The events a plan should have on the calendar.
///
/// Summaries are left out. Their span is the union of their children's,
/// so an event for a parent covers days its children already cover — on
/// a calendar that reads as the same work booked twice, and folding is
/// what the outline offers instead.
pub fn desired(tasks: &[Task], schedule: &Schedule) -> Vec<Event> {
    let titles: std::collections::HashMap<TaskId, &str> =
        tasks.iter().map(|t| (t.id, t.title.as_str())).collect();
    schedule
        .tasks
        .iter()
        .filter(|s| !s.summary)
        .filter_map(|s| {
            titles.get(&s.id).map(|title| Event {
                id: event_id(s.id),
                task: s.id,
                summary: (*title).to_string(),
                start: s.start,
                end: exclusive_end(s.end),
            })
        })
        .collect()
}

/// The calls that would make `remote` agree with `desired`.
///
/// Deletes come last so that a run cut short leaves the calendar showing
/// too much rather than too little: an event that should have gone is a
/// visible mistake, and one that was removed before its replacement
/// landed is a hole nobody notices.
pub fn reconcile(desired: &[Event], remote: &[RemoteEvent]) -> Vec<Action> {
    let ours: std::collections::HashMap<&str, &RemoteEvent> = remote
        .iter()
        .filter(|e| e.task.is_some())
        .map(|e| (e.id.as_str(), e))
        .collect();

    let mut actions: Vec<Action> = desired
        .iter()
        .filter_map(|want| match ours.get(want.id.as_str()) {
            None => Some(Action::Insert(want.clone())),
            Some(have) => {
                let same = have.summary == want.summary
                    && have.start == want.start
                    && have.end == want.end;
                (!same).then(|| Action::Patch(want.clone()))
            }
        })
        .collect();

    let wanted: std::collections::HashSet<&str> = desired.iter().map(|e| e.id.as_str()).collect();
    actions.extend(
        remote
            .iter()
            .filter(|e| e.task.is_some())
            .filter(|e| !wanted.contains(e.id.as_str()))
            .map(|e| Action::Delete(e.id.clone())),
    );
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn day(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn task(id: TaskId, title: &str) -> Task {
        Task {
            id,
            parent: None,
            title: title.to_string(),
            notes: String::new(),
            assignee: String::new(),
            status: Default::default(),
            priority: 0,
            start: None,
            duration_days: 1,
            due: None,
            actual_start: None,
            actual_end: None,
            progress: 0,
            position: 0.0,
            tags: Vec::new(),
            created_at: Default::default(),
            updated_at: Default::default(),
            done_at: None,
        }
    }

    #[test]
    fn an_event_id_is_twenty_six_characters_of_the_alphabet_google_documents() {
        let id = event_id(TaskId::now_v7());
        assert_eq!(id.len(), EVENT_ID_LEN);
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'v').contains(&b)),
            "{id} leaves the base32hex alphabet"
        );
    }

    #[test]
    fn an_event_id_round_trips_back_to_its_task() {
        for _ in 0..1000 {
            let want = TaskId::now_v7();
            assert_eq!(task_id(&event_id(want)), Some(want));
        }
        // v4 as well: v7 leads with a timestamp, so a loop of them
        // shares a prefix and would not exercise the high bytes.
        for _ in 0..1000 {
            let want = TaskId::new_v4();
            assert_eq!(task_id(&event_id(want)), Some(want));
        }
    }

    #[test]
    fn the_nil_and_max_uuids_survive_the_round_trip() {
        // The ends of the range are where a shift-based codec drops a
        // bit without any random id noticing.
        for want in [TaskId::nil(), TaskId::max()] {
            assert_eq!(task_id(&event_id(want)), Some(want));
        }
    }

    #[test]
    fn an_id_that_yaiba_did_not_mint_is_refused() {
        let mine = event_id(TaskId::now_v7());
        // Too short, too long, outside the alphabet, and — the one that
        // matters — the right shape with the padding bits set, which is
        // what most of Google's own generated ids look like.
        assert_eq!(task_id(&mine[..25]), None);
        assert_eq!(task_id(&format!("{mine}0")), None);
        assert_eq!(task_id(&format!("{}z", &mine[..25])), None);
        assert_eq!(task_id(&format!("{}v", &mine[..25])), None);
    }

    #[test]
    fn a_one_day_task_ends_the_day_after_it_starts() {
        // The whole point of `exclusive_end`: yaiba's last covered day
        // is the 9th, and Google is told the 10th. Handing it the 9th
        // would be a zero-length event.
        assert_eq!(exclusive_end(day("2026-08-09")), day("2026-08-10"));
    }

    #[test]
    fn a_three_day_task_covers_three_days() {
        // start 8/9, duration 3 -> the scheduler's inclusive end is 8/11.
        assert_eq!(exclusive_end(day("2026-08-11")), day("2026-08-12"));
        // And read back the way Google states it, the span is 3 days,
        // not 4 — the trap on the other side of the same rule.
        assert_eq!((day("2026-08-12") - day("2026-08-09")).num_days(), 3);
    }

    #[test]
    fn the_end_of_the_calendar_saturates_rather_than_panicking() {
        // `graph::plus_days` degrades rather than throwing for the same
        // reason: one absurd duration must not take the whole plan down.
        assert_eq!(exclusive_end(NaiveDate::MAX), NaiveDate::MAX);
    }

    fn remote(event: &Event) -> RemoteEvent {
        RemoteEvent {
            id: event.id.clone(),
            task: Some(event.task),
            summary: event.summary.clone(),
            start: event.start,
            end: event.end,
        }
    }

    fn event(title: &str) -> Event {
        let id = TaskId::now_v7();
        Event {
            id: event_id(id),
            task: id,
            summary: title.to_string(),
            start: day("2026-08-09"),
            end: day("2026-08-10"),
        }
    }

    #[test]
    fn an_empty_calendar_is_all_inserts() {
        let want = vec![event("write it"), event("ship it")];
        let actions = reconcile(&want, &[]);
        assert_eq!(
            actions,
            vec![
                Action::Insert(want[0].clone()),
                Action::Insert(want[1].clone())
            ]
        );
    }

    #[test]
    fn running_it_again_does_nothing() {
        let want = vec![event("write it"), event("ship it")];
        let have: Vec<RemoteEvent> = want.iter().map(remote).collect();
        assert_eq!(reconcile(&want, &have), Vec::new());
    }

    #[test]
    fn a_moved_bar_is_a_patch_and_a_dropped_task_is_a_delete() {
        let mut want = vec![event("write it"), event("ship it")];
        let have: Vec<RemoteEvent> = want.iter().map(remote).collect();
        want[0].start = day("2026-08-12");
        want[0].end = day("2026-08-13");
        let gone = want.pop().expect("two events");

        assert_eq!(
            reconcile(&want, &have),
            vec![
                Action::Patch(want[0].clone()),
                Action::Delete(gone.id.clone())
            ],
            "the delete comes after the write"
        );
    }

    #[test]
    fn a_retitled_task_is_a_patch() {
        let want = vec![event("write it")];
        let mut have: Vec<RemoteEvent> = want.iter().map(remote).collect();
        have[0].summary = "write it up".to_string();
        assert_eq!(
            reconcile(&want, &have),
            vec![Action::Patch(want[0].clone())]
        );
    }

    #[test]
    fn an_event_yaiba_did_not_stamp_is_never_touched() {
        // Somebody's meeting, sitting in the same calendar. It is not in
        // the plan, which is exactly the shape of an orphan — and the
        // reason the stamp exists rather than trusting the id.
        let mine = event("write it");
        let theirs = RemoteEvent {
            id: event_id(TaskId::now_v7()),
            task: None,
            summary: "dentist".to_string(),
            start: day("2026-08-09"),
            end: day("2026-08-10"),
        };
        let actions = reconcile(std::slice::from_ref(&mine), &[theirs]);
        assert_eq!(actions, vec![Action::Insert(mine)]);
    }

    #[test]
    fn a_copy_carrying_somebody_elses_stamp_is_cleaned_up() {
        // yaiba never writes this pair — the id is a function of the task
        // stamped beside it. It is reachable from outside: an event
        // duplicated in the calendar takes the stamp with it and gets a
        // fresh id, so its stamp names a task that is very much still in
        // the plan while its id names nothing.
        //
        // Requiring the two to agree before touching an event would read
        // as the safer rule and would leave this copy on the calendar
        // forever, unmatched by every future run — the silent skip this
        // repo argues against wherever a partial result looks like a
        // whole one. The id is the key Google enforces, so it is the half
        // the reconcile trusts.
        let want = event("write it");
        let copy = RemoteEvent {
            id: event_id(TaskId::now_v7()),
            task: Some(want.task),
            summary: want.summary.clone(),
            start: want.start,
            end: want.end,
        };
        assert_eq!(
            reconcile(std::slice::from_ref(&want), std::slice::from_ref(&copy)),
            vec![Action::Insert(want.clone()), Action::Delete(copy.id)]
        );
    }

    #[test]
    fn an_event_holding_a_wanted_id_is_patched_into_agreement() {
        // The other half of the same disagreement, and the reason it
        // costs nothing: whatever the stamp claims, an event sitting on
        // this id *is* this task's event as far as Google is concerned —
        // an insert would 409 against it. Patching is the repair.
        let want = event("write it");
        let forged = RemoteEvent {
            id: want.id.clone(),
            task: Some(TaskId::now_v7()),
            summary: "something else".to_string(),
            start: day("2026-09-01"),
            end: day("2026-09-02"),
        };
        assert_eq!(
            reconcile(std::slice::from_ref(&want), std::slice::from_ref(&forged)),
            vec![Action::Patch(want)]
        );
    }

    #[test]
    fn a_calendar_yaiba_named_is_renameable_and_one_a_person_named_is_not() {
        // The rename follows a project rename, which is the whole point
        // — otherwise `:rename` leaves the calendar saying the old name
        // for good, with neither side admitting they disagree.
        assert!(is_yaiba_title(&calendar_title("work")));
        assert!(is_yaiba_title("yaiba: anything at all"));

        // And stops at the edge of what yaiba wrote. Somebody who
        // renamed their own calendar keeps the name they chose; taking
        // it back on the next push is the same overreach as deleting an
        // event yaiba did not create.
        assert!(!is_yaiba_title("Q3 planning"));
        assert!(!is_yaiba_title("yaiba"));
        assert!(!is_yaiba_title("my yaiba: work"));
        assert!(!is_yaiba_title(""));
    }

    #[test]
    fn a_summary_gets_no_event_of_its_own() {
        use yaiba_core::graph::schedule;
        use yaiba_core::model::Dep;

        let parent = TaskId::now_v7();
        let child = TaskId::now_v7();
        let mut tasks = vec![task(parent, "the project"), task(child, "the work")];
        tasks[1].parent = Some(parent);
        tasks[1].start = Some(day("2026-08-09"));
        tasks[1].duration_days = 3;

        let deps: Vec<Dep> = Vec::new();
        let events = desired(&tasks, &schedule(&tasks, &deps, day("2026-08-09")));

        assert_eq!(events.len(), 1, "the parent's span duplicates the child's");
        assert_eq!(events[0].task, child);
        assert_eq!(events[0].start, day("2026-08-09"));
        assert_eq!(events[0].end, day("2026-08-12"), "3 days, exclusive end");
    }
}
