//! One reconcile, start to finish.
//!
//! Everything here is data in and a count out: the caller reads the plan
//! and the stored credential off the store, drops the lock, and awaits
//! this. That split is not stylistic — the store is behind a
//! `std::sync::Mutex`, and holding one across an `await` is how a
//! request that hits Google's rate limit takes the whole UI with it.
//!
//! The order is fixed and the reason is the same one the pure module
//! gives for emitting deletes last: a run that stops half way should
//! leave the calendar showing too much rather than too little.

use anyhow::{Context, Result};
use yaiba_core::{graph::Schedule, model::Task};

use super::{Action, client::Calendar, desired, oauth, reconcile};

/// What a run did, in the words the caller reports it in.
///
/// `Deserialize` alongside `Serialize` because the CLI reads this back
/// off the HTTP API rather than computing it — the same arrangement
/// `graph::Scheduled` is in, and for the same reason: the server is
/// where the run happens, so a second account of what it did would be a
/// second thing to keep in step.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Outcome {
    /// The calendar written to — carried back so the caller can file it
    /// against the project when it was created by this run.
    pub calendar: String,
    pub inserted: usize,
    pub patched: usize,
    pub deleted: usize,
    /// Calls that failed, described. A run reports what it could not do
    /// rather than failing whole: one event Google refuses is not a
    /// reason to abandon the other forty, and a silent skip would make a
    /// partial calendar look like a complete one.
    pub refused: Vec<String>,
}

impl Outcome {
    /// Whether anything changed — a reconcile that finds nothing to do
    /// is the expected result of running it twice, and should read as
    /// such rather than as a failure.
    pub fn quiet(&self) -> bool {
        self.inserted == 0 && self.patched == 0 && self.deleted == 0
    }
}

/// Make the calendar say what the plan says.
pub async fn run(
    creds: &oauth::Credentials,
    refresh_token: &str,
    stored_calendar: Option<&str>,
    title: &str,
    tasks: &[Task],
    schedule: &Schedule,
) -> Result<Outcome> {
    let access = oauth::refresh(creds, refresh_token)
        .await
        .context("could not turn the stored credential into an access token")?;
    let calendar = Calendar::new(access.token);

    let id = calendar
        .ensure(stored_calendar, title)
        .await
        .context("could not find or create the calendar")?;

    let have = calendar
        .events(&id)
        .await
        .context("could not read the calendar")?;
    let want = desired(tasks, schedule);

    let mut outcome = Outcome {
        calendar: id.clone(),
        ..Default::default()
    };
    for action in reconcile(&want, &have) {
        let (result, counter): (Result<()>, &mut usize) = match &action {
            Action::Insert(event) => (calendar.insert(&id, event).await, &mut outcome.inserted),
            Action::Patch(event) => (calendar.patch(&id, event).await, &mut outcome.patched),
            Action::Delete(event) => (calendar.delete(&id, event).await, &mut outcome.deleted),
        };
        match result {
            Ok(()) => *counter += 1,
            Err(e) => outcome
                .refused
                .push(format!("{}: {e:#}", describe(&action))),
        }
    }
    Ok(outcome)
}

fn describe(action: &Action) -> String {
    match action {
        Action::Insert(event) => format!("could not add \"{}\"", event.summary),
        Action::Patch(event) => format!("could not update \"{}\"", event.summary),
        Action::Delete(id) => format!("could not remove the event {id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_that_changed_nothing_is_quiet() {
        assert!(Outcome::default().quiet());
        assert!(
            !Outcome {
                inserted: 1,
                ..Default::default()
            }
            .quiet()
        );
        // A refusal is not a change, but it is not quiet either as far
        // as the person reading the line is concerned — they need to see
        // it, which is why `refused` is reported separately rather than
        // folded into this.
        assert!(
            Outcome {
                refused: vec!["nope".into()],
                ..Default::default()
            }
            .quiet()
        );
    }

    #[test]
    fn every_action_can_say_what_it_was_when_it_fails() {
        use super::super::{Event, event_id};
        use yaiba_core::model::TaskId;

        let task = TaskId::now_v7();
        let event = Event {
            id: event_id(task),
            task,
            summary: "write it".to_string(),
            start: "2026-08-09".parse().unwrap(),
            end: "2026-08-10".parse().unwrap(),
        };
        assert!(describe(&Action::Insert(event.clone())).contains("write it"));
        assert!(describe(&Action::Patch(event.clone())).contains("write it"));
        // The delete carries only an id, so that is what it names — the
        // task it belonged to is by definition no longer in the plan.
        assert!(describe(&Action::Delete(event.id.clone())).contains(&event.id));
    }
}
