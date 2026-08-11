//! Talking to the Calendar API.
//!
//! The parent module decides *what* should be on the calendar; this one
//! carries it out. Everything that can be tested without an account is
//! kept as a function over `serde_json::Value` rather than folded into
//! the request, so the mapping is checkable in CI and only the transport
//! needs a live token.
//!
//! ## A stamp is only as trustworthy as the code reading it
//!
//! `reconcile` will delete an event that carries a `yaibaTask` stamp and
//! is not in the plan. Everything therefore rests on this module never
//! reporting a stamp that is not there: an absent, empty or unparseable
//! property must become `None`, which makes the event somebody else's
//! and puts it permanently out of reach. Defaulting a bad value — to
//! `TaskId::nil()`, to "probably ours" — would turn a typo in somebody's
//! event description into a deletion. This is the whole of what the
//! review on #161 asked for, and `a_stamp_that_is_not_a_uuid_is_not_an_
//! ownership_claim` is where it is pinned.
//!
//! ## Two Google behaviours worth knowing before reading the calls
//!
//! **An id can be refused for being reused.** The insert reference does
//! not say whether the id of a deleted event may be used again, and a
//! 409 is what comes back when it may not. Rather than resolving that
//! question, `insert` treats a 409 as "it is already there in some
//! state" and patches instead — which also revives an event Google is
//! holding as `cancelled`, since a patch may set `status` back to
//! `confirmed`. The reconcile stays correct either way, and #160 can
//! stop waiting on an answer.
//!
//! **A delete of something already gone is a 410.** That is success for
//! our purposes: the goal was for the event not to exist.

use anyhow::{Context, Result, bail};
use chrono::NaiveDate;
use serde_json::{Value, json};

use super::{Event, RemoteEvent, STAMP_KEY};
use yaiba_core::model::TaskId;

const BASE: &str = "https://www.googleapis.com/calendar/v3";

/// One authenticated conversation with the Calendar API.
pub struct Calendar {
    http: reqwest::Client,
    token: String,
}

impl Calendar {
    pub fn new(token: String) -> Self {
        Self {
            http: super::http(),
            token,
        }
    }

    /// The calendar this project writes to, creating it if the stored id
    /// names nothing.
    ///
    /// A calendar of its own rather than the primary one, so that
    /// "take my plan off my calendar" is one deletion the person
    /// performs themselves rather than a cleanup they have to trust
    /// yaiba to do. It also means a stray event can only ever be
    /// somewhere they already know to look.
    pub async fn ensure(&self, stored: Option<&str>, title: &str) -> Result<String> {
        if let Some(id) = stored.filter(|id| !id.is_empty()) {
            // A calendar deleted from the other side leaves the stored id
            // naming nothing. Falling through to create a fresh one is
            // better than failing: the person's gesture was "I want this
            // gone", and the next push is them asking for it back.
            let response = self
                .http
                .get(format!("{BASE}/calendars/{}", super::escape(id)))
                .bearer_auth(&self.token)
                .send()
                .await
                .context("could not reach the Calendar API")?;
            if response.status().is_success() {
                let existing = self.ok(response).await?;
                self.rename_if_ours(id, existing["summary"].as_str(), title)
                    .await?;
                return Ok(id.to_string());
            }
            if response.status() != reqwest::StatusCode::NOT_FOUND {
                bail!(
                    "Calendar API answered {} for the stored calendar",
                    response.status()
                );
            }
            tracing::warn!("the calendar {id} is gone; making a new one");
        }

        let created: Value = self
            .send(
                self.http
                    .post(format!("{BASE}/calendars"))
                    .json(&json!({ "summary": title })),
            )
            .await?;
        created["id"]
            .as_str()
            .map(str::to_string)
            .context("Google created a calendar without giving it an id")
    }

    /// Carry a project rename across to its calendar, and only that.
    ///
    /// Renaming a project in yaiba otherwise leaves the calendar saying
    /// the old name for good, with nothing in either place admitting the
    /// two disagree. What this must not do is take the name back from
    /// somebody who renamed the calendar themselves, so it only rewrites
    /// a title that still looks like one yaiba wrote — see
    /// [`is_yaiba_title`].
    ///
    /// Best-effort. A rename that fails is a wrong label on a calendar
    /// that is otherwise correct, and failing the whole push over it
    /// would trade every event for a word.
    async fn rename_if_ours(&self, id: &str, current: Option<&str>, want: &str) -> Result<()> {
        let Some(current) = current else {
            return Ok(());
        };
        if current == want || !super::is_yaiba_title(current) {
            return Ok(());
        }
        let renamed = self
            .send(
                self.http
                    .patch(format!("{BASE}/calendars/{}", super::escape(id)))
                    .json(&json!({ "summary": want })),
            )
            .await;
        match renamed {
            Ok(_) => tracing::info!("renamed the calendar {current:?} to {want:?}"),
            Err(e) => tracing::warn!("could not rename the calendar {current:?}: {e:#}"),
        }
        Ok(())
    }

