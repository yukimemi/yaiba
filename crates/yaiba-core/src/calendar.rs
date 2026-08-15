//! Which days the work happens on.
//!
//! A duration is counted in *something*, and until this module existed
//! that something was always calendar days: `duration_days = 5` meant
//! five squares on the chart, weekend included. A working-day calendar
//! makes the same 5 mean five days somebody is actually at work.
//!
//! Four properties are load-bearing.
//!
//! **`Days` is the default, and it is exactly the old behaviour.**
//! Switching a project to working days moves every finish date later, so
//! it has to happen by asking rather than by upgrading. Every method here
//! degrades to plain calendar arithmetic under [`CalendarMode::Days`],
//! which is what lets [`crate::graph::schedule`] be written without a
//! single `if mode` in it: the scheduler always asks the calendar, and in
//! `Days` mode the calendar answers the way `plus_days` always did.
//!
//! **One predicate, two consumers.** [`Calendar::is_working`] is the whole
//! notion of "is this a day work happens on", and it means something in
//! both modes: the chart shades non-working days — which is what a
//! hard-coded `isWeekend` used to do on the client — while the scheduler
//! consults it only in `Workdays` mode. A second predicate for shading
//! would be a second answer to keep in step.
//!
//! **The general mechanism is [`DayMark`]; a bundled table is a
//! convenience on top of it.** Any date can be marked a holiday or forced
//! back to a working day, and the API takes those in bulk — which is how a
//! calendar anywhere in the world gets entered, from any source. What
//! ships built in is [`HolidaySet::Jp`], because this tool is written in
//! Japanese for a country whose holidays move around by law and would be
//! miserable to type in every year. It is a *value* rather than a
//! boolean flag precisely so that "Japan or nothing" is not baked into
//! the type: another region is one variant and one function, and the
//! stored protocol does not change.
//!
//! The cost of a table living in code rather than in the data: two
//! replicas on different versions can resolve the same project to
//! different dates until both upgrade. Stored dates would avoid that and
//! go stale the year after they were generated, which is worse — but the
//! trade is real and is why the mode ships off.
//!
//! **Nothing here is cached.** The Japanese table is answered per *date*
//! rather than per year ([`jp_holiday`]), because the two derived rules —
//! 振替休日 and 国民の休日 — need only a handful of neighbouring days. A
//! year-keyed cache would need interior mutability to sit behind the
//! `&self` the scheduler holds, and would then have to be invalidated by
//! every calendar edit, to save a few dozen comparisons.

use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

/// The Monday–Friday week, which is what a project starts with.
pub const WORK_WEEK_MON_FRI: [bool; 7] = [true, true, true, true, true, false, false];

/// Calendar days one arithmetic step may walk before it gives up.
///
/// Roughly 110 years, and reached only by absurd input: `duration_days`
/// has never been bounded anywhere (see [`plus_days`]), and a peer can
/// send a week mask or a run of marked holidays this replica would never
/// write. Hitting the cap **saturates** rather than looping, for the same
/// reason `plus_days` saturates — a bar at the end of the calendar is
/// visibly wrong, where a hang is just a dead app.
const MAX_WALK: i64 = 40_000;

/// `date + days`, saturating at the ends of the calendar.
///
/// `NaiveDate + Duration` and `Duration::days` both **panic** out of
/// range, and this runs on every read of the state — so a single absurd
/// number anywhere in the graph would stop the project being readable at
/// all, which is the one failure the scheduler is written to avoid.
///
/// Lags are clamped before they get here, but `duration_days` is not
/// bounded anywhere and never has been, so this guards both. Saturating
/// rather than ignoring: a bar pinned at the end of the calendar is
/// obviously wrong on screen, where a silently dropped constraint looks
/// like the scheduler forgot an edge.
pub fn plus_days(date: NaiveDate, days: i64) -> NaiveDate {
    Duration::try_days(days)
        .and_then(|d| date.checked_add_signed(d))
        .unwrap_or(if days < 0 {
            NaiveDate::MIN
        } else {
            NaiveDate::MAX
        })
}

/// `date - days`, saturating. See [`plus_days`].
pub fn minus_days(date: NaiveDate, days: i64) -> NaiveDate {
    Duration::try_days(days)
        .and_then(|d| date.checked_sub_signed(d))
        .unwrap_or(if days < 0 {
            NaiveDate::MAX
        } else {
            NaiveDate::MIN
        })
}

/// How a duration is counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalendarMode {
    /// Every calendar day counts. The historical behaviour, and the
    /// default — an upgrade must not move a single bar.
    #[default]
    Days,
    /// Only working days count: `duration_days = 5` is five of them, and
    /// a weekend or a holiday in the middle pushes the finish out.
    Workdays,
}

impl CalendarMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Days => "days",
            Self::Workdays => "workdays",
        }
    }

    /// Every mode there is, for anything that has to name them all.
    ///
    /// One list beside [`Self::as_str`] rather than a second spelling
    /// inside an error message somewhere else.
    pub const ALL: [Self; 2] = [Self::Days, Self::Workdays];

    /// Parse, refusing anything unrecognised.
    ///
    /// Strict because its caller is a *person*: the API takes what was
    /// typed and a mode nobody has heard of is a typo worth being told
    /// about. A **replica** merging a mode a later version wrote must keep
    /// working instead, and that path is the derived `Deserialize` read
    /// through `store::enum_field`, which falls to `Default` on anything it
    /// cannot make sense of. Two callers, two kinds of failure, and
    /// deliberately no third spelling of the vocabulary — `as_str` and
    /// `ALL` are the only place the words live.
    pub fn strict(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.as_str() == raw)
    }
}

