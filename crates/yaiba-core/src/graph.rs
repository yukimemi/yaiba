//! Dependency-graph scheduling: forward/backward pass over a DAG of
//! finish-to-start edges, yielding bar positions, slack and the
//! critical path that the gantt view draws.

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{Duration, NaiveDate};
use serde::Serialize;

use crate::model::{Dep, Status, Task, TaskId, clamp_lag, default_lag};

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
    /// Depth in the work breakdown: 0 for a root (a "project"), 1 for
    /// its children, and so on. This is what the UI indents by and what
    /// fold levels count — **not** the dependency chain length.
    pub level: i64,
    /// Has children, so its dates and progress are aggregated rather
    /// than entered.
    pub summary: bool,
    /// Progress to display: a task's own for a leaf, the
    /// duration-weighted roll-up of descendants for a summary.
    pub progress: i64,
    /// Number of direct children — the UI needs it to draw a fold
    /// marker without walking the tree itself.
    pub children: i64,
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

/// `date + days`, saturating at the ends of the calendar.
///
/// `NaiveDate + Duration` and `Duration::days` both **panic** out of
/// range, and this function runs on every read of the state — so a single
/// absurd number anywhere in the graph would stop the project being
/// readable at all, which is the one failure this file is written to
/// avoid (see the note on degrading rather than throwing).
///
/// Lags are clamped before they get here, but `duration_days` is not
/// bounded anywhere and never has been, so this guards both. Saturating
/// rather than ignoring: a bar pinned at the end of the calendar is
/// obviously wrong on screen, where a silently dropped constraint looks
/// like the scheduler forgot an edge.
fn plus_days(date: NaiveDate, days: i64) -> NaiveDate {
    Duration::try_days(days)
        .and_then(|d| date.checked_add_signed(d))
        .unwrap_or(if days < 0 {
            NaiveDate::MIN
        } else {
            NaiveDate::MAX
        })
}

/// `date - days`, saturating. See [`plus_days`].
fn minus_days(date: NaiveDate, days: i64) -> NaiveDate {
    Duration::try_days(days)
        .and_then(|d| date.checked_sub_signed(d))
        .unwrap_or(if days < 0 {
            NaiveDate::MAX
        } else {
            NaiveDate::MIN
        })
}

/// The leaves each task stands for when an edge names it.
///
/// A leaf stands for itself; a summary stands for every leaf beneath it.
/// This is what lets a dependency touch a summary at all — see [`expand`].
///
/// Bounded like `levels` is: a parent chain that loops is possible after a
/// merge, and an unbounded walk would hang the scheduler rather than
/// degrade.
fn leaves_beneath(tasks: &[Task]) -> HashMap<TaskId, Vec<TaskId>> {
    let children = children_of(tasks);
    let mut out: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    for task in tasks {
        let mut leaves = Vec::new();
        let mut stack = vec![task.id];
        let mut seen: HashSet<TaskId> = HashSet::new();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            match children.get(&id).filter(|k| !k.is_empty()) {
                Some(kids) => stack.extend(kids.iter().copied()),
                // No children: a leaf, and the thing that actually carries
                // dates.
                None => leaves.push(id),
            }
        }
        // A summary whose whole subtree is a parent cycle resolves to no
        // leaves at all. Standing for itself keeps its edges in the graph
        // instead of silently dropping them — the same "degrade, don't
        // vanish" bargain the rest of this file makes.
        if leaves.is_empty() {
            leaves.push(task.id);
        }
        leaves.sort_unstable();
        out.insert(task.id, leaves);
    }
    out
}

/// Rewrite every edge to run between leaves.
///
/// Both scheduling passes work on leaves — a summary's dates are the
/// roll-up of its children, computed *after* both passes, so a summary has
/// no `ef` for a predecessor lookup to find and is skipped as a successor
/// entirely. That is why an edge touching one used to be silently ignored
/// in both directions: `A -> S` reached a task the forward pass skips, and
/// `S -> B` looked up a finish that did not exist yet.
///
/// Expanding here keeps the two axes independent. Scheduling summaries
/// directly would be circular — a summary's end is a function of its
/// children, and its children would become a function of its predecessors
/// — and it would also hand a summary dates of its own, which is the one
/// thing the roll-up exists to prevent.
///
/// What the rewrite means:
///
/// - `A -> S` becomes `A -> leaf` for every leaf of `S`, so all of them
///   wait.
/// - `S -> B` becomes `leaf -> B` for every leaf of `S`, and the forward
///   pass takes the `max`, so `B` waits for the whole bracket to close.
/// - `S -> T` is the cross product, which is the same statement about both
///   brackets.
///
/// Each rewritten edge carries the original's lag, so `A -> S +0` means
/// every leaf of `S` may start the day `A` finishes.
fn expand(tasks: &[Task], deps: &[Dep]) -> Vec<Dep> {
    let ids: HashSet<TaskId> = tasks.iter().map(|t| t.id).collect();
    let leaves = leaves_beneath(tasks);
    let mut out = Vec::new();
    for dep in deps {
        // Dangling edges are normal in a CRDT — a peer can send one whose
        // task tombstone has not arrived yet — so they are dropped rather
        // than treated as corruption.
        if dep.from == dep.to || !ids.contains(&dep.from) || !ids.contains(&dep.to) {
            continue;
        }
        let empty = Vec::new();
        let from_leaves = leaves.get(&dep.from).unwrap_or(&empty);
        let to_leaves = leaves.get(&dep.to).unwrap_or(&empty);
        for from in from_leaves {
            for to in to_leaves {
                // An edge between a summary and something inside it
                // expands to include a self-loop. `Store::add_dep` refuses
                // that pairing outright — `would_cycle` expands too — but
                // one already in the store, or arriving from a peer, still
                // has to not become a cycle here.
                if from == to {
                    continue;
                }
                out.push(Dep {
                    from: *from,
                    to: *to,
                    lag_days: dep.lag_days,
                });
            }
        }
    }
    out
}

