//! Dependency-graph scheduling: forward/backward pass over a DAG of
//! finish-to-start edges, yielding bar positions, slack and the
//! critical path that the gantt view draws.

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{Duration, NaiveDate};
use serde::Serialize;

use crate::model::{Dep, Status, Task, TaskId};

/// One task's computed placement on the timeline.
#[derive(Debug, Clone, Serialize)]
pub struct Scheduled {
    pub id: TaskId,
    pub start: NaiveDate,
    pub end: NaiveDate,
    /// Days the task may slip without pushing the project end out.
    pub slack_days: i64,
    /// `slack_days == 0` — on the critical path.
    pub critical: bool,
    /// At least one predecessor is not `done` yet.
    pub blocked: bool,
    /// The computed finish lands after the declared due date.
    pub overdue: bool,
    /// Number of edges from any root; used by the UI to indent rows.
    pub depth: i64,
}

/// The full timeline plus its critical path.
#[derive(Debug, Clone, Serialize)]
pub struct Schedule {
    pub tasks: Vec<Scheduled>,
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub critical_path: Vec<TaskId>,
}

/// Normalised span of a task: at least one calendar day.
fn duration_of(task: &Task) -> i64 {
    task.duration_days.max(1)
}

/// Adjacency in both directions, restricted to edges whose endpoints
/// both exist. Dangling edges are normal in a CRDT — a peer can send an
/// edge whose task tombstone hasn't arrived yet — so they are dropped
/// rather than treated as corruption.
fn adjacency(
    tasks: &[Task],
    deps: &[Dep],
) -> (HashMap<TaskId, Vec<TaskId>>, HashMap<TaskId, Vec<TaskId>>) {
    let ids: HashSet<TaskId> = tasks.iter().map(|t| t.id).collect();
    let mut preds: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    let mut succs: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    for dep in deps {
        if dep.from == dep.to || !ids.contains(&dep.from) || !ids.contains(&dep.to) {
            continue;
        }
        preds.entry(dep.to).or_default().push(dep.from);
        succs.entry(dep.from).or_default().push(dep.to);
    }
    (preds, succs)
}

/// Kahn's algorithm. Any node left over sits on a cycle; those are
/// appended in id order so callers always get a total order back and the
/// UI keeps rendering instead of blanking out.
fn topo_order(tasks: &[Task], succs: &HashMap<TaskId, Vec<TaskId>>) -> Vec<TaskId> {
    let mut indeg: HashMap<TaskId, usize> = tasks.iter().map(|t| (t.id, 0)).collect();
    for targets in succs.values() {
        for to in targets {
            if let Some(d) = indeg.get_mut(to) {
                *d += 1;
            }
        }
    }

    let mut queue: VecDeque<TaskId> = tasks
        .iter()
        .map(|t| t.id)
        .filter(|id| indeg.get(id) == Some(&0))
        .collect();
    let mut order = Vec::with_capacity(tasks.len());
    while let Some(id) = queue.pop_front() {
        order.push(id);
        for to in succs.get(&id).into_iter().flatten() {
            if let Some(d) = indeg.get_mut(to) {
                *d -= 1;
                if *d == 0 {
                    queue.push_back(*to);
                }
            }
        }
    }

    if order.len() < tasks.len() {
        let seen: HashSet<TaskId> = order.iter().copied().collect();
        let mut rest: Vec<TaskId> = tasks
            .iter()
            .map(|t| t.id)
            .filter(|id| !seen.contains(id))
            .collect();
        rest.sort_unstable();
        order.extend(rest);
    }
    order
}

/// Returns true when adding `from -> to` would close a cycle, i.e. when
/// `to` already reaches `from`.
pub fn would_cycle(deps: &[Dep], from: TaskId, to: TaskId) -> bool {
    if from == to {
        return true;
    }
    let mut succs: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    for dep in deps {
        succs.entry(dep.from).or_default().push(dep.to);
    }
    let mut stack = vec![to];
    let mut seen = HashSet::new();
    while let Some(node) = stack.pop() {
        if node == from {
            return true;
        }
        if !seen.insert(node) {
            continue;
        }
        stack.extend(succs.get(&node).into_iter().flatten().copied());
    }
    false
}