/// Which bundled holiday table a project counts as days off.
///
/// Deliberately a value and not a `jp: bool`. The mechanism for holidays
/// is [`DayMark`] — any date, any name, entered in bulk through the API —
/// and a table shipped in the binary is a convenience on top of it for
/// the one country whose dates this tool was written for. Adding another
/// region is a variant here plus a function beside [`jp_holiday`]; nothing
/// stored and nothing on the wire has to change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HolidaySet {
    /// No bundled table. Marks are still honoured — this is what a
    /// project outside Japan uses, and it is the default.
    #[default]
    None,
    /// Japan's 国民の祝日, with 振替休日 and 国民の休日 derived.
    Jp,
}

impl HolidaySet {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Jp => "jp",
        }
    }

    /// Every region this binary knows. See [`CalendarMode::ALL`].
    pub const ALL: [Self; 2] = [Self::None, Self::Jp];

    /// Parse, refusing anything unrecognised. See [`CalendarMode::strict`]
    /// for the split between this and the replica's degrading read.
    ///
    /// What degrading costs here is worth being blunt about, and it is not
    /// the same as for a mode: a region this build does not know reads as
    /// "no bundled table", so it resolves *different dates* than the peer
    /// that wrote it until both are upgraded. The tables live in code
    /// rather than in the data, so a version gap is a date gap — which is
    /// why `holiday:` marks, which mean the same thing on every build, are
    /// the general mechanism and this is the shortcut.
    pub fn strict(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|set| set.as_str() == raw)
    }

    /// The table's answer for one date, if it has one.
    fn holiday(self, date: NaiveDate) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Jp => jp_holiday(date),
        }
    }
}

/// What one particular date has been said about, overriding both the week
/// mask and the bundled table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DayMark {
    /// Not a working day. The string is its name, and may be empty — a day
    /// off nobody bothered to label is still a day off.
    Holiday(String),
    /// A working day, whatever the week mask or the holiday table say.
    /// This is how a Saturday everybody is in gets scheduled, and how a
    /// public holiday the team works through stops costing a day.
    Working,
}

/// A project's working calendar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Calendar {
    pub mode: CalendarMode,
    /// Which weekdays are worked, **Monday first**: index 0 is Monday.
    ///
    /// Said in the type's own documentation because it is the classic
    /// off-by-one in this area — `chrono`'s `num_days_from_monday` agrees
    /// with this order, JavaScript's `getDay()` does not, so the client
    /// converts in exactly one place.
    pub week: [bool; 7],
    /// The bundled table to honour, if any.
    pub holidays: HolidaySet,
    /// Per-date overrides. Absent means "no opinion" — the week mask and
    /// the table decide.
    pub marks: BTreeMap<NaiveDate, DayMark>,
}

impl Default for Calendar {
    fn default() -> Self {
        Self {
            mode: CalendarMode::Days,
            // Not `[true; 7]`, even though `Days` ignores it for
            // scheduling: the mask is also what shades the chart, and a
            // fresh project should draw its weekends the way every
            // version before this one did.
            week: WORK_WEEK_MON_FRI,
            holidays: HolidaySet::None,
            marks: BTreeMap::new(),
        }
    }
}

/// Which way an arithmetic step is walking.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    Forward,
    Back,
}

impl Direction {
    fn step(self, date: NaiveDate) -> Option<NaiveDate> {
        match self {
            Self::Forward => date.succ_opt(),
            Self::Back => date.pred_opt(),
        }
    }

    /// Whether `cursor` still has ground to cover before `target`, in
    /// this direction. What `<` means depends on which way you are
    /// walking, and spelling it here is what lets one loop count both.
    fn before(self, cursor: NaiveDate, target: NaiveDate) -> bool {
        match self {
            Self::Forward => cursor < target,
            Self::Back => cursor > target,
        }
    }
}

impl Calendar {
    /// Whether the week mask works this weekday.
    ///
    /// An all-false mask — which this replica will not write, because the
    /// API refuses one, but which a peer may send — would make every day
    /// non-working: nothing could be scheduled and every walk below would
    /// run to [`MAX_WALK`]. It degrades to "every weekday is worked", the
    /// same reflex the rest of the domain has. A malformed graph still
    /// renders; a malformed calendar still schedules.
    fn week_works(&self, date: NaiveDate) -> bool {
        self.week[date.weekday().num_days_from_monday() as usize]
            || self.week.iter().all(|worked| !worked)
    }

    /// Whether work happens on `date`.
    ///
    /// True in both modes — see the module note on one predicate and two
    /// consumers. The scheduler only cares in [`CalendarMode::Workdays`];
    /// the chart shades by this either way.
    pub fn is_working(&self, date: NaiveDate) -> bool {
        match self.marks.get(&date) {
            // A mark is the last word. It is how a company holiday gets
            // in, and how a Saturday everyone is working gets out.
            Some(DayMark::Working) => true,
            Some(DayMark::Holiday(_)) => false,
            None => self.week_works(date) && self.holidays.holiday(date).is_none(),
        }
    }