/// Adjacency in both directions over already-expanded edges.
fn adjacency(deps: &[Dep]) -> (HashMap<TaskId, Vec<TaskId>>, HashMap<TaskId, Vec<TaskId>>) {
    let mut preds: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    let mut succs: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    for dep in deps {
        preds.entry(dep.to).or_default().push(dep.from);
        succs.entry(dep.from).or_default().push(dep.to);
    }
    (preds, succs)
}

/// Each edge's lag, keyed by its endpoints — the longest, where two edges
/// share a pair.
///
/// Kept beside `adjacency` rather than folded into it: `succs` is what
/// `topo_order` walks and what `would_cycle` rebuilds, and neither has any
/// use for a lag. Threading it through both would make every caller carry
/// a number it does not read.
///
/// **Duplicates are possible here**, which they are not among the stored
/// edges: the CRDT keys those by `(from, to)`, but `expand` can rewrite two
/// different ones onto the same leaf pair — a direct `A -> leaf` alongside
/// an `A -> S` that leaf sits inside. Collecting into a map would then let
/// whichever came last in the slice win, dropping the other silently and
/// depending on `deps` order to decide which.
///
/// `max` because a lag is a floor and both edges are still constraints:
/// "wait five days" and "you may start the same day" together mean wait
/// five. It is the same rule the forward pass already applies across
/// distinct predecessors, applied one level down.
fn lags(deps: &[Dep]) -> HashMap<(TaskId, TaskId), i64> {
    let mut out: HashMap<(TaskId, TaskId), i64> = HashMap::new();
    for dep in deps {
        let lag = clamp_lag(dep.lag_days);
        out.entry((dep.from, dep.to))
            .and_modify(|longest| *longest = (*longest).max(lag))
            .or_insert(lag);
    }
    out
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

/// Returns true when adding `from -> to` would close a cycle.
///
/// Asked of the *expanded* graph, because that is the one the scheduler
/// runs on. Without expansion the server would accept edges the scheduler
/// then has to survive — `A -> S` plus `child_of_S -> A` is no cycle
/// between the names as written and a plain one once both are rewritten to
/// leaves — and the 409 exists precisely to keep that from happening.
///
/// Two pairings it now refuses that it used to allow, both correctly: an
/// edge between a summary and something inside it (`S -> child_of_S`
/// expands to include `child_of_S -> child_of_S`), and any edge whose two
/// leaf sets overlap. Both say "this must finish before itself".
pub fn would_cycle(tasks: &[Task], deps: &[Dep], from: TaskId, to: TaskId) -> bool {
    if from == to {
        return true;
    }
    let leaves = leaves_beneath(tasks);
    let empty = Vec::new();
    let from_leaves = leaves.get(&from).unwrap_or(&empty);
    let to_leaves = leaves.get(&to).unwrap_or(&empty);
    // Nothing to schedule between: an ancestor/descendant pairing, or two
    // names standing for the same single leaf.
    if from_leaves.iter().any(|f| to_leaves.contains(f)) {
        return true;
    }

    let mut succs: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    for dep in expand(tasks, deps) {
        succs.entry(dep.from).or_default().push(dep.to);
    }
    // Reachability is asked leaf-to-leaf: does anything the new edge would
    // land on already reach anything it would leave from?
    let mut stack: Vec<TaskId> = to_leaves.clone();
    let targets: HashSet<TaskId> = from_leaves.iter().copied().collect();
    let mut seen = HashSet::new();
    while let Some(node) = stack.pop() {
        if targets.contains(&node) {
            return true;
        }
        if !seen.insert(node) {
            continue;
        }
        stack.extend(succs.get(&node).into_iter().flatten().copied());
    }
    false
}

/// The parent to actually use: present in this snapshot, and not the
/// task itself.
///
/// A task whose parent is missing (deleted, or simply not merged here
/// yet) is treated as a root rather than dropped, so it stays visible.
/// Every caller must agree on this rule — when `children_of` and
/// `levels` disagreed, an orphan was indented one level under a parent
/// that wasn't there.
fn effective_parent(task: &Task, ids: &HashSet<TaskId>) -> Option<TaskId> {
    task.parent.filter(|p| *p != task.id && ids.contains(p))
}

/// Direct children of each task, in the tasks' own order.
fn children_of(tasks: &[Task]) -> HashMap<TaskId, Vec<TaskId>> {
    let ids: HashSet<TaskId> = tasks.iter().map(|t| t.id).collect();
    let mut children: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    for task in tasks {
        if let Some(parent) = effective_parent(task, &ids) {
            children.entry(parent).or_default().push(task.id);
        }
    }
    children
}

/// Depth of each task in the breakdown, and the roots, in one walk.
///
/// A parent chain that loops — possible after a merge, since two peers
/// can independently re-parent — is cut by the visit bound and its
/// members are treated as roots, so the UI still renders.
fn levels(tasks: &[Task]) -> HashMap<TaskId, i64> {
    let ids: HashSet<TaskId> = tasks.iter().map(|t| t.id).collect();
    let parents: HashMap<TaskId, Option<TaskId>> = tasks
        .iter()
        .map(|t| (t.id, effective_parent(t, &ids)))
        .collect();
    let mut levels = HashMap::with_capacity(tasks.len());
    for task in tasks {
        let mut level = 0;
        let mut current = parents.get(&task.id).copied().flatten();
        while let Some(id) = current {
            level += 1;
            if level > tasks.len() as i64 {
                level = 0; // cycle: treat as a root
                break;
            }
            current = parents.get(&id).copied().flatten();
        }
        levels.insert(task.id, level);
    }
    levels
}

/// Place every task on the calendar.
///
/// Two structures are at work and they are deliberately independent:
///
/// * **Dependencies** order tasks. The forward pass honours them plus
///   any pinned `start`; the backward pass derives slack, and zero-slack
///   tasks form the critical path.
/// * **The work breakdown** contains them. A task with children is a
///   *summary*: its span is the union of its children's, its progress
///   their duration-weighted roll-up. Only leaves are scheduled from
///   dependencies — giving a summary its own dates would produce a
///   second answer competing with the roll-up.
///
/// Both structures degrade instead of failing when they come back
/// malformed. Two peers can concurrently add edges that only close a
/// loop once merged, or re-parent tasks into a cycle, so a broken graph
/// is a state the UI has to survive rather than an error it can refuse.
///
/// `today` is the reference date, and it reaches **nothing but the drawn
/// window**. No task's dates depend on it, which is what makes `:asof` a
/// line you move across a fixed plan rather than a re-plan — see the
/// forward pass.
pub fn schedule(tasks: &[Task], deps: &[Dep], today: NaiveDate) -> Schedule {
    if tasks.is_empty() {
        return Schedule {
            tasks: Vec::new(),
            start: today,
            end: today,
            critical_path: Vec::new(),
        };
    }

    // Every edge rewritten to run between leaves, so both passes and the
    // slack that follows operate on a graph of things that carry dates.
    // The roll-up below is untouched by this and stays the only place a
    // summary gets any.
    let edges = expand(tasks, deps);
    let (preds, succs) = adjacency(&edges);
    let lag = lags(&edges);
    let order = topo_order(tasks, &succs);
    let by_id: HashMap<TaskId, &Task> = tasks.iter().map(|t| (t.id, t)).collect();
    let children = children_of(tasks);
    let level = levels(tasks);
    let is_summary = |id: &TaskId| children.get(id).is_some_and(|c| !c.is_empty());

    // Forward pass, leaves only: earliest start / earliest finish.
    //
    // Summaries are deliberately skipped. Their dates come from their
    // children in the roll-up below, so scheduling them here would just
    // produce a second answer to fight with.
    let mut es: HashMap<TaskId, NaiveDate> = HashMap::new();
    let mut ef: HashMap<TaskId, NaiveDate> = HashMap::new();
    for id in &order {
        let Some(task) = by_id.get(id) else { continue };
        if is_summary(id) {
            continue;
        }
        // A task with nothing pinning it starts on the day it was typed.
        //
        // Two dates stood here before and both moved on their own. First
        // `project_start`, the oldest pin anywhere in the plan, which
        // sank every new task months behind the work in flight (#85).
        // Then `today` (#88), which fixed that and introduced a subtler
        // version of the same problem: an unpinned task slid forward a
        // day every day, so a plan nobody touched still finished later
        // each morning, and `:asof` — a *reference* date — silently
        // re-planned the project instead of reporting on it.
        //
        // `created_at` is the only date a task carries that cannot move
        // on its own, so it is the only honest default. The consequence
        // is deliberate: unstarted work sits where it was planned, and
        // once the reference line passes it the bar is left behind the
        // line, which is what being late looks like. #88 argued the
        // opposite — that a plan for work that has not happened cannot
        // begin before today — and that reading is what hid the drift.
        //
        // An explicit `start` still wins, and the floor still applies to
        // a task with predecessors: `max` below keeps their constraint,
        // so a successor can be pushed past its own creation day but
        // never pulled back before it.
        let mut start = task.start.unwrap_or_else(|| task.created_day());
        for p in preds.get(id).into_iter().flatten() {
            // A dependency on a summary contributes nothing: only leaves
            // carry dates at this point.
            if let Some(pred_end) = ef.get(p) {
                // The edge's own spacing, not a constant. `1` — the value
                // this was hard-coded to — still means "the next day", and
                // `0` lets the two share a date, which is the whole point
                // of the field.
                let days = lag.get(&(*p, *id)).copied().unwrap_or_else(default_lag);
                start = start.max(plus_days(*pred_end, days));
            }
        }
        let end = plus_days(start, duration_of(task) - 1);
        es.insert(*id, start);
        ef.insert(*id, end);
    }

    // The left edge of the drawn window: as far back as anything is
    // actually placed, and never later than the reference date.
    //
    // A question about the *chart*, not about when work can be done — but
    // it has to be asked of the schedule rather than of the pins. It read
    // `tasks.filter_map(|t| t.start).min()` while unpinned tasks were
    // anchored on `today`, which could never be earlier; anchored on the
    // creation day they routinely are, and a bar left of the window is
    // drawn at a negative offset inside a pane whose `scrollLeft` stops at
    // 0 — on screen for nobody. A pin on a *summary* drops out of this
    // for the same reason it drops out of everything else: its dates come
    // from its children, so it can only stretch the window past where
    // anything is drawn.
    let project_start = es
        .values()
        .copied()
        .min()
        .map_or(today, |earliest| earliest.min(today));

    let leaf_end = ef.values().copied().max().unwrap_or(project_start);

    // Backward pass, leaves only: latest start, hence slack.
    let mut ls: HashMap<TaskId, NaiveDate> = HashMap::new();
    for id in order.iter().rev() {
        let Some(task) = by_id.get(id) else { continue };
        if is_summary(id) {
            continue;
        }
        let mut finish = leaf_end;
        for s in succs.get(id).into_iter().flatten() {
            if let Some(succ_start) = ls.get(s) {
                // The same lag the forward pass used, mirrored. Left at a
                // constant here it would compute slack against a spacing
                // the forward pass no longer honours, and the critical
                // path would disagree with the dates on screen.
                let days = lag.get(&(*id, *s)).copied().unwrap_or_else(default_lag);
                finish = finish.min(minus_days(*succ_start, days));
            }
        }
        ls.insert(*id, minus_days(finish, duration_of(task) - 1));
    }

    let mut slack: HashMap<TaskId, i64> = ls
        .iter()
        .filter_map(|(id, late)| es.get(id).map(|early| (*id, (*late - *early).num_days())))
        .collect();
    // A done task counts as complete whatever its percentage field says.
    // Without this a finished task rolls up as 0%, which drags its
    // parent's number down and makes a healthy project look stalled.
    let mut progress: HashMap<TaskId, i64> = tasks
        .iter()
        .map(|t| {
            let own = if t.status == Status::Done {
                100
            } else {
                t.progress.clamp(0, 100)
            };
            (t.id, own)
        })
        .collect();
    // Weight for the progress roll-up: a leaf counts for its duration, a
    // summary for the sum of its subtree, so a two-week child moves the
    // parent more than a one-day sibling.
    let mut weight: HashMap<TaskId, i64> = tasks.iter().map(|t| (t.id, duration_of(t))).collect();
    // Predecessor *status*, not dates — and deliberately still so now that
    // an edge can have a zero lag. A same-day successor is blocked until
    // its predecessor is done, because that is what the edge says: A
    // finishes before B starts, whether or not they share a calendar
    // square. It reads oddly on a bar drawn alongside its predecessor, and
    // the alternative reads worse: making `blocked` a function of dates
    // would have it mean "not today" instead of "not yet", and a task
    // waiting on unfinished work would stop saying so the moment the
    // scheduler happened to place it late enough.
    let mut blocked: HashMap<TaskId, bool> = tasks
        .iter()
        .map(|task| {
            let waiting = preds
                .get(&task.id)
                .into_iter()
                .flatten()
                .any(|p| by_id.get(p).is_some_and(|t| t.status != Status::Done));
            (task.id, waiting)
        })
        .collect();

    // Roll summaries up, deepest first, so every child is resolved by
    // the time its parent is reached.
    let mut deepest_first: Vec<&Task> = tasks.iter().collect();
    deepest_first.sort_by_key(|t| std::cmp::Reverse(level.get(&t.id).copied().unwrap_or(0)));
    for task in deepest_first {
        let Some(kids) = children.get(&task.id).filter(|k| !k.is_empty()) else {
            continue;
        };
        if let Some(start) = kids.iter().filter_map(|k| es.get(k)).min().copied() {
            es.insert(task.id, start);
        }
        if let Some(end) = kids.iter().filter_map(|k| ef.get(k)).max().copied() {
            ef.insert(task.id, end);
        }
        if let Some(min_slack) = kids.iter().filter_map(|k| slack.get(k)).min().copied() {
            slack.insert(task.id, min_slack);
        }
        let total: i64 = kids
            .iter()
            .map(|k| weight.get(k).copied().unwrap_or(1))
            .sum();
        if total > 0 {
            let done: i64 = kids
                .iter()
                .map(|k| {
                    weight.get(k).copied().unwrap_or(1) * progress.get(k).copied().unwrap_or(0)
                })
                .sum();
            progress.insert(task.id, (done / total).clamp(0, 100));
        }
        weight.insert(task.id, total.max(1));
        // A summary is blocked when anything inside it is.
        let any_blocked = kids
            .iter()
            .any(|k| blocked.get(k).copied().unwrap_or(false));
        if any_blocked {
            blocked.insert(task.id, true);
        }
    }

    let project_end = ef.values().copied().max().unwrap_or(project_start);

    let mut scheduled: Vec<Scheduled> = tasks
        .iter()
        .map(|task| {
            let start = es.get(&task.id).copied().unwrap_or(project_start);
            let end = ef.get(&task.id).copied().unwrap_or(project_start);
            let slack_days = slack.get(&task.id).copied().unwrap_or(0);
            let kids = children.get(&task.id).map_or(0, |c| c.len() as i64);
            Scheduled {
                id: task.id,
                start,
                end,
                slack_days,
                critical: slack_days <= 0,
                blocked: blocked.get(&task.id).copied().unwrap_or(false),
                overdue: task.due.is_some_and(|due| due < end),
                level: level.get(&task.id).copied().unwrap_or(0),
                summary: kids > 0,
                progress: progress.get(&task.id).copied().unwrap_or(0),
                children: kids,
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
    use chrono::{Local, TimeZone, Utc};
    use uuid::Uuid;

    fn id(n: u128) -> TaskId {
        Uuid::from_u128(n)
    }

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, d).unwrap()
    }

    fn task(n: u128, duration: i64, start: Option<NaiveDate>) -> Task {
        born(n, duration, start, day(1))
    }

    /// As [`task`], but typed on a chosen day — which is where it starts
    /// when nothing pins it.
    ///
    /// *Local* noon, converted to UTC, so `created_day` reads back the
    /// day that was asked for on every machine. Neither shortcut works:
    /// a UTC midnight is the previous day for everyone west of it, and a
    /// UTC noon is the next day in +13/+14. Building the instant in the
    /// same frame the assertion is written in is the only version with
    /// no offset left to go wrong.
    fn born(n: u128, duration: i64, start: Option<NaiveDate>, created: NaiveDate) -> Task {
        let now = Local
            .from_local_datetime(&created.and_hms_opt(12, 0, 0).unwrap())
            .single()
            .expect("local noon is unambiguous")
            .with_timezone(&Utc);
        Task {
            id: id(n),
            parent: None,
            title: format!("task {n}"),
            notes: String::new(),
            assignee: String::new(),
            status: Status::Todo,
            priority: 0,
            start,
            duration_days: duration,
            due: None,
            actual_start: None,
            actual_end: None,
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

    /// An edge with the historical one-day spacing.
    fn dep(from: u128, to: u128) -> Dep {
        Dep::new(id(from), id(to))
    }

    /// An edge with an explicit lag — `0` lets the two share a date.
    fn dep_lag(from: u128, to: u128, lag_days: i64) -> Dep {
        Dep {
            from: id(from),
            to: id(to),
            lag_days,
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
    fn a_zero_lag_edge_lets_two_tasks_share_a_date() {
        // The case from #81: B waits for A, and both are half-day jobs
        // that get done in one sitting. Before the lag existed the second
        // one was always pushed to tomorrow, with no way to say otherwise.
        let tasks = vec![task(1, 1, Some(day(1))), task(2, 1, None)];
        let s = schedule(&tasks, &[dep_lag(1, 2, 0)], day(1));

        assert_eq!(find(&s, 1).end, day(1));
        assert_eq!(find(&s, 2).start, day(1), "same calendar day, not the next");
        // Still an edge, so still a chain: nothing has slack.
        assert_eq!(find(&s, 2).slack_days, 0);
    }

    #[test]
    fn a_pinned_start_equal_to_the_predecessors_finish_is_kept_at_zero_lag() {
        // The symptom a user actually reports: they pin the date and it
        // moves anyway. With the default spacing the pin is still raised,
        // because the edge asks for the next day and the pin is a floor.
        let tasks = vec![task(1, 1, Some(day(1))), task(2, 1, Some(day(1)))];

        let pushed = schedule(&tasks, &[dep(1, 2)], day(1));
        assert_eq!(find(&pushed, 2).start, day(2), "default spacing still wins");

        let kept = schedule(&tasks, &[dep_lag(1, 2, 0)], day(1));
        assert_eq!(find(&kept, 2).start, day(1), "zero lag honours the pin");
    }

    #[test]
    fn a_lag_longer_than_a_day_pushes_the_successor_out() {
        // Not just 0 vs 1: the field is a number, and a wait — parts
        // arriving, paint drying — is the other thing it expresses.
        let tasks = vec![task(1, 2, Some(day(1))), task(2, 1, None)];
        let s = schedule(&tasks, &[dep_lag(1, 2, 5)], day(1));

        assert_eq!(find(&s, 1).end, day(2));
        assert_eq!(find(&s, 2).start, day(7), "five days after the finish");
        assert_eq!(s.end, day(7));
    }

    #[test]
    fn slack_is_measured_against_each_edges_own_lag() {
        // The backward pass mirrors the forward one. Left at a constant it
        // would compute slack against a spacing the dates no longer use,
        // and the critical path would disagree with the bars on screen.
        //
        // The two branches are deliberately *unequal*, and the inequality
        // comes only from a lag rather than from any duration:
        //
        //   1 ──▶ 2 ──▶ 4     default spacing twice — the long way
        //   1 ─0─▶ 3 ─0─▶ 4   two same-day hand-offs — two days shorter
        //
        // Every task is one day, so if the backward pass read a constant
        // instead of each edge's lag it would measure both branches the
        // same and report no slack on 3. The non-zero assertion below is
        // what makes this test about lags at all.
        let tasks = vec![
            task(1, 1, Some(day(1))),
            task(2, 1, None),
            task(3, 1, None),
            task(4, 1, None),
        ];
        let deps = vec![dep(1, 2), dep(2, 4), dep_lag(1, 3, 0), dep_lag(3, 4, 0)];
        let s = schedule(&tasks, &deps, day(1));

        // The long way: 1 ends day 1, 2 the day after, 4 the day after that.
        assert_eq!(find(&s, 2).start, day(2));
        assert_eq!(find(&s, 4).start, day(3));
        // The short way: both hand-offs are same-day, so 3 sits on day 1.
        assert_eq!((find(&s, 3).start, find(&s, 3).end), (day(1), day(1)));

        // 2 is on the critical path; 3 could slip two days without moving
        // the project end, which is exactly the gap the lags opened.
        assert_eq!(find(&s, 2).slack_days, 0);
        assert!(find(&s, 2).critical);
        assert_eq!(find(&s, 3).slack_days, 2);
        assert!(!find(&s, 3).critical);
    }

    #[test]
    fn an_absurd_lag_saturates_instead_of_panicking() {
        // `NaiveDate + Duration` panics out of range, and `schedule` runs on
        // every read of the state — so one `:dep 3 +9999999999` would stop
        // the project being readable at all. `:dep` refuses such a number
        // and the store clamps it, but a peer on any version can write one,
        // so the arithmetic saturates as the last line of defence.
        let tasks = vec![task(1, 1, Some(day(1))), task(2, 1, None)];
        let s = schedule(&tasks, &[dep_lag(1, 2, i64::MAX)], day(1));
        assert!(find(&s, 2).start > day(1), "placed far out, not panicking");

        // Same for a duration, which has never been bounded anywhere.
        let mut huge = task(3, i64::MAX, Some(day(1)));
        huge.duration_days = i64::MAX;
        let s = schedule(&[huge], &[], day(1));
        assert!(find(&s, 3).end >= find(&s, 3).start);
    }

    #[test]
    fn a_negative_lag_cannot_pull_a_successor_before_its_predecessor() {
        // Clamped rather than honoured. A negative lag is an overlap, which
        // "A finishes before B starts" cannot carry — it would need a
        // different kind of edge, not a smaller number.
        let tasks = vec![task(1, 3, Some(day(1))), task(2, 1, None)];
        let s = schedule(&tasks, &[dep_lag(1, 2, -5)], day(1));

        assert_eq!(find(&s, 1).end, day(3));
        assert_eq!(find(&s, 2).start, day(3), "no earlier than the finish");
    }

    #[test]
    fn a_zero_lag_successor_is_still_blocked_until_its_predecessor_is_done() {
        // Decided deliberately: `blocked` reads predecessor *status*, not
        // dates. Sharing a calendar square does not mean B may start.
        let mut tasks = vec![task(1, 1, Some(day(1))), task(2, 1, None)];
        let deps = vec![dep_lag(1, 2, 0)];

        let s = schedule(&tasks, &deps, day(1));
        assert_eq!(find(&s, 2).start, find(&s, 1).start, "same day");
        assert!(find(&s, 2).blocked, "still waiting on unfinished work");

        tasks[0].status = Status::Done;
        let s = schedule(&tasks, &deps, day(1));
        assert!(!find(&s, 2).blocked);
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
        let tasks = vec![task(1, 1, None), task(2, 1, None), task(3, 1, None)];
        let deps = vec![dep(1, 2), dep(2, 3)];
        assert!(
            would_cycle(&tasks, &deps, id(3), id(1)),
            "3 -> 1 closes the loop"
        );
        assert!(
            !would_cycle(&tasks, &deps, id(1), id(3)),
            "1 -> 3 is just a shortcut edge"
        );
        assert!(would_cycle(&tasks, &deps, id(1), id(1)), "self-edge");
    }

    /// `child(n, parent, duration)` — a leaf inside `parent`.
    fn child(n: u128, parent: u128, duration: i64) -> Task {
        let mut task = task(n, duration, None);
        task.parent = Some(id(parent));
        task
    }

    #[test]
    fn a_summary_spans_its_children() {
        // 1 is the project; 2 and 3 are the work.
        let mut parent = task(1, 1, None);
        parent.duration_days = 99; // ignored: summaries don't have their own span
        let mut a = child(2, 1, 3);
        a.start = Some(day(4));
        let mut b = child(3, 1, 2);
        b.start = Some(day(10));

        let s = schedule(&[parent, a, b], &[], day(1));
        let root = find(&s, 1);
        assert_eq!((root.start, root.end), (day(4), day(11)));
        assert!(root.summary);
        assert_eq!(root.children, 2);
        assert_eq!(root.level, 0);
        assert_eq!(find(&s, 2).level, 1);
    }

    #[test]
    fn summary_progress_is_weighted_by_duration() {
        let parent = task(1, 1, None);
        // A 9-day task at 100% and a 1-day task at 0% is 90%, not 50%.
        let mut long_done = child(2, 1, 9);
        long_done.start = Some(day(1));
        long_done.progress = 100;
        let mut short_todo = child(3, 1, 1);
        short_todo.start = Some(day(1));
        short_todo.progress = 0;

        let s = schedule(&[parent, long_done, short_todo], &[], day(1));
        assert_eq!(find(&s, 1).progress, 90);
    }

    #[test]
    fn a_done_child_counts_as_complete_in_the_roll_up() {
        // Marking a task done without touching its percentage field is
        // the normal path (`x` does exactly that), so the roll-up has to
        // treat it as 100 or a finished project reads as barely started.
        let parent = task(1, 1, None);
        let mut finished = child(2, 1, 4);
        finished.start = Some(day(1));
        finished.status = Status::Done;
        finished.progress = 0;
        let mut pending = child(3, 1, 4);
        pending.start = Some(day(1));

        let s = schedule(&[parent, finished, pending], &[], day(1));
        assert_eq!(find(&s, 2).progress, 100, "the done leaf itself");
        assert_eq!(find(&s, 1).progress, 50, "and its half of the parent");
    }

    #[test]
    fn levels_nest_and_roll_up_through_grandchildren() {
        let root = task(1, 1, None);
        let mut mid = task(2, 1, None);
        mid.parent = Some(id(1));
        let mut leaf = child(3, 2, 4);
        leaf.start = Some(day(5));

        let s = schedule(&[root, mid, leaf], &[], day(1));
        assert_eq!(find(&s, 1).level, 0);
        assert_eq!(find(&s, 2).level, 1);
        assert_eq!(find(&s, 3).level, 2);
        // The grandchild's span reaches all the way to the root.
        assert_eq!((find(&s, 1).start, find(&s, 1).end), (day(5), day(8)));
        assert!(find(&s, 2).summary && !find(&s, 3).summary);
    }

    #[test]
    fn dependencies_still_order_leaves_inside_a_breakdown() {
        // Hierarchy and dependencies are independent axes: 2 and 3 are
        // siblings, and 2 must still finish before 3 starts.
        let parent = task(1, 1, None);
        let mut first = child(2, 1, 2);
        first.start = Some(day(1));
        let second = child(3, 1, 2);

        let s = schedule(&[parent, first, second], &[dep(2, 3)], day(1));
        assert_eq!(find(&s, 2).end, day(2));
        assert_eq!(find(&s, 3).start, day(3));
        assert_eq!(find(&s, 1).end, day(4), "the summary covers both");
    }

    /// `Parent 1 { 2, 3 }` plus a standalone `4`, all one day, nothing
    /// pinned but `2`.
    fn summary_fixture() -> Vec<Task> {
        let parent = task(1, 1, None);
        let mut a = child(2, 1, 1);
        a.start = Some(day(1));
        let b = child(3, 1, 1);
        let other = task(4, 1, None);
        vec![parent, a, b, other]
    }

    #[test]
    fn a_dependency_onto_a_summary_pushes_every_child() {
        // #86: the edge drew, survived the cycle check and moved nothing.
        // `4 -> 1` has to hold back everything inside 1, since 1 has no
        // dates of its own for the constraint to land on.
        let mut tasks = summary_fixture();
        tasks[1].start = None; // let the children float
        let s = schedule(&tasks, &[dep(4, 1)], day(1));

        assert_eq!(find(&s, 4).end, day(1));
        assert_eq!(find(&s, 2).start, day(2), "child waits for 4");
        assert_eq!(find(&s, 3).start, day(2), "and so does its sibling");
        assert_eq!(find(&s, 1).start, day(2), "so the bracket moves with them");
    }

    #[test]
    fn a_dependency_out_of_a_summary_waits_for_its_latest_child() {
        // `1 -> 4`. The bracket closes when the *last* child does, so 4
        // waits for that and not for whichever child happens to be first.
        let mut tasks = summary_fixture();
        tasks[2].duration_days = 5; // 3 is now the long one
        let s = schedule(&tasks, &[dep(1, 4)], day(1));

        assert_eq!(find(&s, 2).end, day(1));
        assert_eq!(find(&s, 3).end, day(5));
        assert_eq!(find(&s, 1).end, day(5), "the bracket");
        assert_eq!(find(&s, 4).start, day(6), "the day after the whole thing");
    }

    #[test]
    fn a_dependency_between_two_summaries_orders_the_brackets() {
        // Both endpoints are summaries, so the edge is the cross product of
        // the two leaf sets — which says exactly what it looks like it says.
        let mut tasks = summary_fixture();
        tasks[2].duration_days = 3;
        let second = task(5, 1, None);
        let x = child(6, 5, 2);
        let y = child(7, 5, 1);
        tasks.extend([second, x, y]);

        let s = schedule(&tasks, &[dep(1, 5)], day(1));
        assert_eq!(find(&s, 1).end, day(3), "first bracket closes on day 3");
        assert_eq!(find(&s, 6).start, day(4));
        assert_eq!(find(&s, 7).start, day(4));
        assert_eq!(find(&s, 5).start, day(4), "second bracket opens after it");
    }

    #[test]
    fn slack_is_consumed_across_an_edge_touching_a_summary() {
        // The backward pass sees the expanded graph too, so the branch
        // through the summary is measured rather than reported as free.
        //
        //   4 ──▶ Parent 1 { 2 (3d), 3 (1d) }
        // 3 is two days shorter than its sibling, so it has that much slack;
        // 2 is on the critical path. Before the fix neither branch knew the
        // edge existed and 4 itself came out with slack it had not earned.
        let mut tasks = summary_fixture();
        tasks[1].start = None;
        tasks[1].duration_days = 3;
        let s = schedule(&tasks, &[dep(4, 1)], day(1));

        assert_eq!(find(&s, 2).slack_days, 0);
        assert!(find(&s, 2).critical);
        assert_eq!(find(&s, 3).slack_days, 2);
        assert_eq!(find(&s, 4).slack_days, 0, "the edge is on the long path");
        assert!(find(&s, 4).critical);
    }

    #[test]
    fn a_zero_lag_edge_onto_a_summary_lets_the_children_start_that_day() {
        // The lag rides the expansion: one statement about the edge, applied
        // to every leaf it now stands for.
        let mut tasks = summary_fixture();
        tasks[1].start = None;
        let s = schedule(&tasks, &[dep_lag(4, 1, 0)], day(1));

        assert_eq!(find(&s, 4).end, day(1));
        assert_eq!(find(&s, 2).start, day(1));
        assert_eq!(find(&s, 3).start, day(1));
    }

    #[test]
    fn a_summary_and_something_inside_it_cannot_be_linked() {
        // Expansion turns this into "this leaf must finish before itself",
        // so `would_cycle` refuses it. It used to be accepted and then
        // silently ignored, which is the worse of the two.
        let tasks = summary_fixture();
        assert!(
            would_cycle(&tasks, &[], id(1), id(2)),
            "the summary cannot precede its own child"
        );
        assert!(
            would_cycle(&tasks, &[], id(2), id(1)),
            "nor the child precede the summary"
        );
        // A sibling outside the subtree is still perfectly legal.
        assert!(!would_cycle(&tasks, &[], id(4), id(1)));
    }

    #[test]
    fn would_cycle_expands_before_answering() {
        // The case the issue names: neither edge closes a loop between the
        // names as written, but together they do once both are rewritten to
        // leaves. Accepting the second would hand the scheduler a cycle the
        // 409 exists to keep out.
        let tasks = summary_fixture();
        let deps = vec![dep(4, 1)]; // 4 -> every leaf of 1
        assert!(
            would_cycle(&tasks, &deps, id(2), id(4)),
            "2 already waits for 4, so 2 -> 4 is a loop"
        );
    }

    #[test]
    fn two_edges_landing_on_the_same_leaf_keep_the_longer_lag() {
        // Expansion can put two edges on one leaf pair: a direct one, and
        // one inherited from an ancestor summary. Both are constraints, so
        // the leaf waits for the longer — and it must not depend on which
        // order the stored edges happen to arrive in.
        //
        //   4 ─────5────▶ 2        (direct, five days)
        //   4 ─0─▶ Parent 1 { 2, 3 }   (same-day, via the summary)
        let mut tasks = summary_fixture();
        tasks[1].start = None;

        let direct = dep_lag(4, 2, 5);
        let via_summary = dep_lag(4, 1, 0);

        for (label, deps) in [
            ("direct first", vec![direct, via_summary]),
            ("summary first", vec![via_summary, direct]),
        ] {
            let s = schedule(&tasks, &deps, day(1));
            assert_eq!(find(&s, 4).end, day(1));
            assert_eq!(
                find(&s, 2).start,
                day(6),
                "{label}: five days after 4, not the same day"
            );
            // 3 only has the summary edge, so it is free to start at once.
            assert_eq!(find(&s, 3).start, day(1), "{label}: sibling unaffected");
        }
    }

    #[test]
    fn an_edge_touching_a_summary_marks_its_children_blocked() {
        // `blocked` reads predecessor status, and after expansion the rows
        // that actually wait are the children — the roll-up then marks the
        // summary too, which is where the flag was coming from before.
        let mut tasks = summary_fixture();
        tasks[1].start = None;
        let s = schedule(&tasks, &[dep(4, 1)], day(1));
        assert!(find(&s, 2).blocked);
        assert!(find(&s, 3).blocked);
        assert!(find(&s, 1).blocked, "and so the bracket reads blocked");

        tasks[3].status = Status::Done; // 4 is finished
        let s = schedule(&tasks, &[dep(4, 1)], day(1));
        assert!(!find(&s, 2).blocked);
        assert!(!find(&s, 1).blocked);
    }

    #[test]
    fn a_summary_is_blocked_when_anything_inside_it_is() {
        let parent = task(1, 1, None);
        let mut blocker = task(2, 1, Some(day(1)));
        let inner = child(3, 1, 1);

        let s = schedule(
            &[parent.clone(), blocker.clone(), inner.clone()],
            &[dep(2, 3)],
            day(1),
        );
        assert!(find(&s, 3).blocked, "the leaf waits on an unfinished task");
        assert!(find(&s, 1).blocked, "and so the summary does too");

        blocker.status = Status::Done;
        let s = schedule(&[parent, blocker, inner], &[dep(2, 3)], day(1));
        assert!(!find(&s, 1).blocked);
    }

    #[test]
    fn a_parent_cycle_degrades_to_roots() {
        // Two peers re-parent into each other; the merge produces a loop.
        let mut a = task(1, 1, Some(day(1)));
        let mut b = task(2, 1, Some(day(1)));
        a.parent = Some(id(2));
        b.parent = Some(id(1));

        let s = schedule(&[a, b], &[], day(1));
        assert_eq!(s.tasks.len(), 2, "both still render");
        assert_eq!(find(&s, 1).level, 0);
        assert_eq!(find(&s, 2).level, 0);
    }

    #[test]
    fn a_missing_parent_leaves_the_child_at_the_root() {
        // The parent's tombstone arrived but the child's update hasn't.
        let mut orphan = task(1, 2, Some(day(3)));
        orphan.parent = Some(id(99));

        let s = schedule(&[orphan], &[], day(1));
        assert_eq!(find(&s, 1).level, 0);
        assert!(!find(&s, 1).summary);
    }

    #[test]
    fn empty_project_is_a_single_day_at_today() {
        let s = schedule(&[], &[], day(4));
        assert_eq!((s.start, s.end), (day(4), day(4)));
    }

    #[test]
    fn a_new_task_lands_on_the_day_it_was_typed() {
        // The case from #85, in its final form. One task pinned back at
        // day 1, one added on day 20 with nothing pinning it. It must not
        // fall to the oldest pin in the plan and sort above everything in
        // flight — and it must not follow the reference date either.
        let tasks = vec![task(1, 2, Some(day(1))), born(2, 1, None, day(20))];
        let s = schedule(&tasks, &[], day(20));

        assert_eq!(find(&s, 2).start, day(20), "born where it was typed");
        assert_eq!(find(&s, 2).end, day(20));
        // And the *window* still reaches back to the old pin — that is a
        // different question, and the one `project_start` answers.
        assert_eq!(s.start, day(1));
    }

    #[test]
    fn an_unpinned_task_stays_put_as_the_days_pass() {
        // The drift #88 left behind: the same plan, read on three
        // different days, has to give the same answer. Nothing here is
        // pinned, so under the old anchor every one of these moved.
        let tasks = vec![born(1, 2, None, day(4))];
        for viewed_on in [day(4), day(11), day(25)] {
            let s = schedule(&tasks, &[], viewed_on);
            assert_eq!(
                (find(&s, 1).start, find(&s, 1).end),
                (day(4), day(5)),
                "read on {viewed_on}"
            );
        }
    }

    #[test]
    fn an_unpinned_successor_follows_its_predecessor_into_the_past() {
        // Read on day 20, a chain planned for the start of the month is
        // simply late: the successor sits at day 3, behind the reference
        // line, where the old floor would have moved it up to day 20 and
        // shown a plan that was never made.
        let tasks = vec![task(1, 2, Some(day(1))), task(2, 1, None)];
        let s = schedule(&tasks, &[dep(1, 2)], day(20));

        assert_eq!(find(&s, 1).end, day(2));
        assert_eq!(find(&s, 2).start, day(3), "the day after its predecessor");
    }

    #[test]
    fn a_predecessor_can_push_a_successor_past_its_creation_day() {
        // The floor is a floor, not a pin: the creation day loses to a
        // predecessor that finishes after it.
        let tasks = vec![task(1, 5, Some(day(10))), born(2, 1, None, day(2))];
        let s = schedule(&tasks, &[dep(1, 2)], day(2));

        assert_eq!(find(&s, 2).start, day(15), "pushed off day 2");
    }

    #[test]
    fn a_pinned_start_may_still_sit_in_the_past() {
        // The floor is a *default*, not a clamp. An explicit date is a
        // statement, and recording that something began on the 5th has to
        // survive being read on the 20th.
        let tasks = vec![task(1, 2, Some(day(5)))];
        let s = schedule(&tasks, &[], day(20));

        assert_eq!((find(&s, 1).start, find(&s, 1).end), (day(5), day(6)));
    }

    #[test]
    fn the_reference_date_moves_the_line_and_not_the_plan() {
        // `today` here is the `:asof` date when one is set. It is a line
        // drawn across the plan — looking at Friday must not re-plan the
        // project into Friday, and looking at last week must not drag it
        // backwards either.
        let tasks = vec![born(1, 1, None, day(6))];
        for viewed_on in [day(3), day(6), day(9)] {
            assert_eq!(find(&schedule(&tasks, &[], viewed_on), 1).start, day(6));
        }
    }

    #[test]
    fn a_chain_of_unpinned_tasks_runs_forward_from_its_creation_day() {
        // Nothing pinned anywhere: the whole chain hangs off the anchor,
        // which is what a project typed from scratch looks like.
        let tasks = vec![task(1, 2, None), task(2, 1, None), task(3, 1, None)];
        let s = schedule(&tasks, &[dep(1, 2), dep(2, 3)], day(10));

        assert_eq!((find(&s, 1).start, find(&s, 1).end), (day(1), day(2)));
        assert_eq!(find(&s, 2).start, day(3));
        assert_eq!(find(&s, 3).start, day(4));
        assert_eq!(s.start, day(1), "the window opens where the work does");
    }

    #[test]
    fn the_window_covers_an_unpinned_task_older_than_every_pin() {
        // The bar has to be inside the drawn window or it renders at a
        // negative offset in a pane that cannot scroll below 0 — visible
        // to nobody. Reachable now that an unpinned task can sit earlier
        // than anything anyone pinned.
        let tasks = vec![task(1, 1, Some(day(10))), born(2, 1, None, day(2))];
        let s = schedule(&tasks, &[], day(20));

        assert_eq!(find(&s, 2).start, day(2));
        assert!(s.start <= day(2), "window opened at {}", s.start);
    }

    #[test]
    fn the_window_reaches_the_reference_date_even_when_the_plan_is_later() {
        // The line is drawn at `today`, so it has to be in frame. A plan
        // entirely in the future would otherwise open the chart past it.
        let tasks = vec![born(1, 1, Some(day(25)), day(25))];
        let s = schedule(&tasks, &[], day(20));

        assert_eq!(s.start, day(20));
    }
}