/// Place every task on the calendar.
///
/// Forward pass honours both the dependency edges and any hard-pinned
/// `start`; the backward pass derives slack, and zero-slack tasks form
/// the critical path. Cycles degrade gracefully — the offending tasks
/// simply lose their edge constraints rather than aborting the whole
/// schedule. That matters more here than in a single-writer app: two
/// peers can concurrently add edges that only form a loop once merged,
/// so a cyclic graph is a state the UI must survive, not just an error
/// to reject at the door.
pub fn schedule(tasks: &[Task], deps: &[Dep], today: NaiveDate) -> Schedule {
    let project_start = tasks
        .iter()
        .filter_map(|t| t.start)
        .min()
        .map_or(today, |earliest| earliest.min(today));

    if tasks.is_empty() {
        return Schedule {
            tasks: Vec::new(),
            start: project_start,
            end: project_start,
            critical_path: Vec::new(),
        };
    }

    let (preds, succs) = adjacency(tasks, deps);
    let order = topo_order(tasks, &succs);
    let by_id: HashMap<TaskId, &Task> = tasks.iter().map(|t| (t.id, t)).collect();

    // Forward pass: earliest start / earliest finish.
    let mut es: HashMap<TaskId, NaiveDate> = HashMap::new();
    let mut ef: HashMap<TaskId, NaiveDate> = HashMap::new();
    let mut depth: HashMap<TaskId, i64> = HashMap::new();
    for id in &order {
        let Some(task) = by_id.get(id) else { continue };
        let anchor = task.start.unwrap_or(project_start);
        let mut start = anchor;
        let mut own_depth = 0;
        for p in preds.get(id).into_iter().flatten() {
            if let Some(pred_end) = ef.get(p) {
                start = start.max(*pred_end + Duration::days(1));
            }
            own_depth = own_depth.max(depth.get(p).copied().unwrap_or(0) + 1);
        }
        let end = start + Duration::days(duration_of(task) - 1);
        es.insert(*id, start);
        ef.insert(*id, end);
        depth.insert(*id, own_depth);
    }

    let project_end = ef.values().copied().max().unwrap_or(project_start);

    // Backward pass: latest finish / latest start.
    let mut lf: HashMap<TaskId, NaiveDate> = HashMap::new();
    let mut ls: HashMap<TaskId, NaiveDate> = HashMap::new();
    for id in order.iter().rev() {
        let Some(task) = by_id.get(id) else { continue };
        let mut finish = project_end;
        for s in succs.get(id).into_iter().flatten() {
            if let Some(succ_start) = ls.get(s) {
                finish = finish.min(*succ_start - Duration::days(1));
            }
        }
        let start = finish - Duration::days(duration_of(task) - 1);
        lf.insert(*id, finish);
        ls.insert(*id, start);
    }

    let mut scheduled: Vec<Scheduled> = tasks
        .iter()
        .map(|task| {
            let start = es.get(&task.id).copied().unwrap_or(project_start);
            let end = ef.get(&task.id).copied().unwrap_or(project_start);
            let late_start = ls.get(&task.id).copied().unwrap_or(start);
            let slack_days = (late_start - start).num_days();
            let blocked = preds
                .get(&task.id)
                .into_iter()
                .flatten()
                .any(|p| by_id.get(p).is_some_and(|t| t.status != Status::Done));
            Scheduled {
                id: task.id,
                start,
                end,
                slack_days,
                critical: slack_days <= 0,
                blocked,
                overdue: task.due.is_some_and(|due| due < end),
                depth: depth.get(&task.id).copied().unwrap_or(0),
            }
        })
        .collect();
    scheduled.sort_by_key(|s| (s.start, s.id));

    let critical_path = scheduled
        .iter()
        .filter(|s| s.critical)
        .map(|s| s.id)
        .collect();

    Schedule {
        tasks: scheduled,
        start: project_start,
        end: project_end,
        critical_path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use uuid::Uuid;

    fn id(n: u128) -> TaskId {
        Uuid::from_u128(n)
    }

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, d).unwrap()
    }

    fn task(n: u128, duration: i64, start: Option<NaiveDate>) -> Task {
        let now = Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap();
        Task {
            id: id(n),
            title: format!("task {n}"),
            notes: String::new(),
            status: Status::Todo,
            priority: 0,
            start,
            duration_days: duration,
            due: None,
            progress: 0,
            position: n as f64,
            tags: Vec::new(),
            created_at: now,
            updated_at: now,
            done_at: None,
        }
    }

    fn find(schedule: &Schedule, n: u128) -> &Scheduled {
        schedule.tasks.iter().find(|s| s.id == id(n)).unwrap()
    }

    fn dep(from: u128, to: u128) -> Dep {
        Dep {
            from: id(from),
            to: id(to),
        }
    }

    #[test]
    fn chains_tasks_back_to_back() {
        let tasks = vec![task(1, 2, Some(day(1))), task(2, 3, None), task(3, 1, None)];
        let deps = vec![dep(1, 2), dep(2, 3)];
        let s = schedule(&tasks, &deps, day(1));

        assert_eq!((find(&s, 1).start, find(&s, 1).end), (day(1), day(2)));
        assert_eq!((find(&s, 2).start, find(&s, 2).end), (day(3), day(5)));
        assert_eq!((find(&s, 3).start, find(&s, 3).end), (day(6), day(6)));
        assert_eq!(s.end, day(6));
        // A pure chain is entirely critical.
        assert_eq!(s.critical_path, vec![id(1), id(2), id(3)]);
    }

    #[test]
    fn slack_marks_the_shorter_branch_non_critical() {
        // 1 -> {2 (5d), 3 (1d)} -> 4
        let tasks = vec![
            task(1, 1, Some(day(1))),
            task(2, 5, None),
            task(3, 1, None),
            task(4, 1, None),
        ];
        let deps = vec![dep(1, 2), dep(1, 3), dep(2, 4), dep(3, 4)];
        let s = schedule(&tasks, &deps, day(1));

        assert!(find(&s, 2).critical, "long branch is on the critical path");
        assert!(!find(&s, 3).critical, "short branch has slack");
        assert_eq!(find(&s, 3).slack_days, 4);
        assert_eq!(find(&s, 4).start, day(7));
    }

    #[test]
    fn honours_a_pinned_start_later_than_its_predecessor() {
        let tasks = vec![task(1, 1, Some(day(1))), task(2, 1, Some(day(10)))];
        let s = schedule(&tasks, &[dep(1, 2)], day(1));
        assert_eq!(find(&s, 2).start, day(10));
    }

    #[test]
    fn blocked_flag_follows_predecessor_status() {
        let mut tasks = vec![task(1, 1, Some(day(1))), task(2, 1, None)];
        let deps = vec![dep(1, 2)];

        let s = schedule(&tasks, &deps, day(1));
        assert!(find(&s, 2).blocked);

        tasks[0].status = Status::Done;
        let s = schedule(&tasks, &deps, day(1));
        assert!(!find(&s, 2).blocked);
    }

    #[test]
    fn overdue_flag_compares_against_the_computed_finish() {
        let mut tasks = vec![task(1, 5, Some(day(1)))];
        tasks[0].due = Some(day(3));
        let s = schedule(&tasks, &[], day(1));
        assert!(find(&s, 1).overdue);
    }

    #[test]
    fn a_cycle_degrades_instead_of_hanging() {
        let tasks = vec![task(1, 1, Some(day(1))), task(2, 1, Some(day(1)))];
        let deps = vec![dep(1, 2), dep(2, 1)];
        let s = schedule(&tasks, &deps, day(1));
        assert_eq!(s.tasks.len(), 2, "every task still gets a placement");
    }

    #[test]
    fn an_edge_to_a_missing_task_is_ignored() {
        // The tombstone for task 2 arrived but its inbound edge hasn't
        // been garbage collected yet.
        let tasks = vec![task(1, 1, Some(day(1)))];
        let s = schedule(&tasks, &[dep(2, 1)], day(1));
        assert_eq!(find(&s, 1).start, day(1));
    }

    #[test]
    fn would_cycle_detects_indirect_loops() {
        let deps = vec![dep(1, 2), dep(2, 3)];
        assert!(would_cycle(&deps, id(3), id(1)), "3 -> 1 closes the loop");
        assert!(
            !would_cycle(&deps, id(1), id(3)),
            "1 -> 3 is just a shortcut edge"
        );
        assert!(would_cycle(&deps, id(1), id(1)), "self-edge");
    }

    #[test]
    fn empty_project_is_a_single_day_at_today() {
        let s = schedule(&[], &[], day(4));
        assert_eq!((s.start, s.end), (day(4), day(4)));
    }
}