    /// What to call a day off, when it has a name.
    ///
    /// `Some("")` for a day off with nothing to call it, `None` for an
    /// ordinary working day: the caller has to be able to tell those
    /// apart. A weekend is neither — it has no name and needs none — so it
    /// also answers `None`.
    pub fn holiday_name(&self, date: NaiveDate) -> Option<String> {
        match self.marks.get(&date) {
            Some(DayMark::Working) => None,
            Some(DayMark::Holiday(name)) => Some(name.clone()),
            None => self.holidays.holiday(date).map(str::to_owned),
        }
    }

    /// Every non-working day in `from..=to` that the week mask does not
    /// already explain, with its name (empty when it has none).
    ///
    /// This is the payload the client renders, and its two exclusions are
    /// the whole shape of it:
    ///
    /// * **Weekends are not listed.** The client holds `week` and works
    ///   them out itself. Enumerating four years of Saturdays would be
    ///   four hundred entries restating what seven booleans say.
    /// * **A holiday landing on a weekend still appears.** It changes
    ///   nothing about whether the day is worked, but it has a name, and
    ///   the name is what the chart's header shows.
    pub fn off_days(&self, from: NaiveDate, to: NaiveDate) -> Vec<(NaiveDate, String)> {
        each_day(from, to)
            .filter_map(|date| match self.marks.get(&date) {
                Some(DayMark::Holiday(name)) => Some((date, name.clone())),
                Some(DayMark::Working) => None,
                None => self
                    .holidays
                    .holiday(date)
                    .map(|name| (date, name.to_owned())),
            })
            .collect()
    }

    /// The days in `from..=to` forced to be working days against what the
    /// week mask or the bundled table would otherwise say.
    ///
    /// A mark that merely agrees with them overrides nothing, so putting
    /// it on the wire would be noise for the client to filter out again.
    pub fn working_overrides(&self, from: NaiveDate, to: NaiveDate) -> Vec<NaiveDate> {
        each_day(from, to)
            .filter(|date| {
                matches!(self.marks.get(date), Some(DayMark::Working))
                    && !(self.week_works(*date) && self.holidays.holiday(*date).is_none())
            })
            .collect()
    }

    /// The first working day at or after `date`.
    ///
    /// This is what makes a pinned start a *floor* rather than a promise:
    /// a task pinned to a Sunday starts on the Monday, and says so on the
    /// chart instead of quietly claiming a day nobody works.
    pub fn snap_forward(&self, date: NaiveDate) -> NaiveDate {
        self.snap(date, Direction::Forward)
    }

    /// The last working day at or before `date` — the backward pass's
    /// mirror of [`Self::snap_forward`].
    pub fn snap_back(&self, date: NaiveDate) -> NaiveDate {
        self.snap(date, Direction::Back)
    }

    fn snap(&self, date: NaiveDate, dir: Direction) -> NaiveDate {
        if self.mode == CalendarMode::Days {
            return date;
        }
        let mut cursor = date;
        for _ in 0..MAX_WALK {
            if self.is_working(cursor) {
                return cursor;
            }
            match dir.step(cursor) {
                Some(next) => cursor = next,
                None => return cursor,
            }
        }
        cursor
    }

    /// `date` moved `n` working days forward, landing on a working day.
    ///
    /// `advance(d, 0)` is [`Self::snap_forward`]: a zero lag means "the
    /// same day the predecessor finished", which is already a working day,
    /// and a one-day duration is `advance(start, 0)` — the task finishes
    /// the day it starts.
    ///
    /// A negative `n` retreats, so the two directions are one function
    /// seen from either end.
    pub fn advance(&self, date: NaiveDate, n: i64) -> NaiveDate {
        if self.mode == CalendarMode::Days {
            return plus_days(date, n);
        }
        match n {
            0.. => self.walk(date, n, Direction::Forward),
            _ => self.walk(date, n.saturating_neg(), Direction::Back),
        }
    }

    /// `date` moved `n` working days back. See [`Self::advance`].
    pub fn retreat(&self, date: NaiveDate, n: i64) -> NaiveDate {
        if self.mode == CalendarMode::Days {
            return minus_days(date, n);
        }
        match n {
            0.. => self.walk(date, n, Direction::Back),
            _ => self.walk(date, n.saturating_neg(), Direction::Forward),
        }
    }

    fn walk(&self, date: NaiveDate, n: i64, dir: Direction) -> NaiveDate {
        let mut cursor = self.snap(date, dir);
        let mut left = n;
        let mut walked = 0;
        while left > 0 {
            walked += 1;
            if walked > MAX_WALK {
                return cursor;
            }
            cursor = match dir.step(cursor) {
                Some(next) => next,
                None => return cursor,
            };
            if self.is_working(cursor) {
                left -= 1;
            }
        }
        cursor
    }