    /// Every event on the calendar, as far as this module can read them.
    ///
    /// Unbounded in time on purpose. The window would have to be the
    /// plan's, and a bar that moved out of that window is exactly the
    /// event that most needs collecting — a time filter would make it
    /// invisible to the reconcile and so permanent. The calendar is
    /// yaiba's own, so "everything on it" stays small.
    pub async fn events(&self, calendar: &str) -> Result<Vec<RemoteEvent>> {
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut request = self
                .http
                .get(format!(
                    "{BASE}/calendars/{}/events",
                    super::escape(calendar)
                ))
                .query(&[("maxResults", "2500"), ("showDeleted", "false")]);
            if let Some(token) = &page {
                request = request.query(&[("pageToken", token)]);
            }
            let body: Value = self.send(request).await?;

            if let Some(items) = body["items"].as_array() {
                out.extend(items.iter().filter_map(parse_event));
            }
            match body["nextPageToken"].as_str() {
                Some(next) => page = Some(next.to_string()),
                None => return Ok(out),
            }
        }
    }

    /// Create the event, or take over the id if something already holds it.
    pub async fn insert(&self, calendar: &str, event: &Event) -> Result<()> {
        let response = self
            .http
            .post(format!(
                "{BASE}/calendars/{}/events",
                super::escape(calendar)
            ))
            .bearer_auth(&self.token)
            .json(&body(event))
            .send()
            .await
            .context("could not reach the Calendar API")?;

        if response.status() == reqwest::StatusCode::CONFLICT {
            // Either the id is live and we did not see it, or Google is
            // holding a cancelled event under it. `body` writes
            // `status: confirmed`, so the patch covers both.
            return self.patch(calendar, event).await;
        }
        self.ok(response).await.map(|_: Value| ())
    }

    /// Rewrite the event to say what the plan says.
    pub async fn patch(&self, calendar: &str, event: &Event) -> Result<()> {
        self.send(
            self.http
                .patch(format!(
                    "{BASE}/calendars/{}/events/{}",
                    super::escape(calendar),
                    super::escape(&event.id)
                ))
                .json(&body(event)),
        )
        .await
        .map(|_: Value| ())
    }

    /// Remove the event. Already being gone counts as removed.
    pub async fn delete(&self, calendar: &str, id: &str) -> Result<()> {
        let response = self
            .http
            .delete(format!(
                "{BASE}/calendars/{}/events/{}",
                super::escape(calendar),
                super::escape(id)
            ))
            .bearer_auth(&self.token)
            .send()
            .await
            .context("could not reach the Calendar API")?;
        if response.status() == reqwest::StatusCode::GONE {
            return Ok(());
        }
        self.ok(response).await.map(|_: Value| ())
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value> {
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .context("could not reach the Calendar API")?;
        self.ok(response).await
    }

    async fn ok(&self, response: reqwest::Response) -> Result<Value> {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("Calendar API answered {status}: {text}");
        }
        if text.is_empty() {
            // `delete` succeeds with no body.
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).context("the Calendar API returned something that is not JSON")
    }
}

/// The request body for an all-day event.
///
/// `status` is stated rather than left out so that a patch onto an event
/// Google is holding as `cancelled` brings it back — see the note at the
/// top about 409s.
fn body(event: &Event) -> Value {
    json!({
        "id": event.id,
        "summary": event.summary,
        "start": { "date": event.start.to_string() },
        "end": { "date": event.end.to_string() },
        "status": "confirmed",
        "extendedProperties": { "private": { STAMP_KEY: event.task.to_string() } },
    })
}

/// Read one event out of a list response.
///
/// `None` means "not an event this module can reason about" — no id, or
/// no date it can place — and never means "not ours", which is
/// [`RemoteEvent::task`]'s job to say.
fn parse_event(item: &Value) -> Option<RemoteEvent> {
    let id = item["id"].as_str()?.to_string();
    Some(RemoteEvent {
        id,
        task: stamp(item),
        summary: item["summary"].as_str().unwrap_or_default().to_string(),
        start: endpoint(&item["start"])?,
        end: endpoint(&item["end"])?,
    })
}

/// The task an event claims, or `None` if it does not credibly claim one.
///
/// Every failure is `None`: no properties, no key, an empty string, or
/// text that is not a UUID. See the module header for why that direction
/// is the only safe one.
fn stamp(item: &Value) -> Option<TaskId> {
    item["extendedProperties"]["private"][STAMP_KEY]
        .as_str()
        .and_then(|raw| raw.parse::<TaskId>().ok())
}