    /// Working-day steps from `from` to `to`, the inverse of
    /// [`Self::advance`]. The contract is stated on the **count**, not on
    /// the order of the two dates, because zero has no sign:
    ///
    /// * `count > 0` → `advance(from, count)` is `snap_forward(to)`.
    /// * `count < 0` → `advance(from, count)` is `snap_back(to)`.
    /// * `count == 0` → nothing is walked, so `advance(from, 0)` is
    ///   `snap_forward(from)` — an answer about `from`, not about `to`.
    ///
    /// That third line is not pedantry: two dates either side of a long
    /// weekend can both snap *backwards* onto the same Friday, so the
    /// count is zero while `to` is genuinely the earlier date, and
    /// `advance` then snaps forward over the whole holiday run. Stating
    /// the contract by direction instead reads as a promise about
    /// `snap_back(to)` that is false in exactly that case.
    ///
    /// The two signed halves have to be measured from the end they will be
    /// replayed from, which is why the direction reaches [`Self::steps`]
    /// rather than being faked by swapping the arguments. Counting
    /// backwards from a `from` that is *itself* a day off snapped the
    /// wrong way round when it was, and the identity broke — reachable
    /// from any caller that hands this an arbitrary date, even though
    /// every date the scheduler hands it is already a working day.
    ///
    /// This is also what a slack of "3d" means once a project counts
    /// working days: three days somebody could have worked, not three
    /// squares two of which are a weekend. The sign says which way round
    /// the two dates are, which is what keeps a task with negative slack
    /// on the critical path.
    pub fn count(&self, from: NaiveDate, to: NaiveDate) -> i64 {
        if self.mode == CalendarMode::Days {
            return (to - from).num_days();
        }
        if to < from {
            return -self.steps(from, to, Direction::Back);
        }
        self.steps(from, to, Direction::Forward)
    }

    /// Working days strictly between `snap(from)` and `snap(to)`, counting
    /// the far end — the interval that makes `count` and `advance`
    /// inverses. Both ends are snapped the way the walk runs.
    fn steps(&self, from: NaiveDate, to: NaiveDate, dir: Direction) -> i64 {
        let target = self.snap(to, dir);
        let mut cursor = self.snap(from, dir);
        let mut steps = 0;
        let mut walked = 0;
        while dir.before(cursor, target) {
            walked += 1;
            if walked > MAX_WALK {
                return steps;
            }
            cursor = match dir.step(cursor) {
                Some(next) => next,
                None => return steps,
            };
            if self.is_working(cursor) {
                steps += 1;
            }
        }
        steps
    }
}

/// `from..=to`, bounded, and empty when the two are the wrong way round.
fn each_day(from: NaiveDate, to: NaiveDate) -> impl Iterator<Item = NaiveDate> {
    from.iter_days()
        .take_while(move |date| *date <= to)
        // The API asks for a window of a few years; the bound is here so
        // that a caller asking for the whole calendar gets a long answer
        // rather than no answer at all.
        .take(MAX_WALK as usize)
}

/// Parse the seven-character week mask the CRDT stores, Monday first.
///
/// `None` for anything malformed — the caller degrades to the default
/// rather than guessing, because a mask read from the wrong end is wrong
/// six days out of seven and plausible on the seventh.
pub fn parse_week_mask(mask: &str) -> Option<[bool; 7]> {
    let bytes = mask.as_bytes();
    if bytes.len() != 7 {
        return None;
    }
    let mut week = [false; 7];
    for (slot, byte) in week.iter_mut().zip(bytes) {
        *slot = match byte {
            b'1' => true,
            b'0' => false,
            _ => return None,
        };
    }
    Some(week)
}

/// The mask [`parse_week_mask`] reads. One format, one place.
pub fn week_mask(week: [bool; 7]) -> String {
    week.iter()
        .map(|worked| if *worked { '1' } else { '0' })
        .collect()
}

/// The weeks that can be named instead of spelled as a mask.
///
/// **Must stay in step with `WEEK_WORDS` in the web's `commands.ts`.** One
/// rule in two languages is the cost of the client being a separate
/// program; what keeps them from drifting into two *behaviours* is that
/// the word never goes on the wire — both sides send the mask, and the
/// API only accepts the mask.
pub const WEEK_WORDS: [(&str, [bool; 7]); 2] = [
    ("mon-fri", WORK_WEEK_MON_FRI),
    ("mon-sat", [true, true, true, true, true, true, false]),
];

/// A week from whatever a person typed: a name from [`WEEK_WORDS`] or a
/// Monday-first mask.
///
/// One entry point so a caller never has to decide which of the two forms
/// it was handed — `yaiba cal week mon-fri` and `yaiba cal week 1111100`
/// are the same command with the same validation.
pub fn parse_week_spec(spec: &str) -> Option<[bool; 7]> {
    WEEK_WORDS
        .iter()
        .find(|(word, _)| *word == spec)
        .map(|(_, week)| *week)
        .or_else(|| parse_week_mask(spec))
}

/// The shortest honest way to say a week: its name where it has one, and
/// the mask where it does not.
pub fn week_word(week: [bool; 7]) -> String {
    WEEK_WORDS
        .iter()
        .find(|(_, named)| *named == week)
        .map_or_else(|| week_mask(week), |(word, _)| (*word).to_string())
}

/// Whether `date` is a Japanese public holiday, and what it is called.
///
/// **Bounds, stated rather than implied.** The equinox approximations are
/// the standard ones and hold for **1980–2099**. The "Happy Monday" moves
/// and the substitution rules are written as the law has stood since
/// **2000**, with the one-off Imperial and Olympic dates spelled out, and
/// the older shapes of the moveable holidays kept where they cost a single
/// condition. Years before 1966 are approximate: a planner deals in work
/// that has not happened yet, and a table quietly claiming authority over
/// 1958 would be worse than one that says where it stops.
pub fn jp_holiday(date: NaiveDate) -> Option<&'static str> {
    statutory(date)
        .or_else(|| substitute(date))
        .or_else(|| citizens_holiday(date))
}

/// Every Japanese holiday in `year`, in date order.
///
/// The table as a list, for tests to read and for anything that needs a
/// range rather than a day. [`jp_holiday`] is the primitive and this is a
/// walk over it, so the two cannot disagree.
pub fn jp_holidays(year: i32) -> Vec<(NaiveDate, &'static str)> {
    let Some(first) = NaiveDate::from_ymd_opt(year, 1, 1) else {
        return Vec::new();
    };
    first
        .iter_days()
        .take_while(|date| date.year() == year)
        .filter_map(|date| jp_holiday(date).map(|name| (date, name)))
        .collect()
}

/// The 国民の祝日 proper — the named holidays the Act lists.
///
/// The two rules below it are 休日 rather than 祝日: they are consequences
/// of where *these* dates fall, which is why they are computed from this
/// function rather than listed beside it.
fn statutory(date: NaiveDate) -> Option<&'static str> {
    let (year, month, day) = (date.year(), date.month(), date.day());

    // The one-offs, which are not rules and never will be. Tokyo 2020
    // moved three holidays, and then moved them again when the games were
    // postponed a year.
    match (year, month, day) {
        (2019, 5, 1) => return Some("即位の日"),
        (2019, 10, 22) => return Some("即位礼正殿の儀"),
        (2020, 7, 23) | (2021, 7, 22) => return Some("海の日"),
        (2020, 7, 24) | (2021, 7, 23) => return Some("スポーツの日"),
        (2020, 8, 10) | (2021, 8, 8) => return Some("山の日"),
        _ => {}
    }

    match (month, day) {
        (1, 1) => return Some("元日"),
        (1, 15) if year < 2000 => return Some("成人の日"),
        (2, 11) if year >= 1967 => return Some("建国記念の日"),
        (2, 23) if year >= 2020 => return Some("天皇誕生日"),
        (4, 29) => {
            return Some(match year {
                2007.. => "昭和の日",
                1989..=2006 => "みどりの日",
                _ => "天皇誕生日",
            });
        }
        (5, 3) => return Some("憲法記念日"),
        // Before 2007 the 4th was a day off too, but as a 国民の休日
        // wedged between the 3rd and the 5th — which the sandwich rule
        // below works out on its own. Nothing to list.
        (5, 4) if year >= 2007 => return Some("みどりの日"),
        (5, 5) => return Some("こどもの日"),
        (7, 20) if (1996..=2002).contains(&year) => return Some("海の日"),
        (8, 11) if year >= 2016 && !matches!(year, 2020 | 2021) => return Some("山の日"),
        (9, 15) if (1966..=2002).contains(&year) => return Some("敬老の日"),
        (10, 10) if (1966..=1999).contains(&year) => return Some("体育の日"),
        (11, 3) => return Some("文化の日"),
        (11, 23) => return Some("勤労感謝の日"),
        (12, 23) if (1989..=2018).contains(&year) => return Some("天皇誕生日"),
        _ => {}
    }

    // The moveable ones. 体育の日 and スポーツの日 are the same holiday
    // renamed in 2020, which is why one condition answers both.
    if year >= 2000 && month == 1 && Some(day) == nth_monday(year, 1, 2) {
        return Some("成人の日");
    }
    if year >= 2003
        && month == 7
        && !matches!(year, 2020 | 2021)
        && Some(day) == nth_monday(year, 7, 3)
    {
        return Some("海の日");
    }
    if year >= 2003 && month == 9 && Some(day) == nth_monday(year, 9, 3) {
        return Some("敬老の日");
    }
    if year >= 2000
        && month == 10
        && !matches!(year, 2020 | 2021)
        && Some(day) == nth_monday(year, 10, 2)
    {
        return Some(if year >= 2020 {
            "スポーツの日"
        } else {
            "体育の日"
        });
    }

    if month == 3 && day == equinox(year, VERNAL) {
        return Some("春分の日");
    }
    if month == 9 && day == equinox(year, AUTUMNAL) {
        return Some("秋分の日");
    }
    None
}

/// 振替休日 — a holiday landing on a Sunday is observed on the next day
/// that is not a holiday of its own.
///
/// Walks *backwards*, because the question asked of a given Tuesday is "is
/// there a Sunday holiday behind me with nothing but holidays in between".
/// That is how 5/6 becomes a day off in a year where 5/3 falls on a Sunday
/// and the 4th and 5th are holidays already. Bounded by Golden Week, the
/// longest run the table can produce.
fn substitute(date: NaiveDate) -> Option<&'static str> {
    // Introduced in 1973, and a day that is already a holiday cannot also
    // be the substitute for one.
    if date.year() < 1973 || statutory(date).is_some() {
        return None;
    }
    let mut cursor = date;
    for _ in 0..7 {
        cursor = cursor.pred_opt()?;
        // Nothing but holidays may stand between: the first ordinary day
        // behind us means there is nothing to carry over.
        statutory(cursor)?;
        if cursor.weekday() == Weekday::Sun {
            return Some("振替休日");
        }
        // Until 2007 the substitute was strictly the following day, so a
        // Sunday two holidays back carried nothing to here.
        if date.year() < 2007 {
            return None;
        }
    }
    None
}