/// The day an endpoint falls on.
///
/// All-day events carry `date`. A timed one carries `dateTime`, which
/// should not happen on yaiba's own calendar and does the moment
/// somebody drags an event into a time slot. Reading the date out of it
/// rather than skipping the event is what lets the reconcile see the
/// disagreement and patch it back to all-day; skipping would leave the
/// id occupied and every later insert answering 409 forever.
fn endpoint(value: &Value) -> Option<NaiveDate> {
    if let Some(date) = value["date"].as_str() {
        return date.parse().ok();
    }
    let stamp = value["dateTime"].as_str()?;
    stamp.get(..10)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gcal::event_id;

    fn day(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn an_all_day_event_reads_back_as_the_span_it_was_written_with() {
        let task = TaskId::now_v7();
        let event = Event {
            id: event_id(task),
            task,
            summary: "write it".to_string(),
            start: day("2026-08-09"),
            end: day("2026-08-12"),
        };
        let parsed = parse_event(&body(&event)).expect("its own body should parse");
        assert_eq!(parsed.id, event.id);
        assert_eq!(parsed.task, Some(task));
        assert_eq!(parsed.summary, event.summary);
        assert_eq!(parsed.start, event.start);
        assert_eq!(parsed.end, event.end, "the exclusive end survives the trip");
    }

    #[test]
    fn a_stamp_that_is_not_a_uuid_is_not_an_ownership_claim() {
        // The requirement both reviewers on #161 agreed on. Every one of
        // these is an event `reconcile` must never delete, and the only
        // thing standing between them and a delete is this returning
        // `None` rather than a default.
        for private in [
            json!({}),
            json!({ "yaibaTask": "" }),
            json!({ "yaibaTask": "not-a-uuid" }),
            json!({ "yaibaTask": "  " }),
            json!({ "yaibaTask": 42 }),
            json!({ "somethingElse": "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }),
        ] {
            let item = json!({
                "id": "abc",
                "extendedProperties": { "private": private },
                "start": { "date": "2026-08-09" },
                "end": { "date": "2026-08-10" },
            });
            assert_eq!(
                stamp(&item),
                None,
                "{private} was read as an ownership claim"
            );
        }
        // And an event with no extendedProperties at all — somebody's
        // dentist appointment, which is the case that matters most.
        assert_eq!(stamp(&json!({ "id": "abc" })), None);
    }

    #[test]
    fn a_well_formed_stamp_is_read() {
        let task = TaskId::now_v7();
        let item = json!({
            "id": "abc",
            "extendedProperties": { "private": { STAMP_KEY: task.to_string() } },
        });
        assert_eq!(stamp(&item), Some(task));
    }

    #[test]
    fn an_event_dragged_into_a_time_slot_is_still_placed_on_its_day() {
        // Not skipped: skipping would leave the id occupied and every
        // later insert answering 409 with nothing able to fix it.
        let item = json!({
            "id": "abc",
            "start": { "dateTime": "2026-08-09T10:00:00+09:00", "timeZone": "Asia/Tokyo" },
            "end": { "dateTime": "2026-08-09T11:00:00+09:00", "timeZone": "Asia/Tokyo" },
        });
        let parsed = parse_event(&item).expect("a timed event still has a day");
        assert_eq!(parsed.start, day("2026-08-09"));
        assert_eq!(parsed.end, day("2026-08-09"));
    }

    #[test]
    fn an_event_with_no_id_or_no_date_is_not_an_event_this_module_can_place() {
        assert!(parse_event(&json!({ "start": { "date": "2026-08-09" } })).is_none());
        assert!(parse_event(&json!({ "id": "abc" })).is_none());
        assert!(
            parse_event(&json!({
                "id": "abc",
                "start": { "date": "not-a-date" },
                "end": { "date": "2026-08-10" }
            }))
            .is_none()
        );
    }

    #[test]
    fn a_body_states_its_status_so_a_patch_can_revive_a_cancelled_event() {
        let task = TaskId::now_v7();
        let event = Event {
            id: event_id(task),
            task,
            summary: "write it".to_string(),
            start: day("2026-08-09"),
            end: day("2026-08-10"),
        };
        assert_eq!(body(&event)["status"], "confirmed");
        assert_eq!(
            body(&event)["extendedProperties"]["private"][STAMP_KEY],
            task.to_string(),
            "the stamp is written on every insert and every patch"
        );
    }

    #[test]
    fn a_calendar_id_survives_being_put_in_a_path() {
        assert_eq!(
            crate::gcal::escape("abc123@group.calendar.google.com"),
            "abc123%40group.calendar.google.com"
        );
        // Event ids are base32hex, so they pass through untouched.
        assert_eq!(
            crate::gcal::escape(&event_id(TaskId::nil())),
            event_id(TaskId::nil())
        );
    }
}