/// 国民の休日 — an ordinary day wedged between two 祝日 becomes a holiday.
///
/// This is why the 22nd is a day off in a year where 敬老の日 is the 21st
/// and 秋分の日 the 23rd. It also means 2019's 4/30 and 5/2 need no
/// listing of their own: once 即位の日 is in the table on 5/1, the two
/// dates the Imperial transition created fall out for free.
fn citizens_holiday(date: NaiveDate) -> Option<&'static str> {
    if date.year() < 1988 || statutory(date).is_some() {
        return None;
    }
    // The Act excludes a Sunday, and a day already carrying a substitute.
    if date.weekday() == Weekday::Sun || substitute(date).is_some() {
        return None;
    }
    let (prev, next) = (date.pred_opt()?, date.succ_opt()?);
    (statutory(prev).is_some() && statutory(next).is_some()).then_some("国民の休日")
}

/// Day of the month of the `nth` Monday, which is how the moveable
/// holidays are written in the Act.
fn nth_monday(year: i32, month: u32, nth: u32) -> Option<u32> {
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    // Monday is 0 from Monday, so the shift to the first one is however
    // far the 1st sits past it.
    let shift = (7 - first.weekday().num_days_from_monday()) % 7;
    Some(1 + shift + (nth - 1) * 7)
}

const VERNAL: f64 = 20.8431;
const AUTUMNAL: f64 = 23.2488;

/// Day of the month the equinox falls on.
///
/// The usual approximation, valid 1980–2099. Outside that it keeps
/// answering rather than failing and the answer drifts — see the bounds on
/// [`jp_holiday`]. Clamped into a real day of the month so an absurd year
/// cannot produce a nonsense comparison.
fn equinox(year: i32, base: f64) -> u32 {
    let elapsed = f64::from(year - 1980);
    (base + 0.242_194 * elapsed - f64::from((year - 1980) / 4))
        .floor()
        .clamp(1.0, 31.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(iso: &str) -> NaiveDate {
        iso.parse().expect("test date")
    }

    fn workdays() -> Calendar {
        Calendar {
            mode: CalendarMode::Workdays,
            ..Calendar::default()
        }
    }

    fn with_jp() -> Calendar {
        Calendar {
            mode: CalendarMode::Workdays,
            holidays: HolidaySet::Jp,
            ..Calendar::default()
        }
    }

    #[test]
    fn the_default_counts_every_calendar_day() {
        let cal = Calendar::default();
        let sat = day("2026-08-15");

        // The point of the default: an upgrade must not move a bar. Every
        // method has to answer exactly as the old arithmetic did, weekend
        // or not.
        assert_eq!(cal.snap_forward(sat), sat);
        assert_eq!(cal.snap_back(sat), sat);
        assert_eq!(cal.advance(sat, 5), day("2026-08-20"));
        assert_eq!(cal.retreat(sat, 5), day("2026-08-10"));
        assert_eq!(cal.count(sat, day("2026-08-20")), 5);
    }

    #[test]
    fn a_span_of_five_working_days_skips_the_weekend() {
        let cal = workdays();
        // Monday plus four more working days is the Friday; the fifth
        // working day is the last one, which is why the scheduler asks for
        // `duration - 1`.
        assert_eq!(cal.advance(day("2026-08-17"), 4), day("2026-08-21"));
        // One more and it is the following Monday, not the Saturday.
        assert_eq!(cal.advance(day("2026-08-17"), 5), day("2026-08-24"));
    }

    #[test]
    fn a_pin_on_a_sunday_starts_on_the_monday() {
        let cal = workdays();
        assert_eq!(cal.snap_forward(day("2026-08-16")), day("2026-08-17"));
        assert_eq!(cal.snap_back(day("2026-08-16")), day("2026-08-14"));
        // Advancing zero is the snap, which is what makes a zero lag and a
        // one-day duration land on a day somebody works.
        assert_eq!(cal.advance(day("2026-08-16"), 0), day("2026-08-17"));
    }

    #[test]
    fn advance_and_count_are_inverses() {
        let cal = with_jp();
        let from = day("2026-08-17");
        for target in ["2026-08-17", "2026-08-22", "2026-09-01", "2026-12-31"] {
            let to = day(target);
            assert_eq!(
                cal.advance(from, cal.count(from, to)),
                cal.snap_forward(to),
                "count and advance disagree about {target}"
            );
        }
    }

    #[test]
    fn the_inverse_holds_backwards_and_from_a_day_off() {
        // The direction has to reach `steps`, not be faked by swapping the
        // arguments: measured from a Saturday, a backward count snapped
        // forward to the Monday while `advance` replayed it from the
        // Friday, and the two answers were two days apart. Nothing in the
        // scheduler hands these a non-working date — every one of them is
        // already snapped — so this is the caller that does not exist yet.
        let cal = with_jp();
        let sat = day("2026-08-15");
        for target in ["2026-08-13", "2026-08-03", "2026-05-07", "2026-01-05"] {
            let to = day(target);
            let steps = cal.count(sat, to);
            assert!(steps < 0, "{target} is behind the Saturday");
            assert_eq!(
                cal.advance(sat, steps),
                cal.snap_back(to),
                "counting back from a day off disagrees about {target}"
            );
        }
    }

    #[test]
    fn a_zero_count_answers_about_where_it_started() {
        // Zero has no sign, so the contract is stated on the count rather
        // than on which date is earlier. Both of these snap *backwards*
        // onto the same Friday — the count is zero while `to` really is
        // the earlier date — and `advance(_, 0)` then snaps forward over
        // the whole of Golden Week. Read as "backwards means snap_back(to)"
        // this looks like a bug; it is the third line of the contract.
        let cal = with_jp();
        let sat = day("2026-05-02");
        let fri = day("2026-05-01");

        assert_eq!(cal.count(sat, fri), 0);
        assert_eq!(cal.advance(sat, 0), day("2026-05-07"));
        assert_eq!(cal.advance(sat, 0), cal.snap_forward(sat));
        assert_eq!(cal.snap_back(fri), fri, "the Friday is a working day");
    }

    #[test]
    fn counting_backwards_keeps_the_sign() {
        let cal = workdays();
        let (mon, fri) = (day("2026-08-17"), day("2026-08-21"));
        assert_eq!(cal.count(mon, fri), 4);
        assert_eq!(cal.count(fri, mon), -4);
    }

    #[test]
    fn a_marked_day_beats_the_week_and_the_table() {
        let mut cal = with_jp();
        // A Saturday everybody is in.
        cal.marks.insert(day("2026-08-15"), DayMark::Working);
        // And a company day off on an ordinary Tuesday.
        cal.marks
            .insert(day("2026-08-18"), DayMark::Holiday("創立記念日".into()));

        assert!(cal.is_working(day("2026-08-15")));
        assert!(!cal.is_working(day("2026-08-18")));
        assert_eq!(
            cal.holiday_name(day("2026-08-18")).as_deref(),
            Some("創立記念日")
        );
        // 元日 is in the bundled table; working through it is a mark.
        assert!(!cal.is_working(day("2026-01-01")));
        cal.marks.insert(day("2026-01-01"), DayMark::Working);
        assert!(cal.is_working(day("2026-01-01")));
    }

    #[test]
    fn marks_alone_are_a_calendar_anywhere() {
        // The general mechanism, with no bundled table at all — which is
        // how a project outside Japan gets its days off.
        let mut cal = workdays();
        for (date, name) in [
            ("2026-07-03", "Independence Day (observed)"),
            ("2026-11-26", "Thanksgiving"),
            ("2026-11-27", "Day after Thanksgiving"),
        ] {
            cal.marks
                .insert(day(date), DayMark::Holiday(name.to_string()));
        }
        assert_eq!(cal.holidays, HolidaySet::None);
        assert!(!cal.is_working(day("2026-11-26")));
        // Wednesday the 25th, then the two days off, so the next working
        // day is the Monday.
        assert_eq!(cal.advance(day("2026-11-25"), 1), day("2026-11-30"));
    }

    #[test]
    fn an_empty_work_week_degrades_to_working_every_day() {
        // Not writable through the API, which refuses it — but a peer can
        // send anything, and the alternative is a calendar on which no
        // date can ever be scheduled.
        let cal = Calendar {
            mode: CalendarMode::Workdays,
            week: [false; 7],
            ..Calendar::default()
        };
        assert!(cal.is_working(day("2026-08-16")));
        assert_eq!(cal.advance(day("2026-08-16"), 3), day("2026-08-19"));
    }

    #[test]
    fn absurd_counts_saturate_instead_of_hanging() {
        let cal = workdays();
        let from = day("2026-08-17");
        // `duration_days` has never been bounded, so this is reachable
        // from a single bad number in the data.
        assert!(
            cal.advance(from, i64::MAX) > from,
            "walked forward, stopped"
        );
        assert!(cal.retreat(from, i64::MAX) < from);
    }

    #[test]
    fn a_holiday_run_is_stepped_over() {
        let cal = with_jp();
        // 2026: 5/3 is a Sunday, so 憲法記念日 carries to the 6th, with
        // みどりの日 and こどもの日 in between. The Friday before is the
        // 1st; the next working day after it is the 7th.
        assert_eq!(cal.advance(day("2026-05-01"), 1), day("2026-05-07"));
        assert_eq!(cal.count(day("2026-05-01"), day("2026-05-07")), 1);
    }

    #[test]
    fn off_days_name_the_holidays_and_leave_the_weekends_out() {
        let mut cal = with_jp();
        cal.marks.insert(day("2026-08-15"), DayMark::Working);
        cal.marks
            .insert(day("2026-08-18"), DayMark::Holiday(String::new()));

        let off = cal.off_days(day("2026-08-01"), day("2026-08-31"));
        // 山の日 on the 11th and the unnamed mark on the 18th — and not one
        // of August's nine weekend days.
        assert_eq!(
            off,
            vec![
                (day("2026-08-11"), "山の日".to_string()),
                (day("2026-08-18"), String::new()),
            ]
        );
        assert_eq!(
            cal.working_overrides(day("2026-08-01"), day("2026-08-31")),
            vec![day("2026-08-15")],
            "the Saturday that was worked, and nothing that overrides nothing"
        );
    }

    #[test]
    fn the_japanese_table_for_2026() {
        // Every date the law produces for a year with a Sunday 憲法記念日
        // and a sandwiched 22nd of September — both derived rules and both
        // equinoxes, in one table.
        let expected = vec![
            (day("2026-01-01"), "元日"),
            (day("2026-01-12"), "成人の日"),
            (day("2026-02-11"), "建国記念の日"),
            (day("2026-02-23"), "天皇誕生日"),
            (day("2026-03-20"), "春分の日"),
            (day("2026-04-29"), "昭和の日"),
            (day("2026-05-03"), "憲法記念日"),
            (day("2026-05-04"), "みどりの日"),
            (day("2026-05-05"), "こどもの日"),
            (day("2026-05-06"), "振替休日"),
            (day("2026-07-20"), "海の日"),
            (day("2026-08-11"), "山の日"),
            (day("2026-09-21"), "敬老の日"),
            (day("2026-09-22"), "国民の休日"),
            (day("2026-09-23"), "秋分の日"),
            (day("2026-10-12"), "スポーツの日"),
            (day("2026-11-03"), "文化の日"),
            (day("2026-11-23"), "勤労感謝の日"),
        ];
        assert_eq!(jp_holidays(2026), expected);
    }

    #[test]
    fn the_imperial_transition_needed_only_one_date() {
        // 即位の日 is listed; the days either side of it are the sandwich
        // rule doing its job, which is the whole reason they are not.
        assert_eq!(jp_holiday(day("2019-04-30")), Some("国民の休日"));
        assert_eq!(jp_holiday(day("2019-05-01")), Some("即位の日"));
        assert_eq!(jp_holiday(day("2019-05-02")), Some("国民の休日"));
        assert_eq!(jp_holiday(day("2019-10-22")), Some("即位礼正殿の儀"));
        // And the old birthday, which moved in 2020.
        assert_eq!(jp_holiday(day("2018-12-23")), Some("天皇誕生日"));
        assert_eq!(jp_holiday(day("2018-02-23")), None);
    }

    #[test]
    fn the_olympic_years_moved_three_holidays() {
        assert_eq!(jp_holiday(day("2020-07-23")), Some("海の日"));
        assert_eq!(jp_holiday(day("2020-07-24")), Some("スポーツの日"));
        assert_eq!(jp_holiday(day("2020-08-10")), Some("山の日"));
        // And left their usual slots empty.
        assert_eq!(jp_holiday(day("2020-08-11")), None);
        assert_eq!(jp_holiday(day("2020-10-12")), None);
        // 2021's 山の日 fell on a Sunday, so it carried to the Monday.
        assert_eq!(jp_holiday(day("2021-08-08")), Some("山の日"));
        assert_eq!(jp_holiday(day("2021-08-09")), Some("振替休日"));
    }

    #[test]
    fn a_bundled_table_is_opt_in() {
        let cal = workdays();
        assert!(
            cal.is_working(day("2026-01-01")),
            "no table asked for, so nothing but the week mask is off"
        );
        // An unknown region is refused rather than guessed at, on the path
        // a person's typing takes. The replica's path is the derived
        // `Deserialize` — degrading there is the store's job and is tested
        // where that happens, so there is no third parser here to keep in
        // step with either.
        assert_eq!(HolidaySet::strict("us"), None);
        assert_eq!(HolidaySet::strict("jp"), Some(HolidaySet::Jp));
        assert_eq!(HolidaySet::Jp.as_str(), "jp");
        assert_eq!(
            serde_json::from_str::<HolidaySet>("\"us\"").ok(),
            None,
            "and the wire form refuses it too, which is what `enum_field` \
             turns into the default"
        );
    }

    #[test]
    fn the_week_mask_is_monday_first() {
        // Six of seven days would still look right with a Sunday-first
        // array, which is exactly why this is asserted.
        let cal = Calendar {
            mode: CalendarMode::Workdays,
            week: [true, false, false, false, false, false, false],
            ..Calendar::default()
        };
        assert!(cal.is_working(day("2026-08-17")), "Monday");
        assert!(!cal.is_working(day("2026-08-16")), "Sunday");
        assert_eq!(cal.advance(day("2026-08-17"), 1), day("2026-08-24"));
    }

    #[test]
    fn a_week_mask_round_trips_through_its_string() {
        assert_eq!(week_mask(WORK_WEEK_MON_FRI), "1111100");
        assert_eq!(parse_week_mask("1111100"), Some(WORK_WEEK_MON_FRI));
        assert_eq!(
            parse_week_mask("1111110").map(week_mask).as_deref(),
            Some("1111110")
        );
        // Anything malformed is a `None` for the caller to degrade on,
        // rather than a guess about which end the days start at.
        assert_eq!(parse_week_mask("11111"), None);
        assert_eq!(parse_week_mask("1111x00"), None);
        assert_eq!(parse_week_mask(""), None);
    }

    #[test]
    fn a_week_can_be_named_or_spelled() {
        assert_eq!(parse_week_spec("mon-fri"), Some(WORK_WEEK_MON_FRI));
        assert_eq!(
            parse_week_spec("mon-sat"),
            Some([true, true, true, true, true, true, false])
        );
        assert_eq!(parse_week_spec("1111100"), Some(WORK_WEEK_MON_FRI));
        assert_eq!(parse_week_spec("tue-sat"), None, "not a word we know");

        // Named where it has a name, spelled where it does not — which is
        // what the CLI prints back and what the app shows in `:cal`.
        assert_eq!(week_word(WORK_WEEK_MON_FRI), "mon-fri");
        assert_eq!(week_word([true; 7]), "1111111");

        // Every word round-trips, so the table cannot hold a mask its own
        // name does not describe.
        for (word, week) in WEEK_WORDS {
            assert_eq!(parse_week_spec(word), Some(week));
            assert_eq!(week_word(week), word);
        }
    }
}
