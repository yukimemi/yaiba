/**
 * What the UI says, in the language it was asked for.
 *
 * The English string **is** the key. There is no `help.move.down`
 * indirection, and that is the point: the code goes on reading as the
 * sentence it prints, a missing translation falls back to English
 * rather than to a dotted path nobody can read, and a phrase that is
 * reworded in English simply loses its Japanese until it is rewritten
 * too — which is the honest outcome, since the two would otherwise
 * quietly disagree.
 *
 * The current language lives here rather than being threaded through
 * every call, because it is a property of the document, the way the
 * theme is: one setting, changed in one place, read everywhere. React
 * re-renders on it because `App` holds it in state as well and nothing
 * here is memoised — `applyLang` writes both, and is the only thing
 * that writes either.
 *
 * Placeholders are `{name}`, filled from the `vars` object. They exist
 * because the two languages put the parts in different orders:
 * `moved under “x”` against `“x” の下に移動しました`.
 */

import type { Lang } from "./lang";

let current: Lang = "en";

/** Called by `applyLang`, which is the only place the language is set. */
export function setLang(lang: Lang): void {
  current = lang;
}

export function t(en: string, vars?: Record<string, string | number>): string {
  const line = current === "ja" ? (JA[en] ?? en) : en;
  if (!vars) return line;
  return line.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * Japanese, keyed by the English.
 *
 * Deliberately plain: this is a HUD, and a status line has one line to
 * say what happened in. Where English uses a dash to tack on the way
 * out ("— :all to come back"), Japanese uses `·` and the bare command,
 * because a Japanese clause of the same length would push the message
 * off the end of the bar.
 *
 * Key names — `todo` / `doing` / `done`, `crit`, tags, command names —
 * stay as they are. They are what you type.
 */
const JA: Record<string, string> = {
  // ---- the top bar -----------------------------------------------
  //
  // Every label here shares one line with the project name, the meter
  // and the reference date, so each is as short as it can be and still
  // mean something. `CP` for the critical path is the term Japanese
  // scheduling actually uses; 臨界 would be a different word entirely.
  crit: "CP",
  // Not 完了: that is the count of finished tasks two readouts to the
  // right, and the same word for both is what a status meeting misreads.
  ends: "完了予定",
  only: "限定",
  level: "階層",
  filter: "絞込",
  overdue: "遅延",
  now: "現在",
  "◐ neon": "◐ ネオン",
  "◑ office": "◑ オフィス",
  "◌ local": "◌ ローカル",
  "◉ solo": "◉ 単独",
  "◉ 1 peer": "◉ ピア 1",
  "◉ {n} peers": "◉ ピア {n}",
  "a day earlier (:asof -1d)": "1日前 (:asof -1d)",
  "a day later (:asof +1d)": "1日後 (:asof +1d)",
  "computed as of {d} — edits stay refused until you are back at now":
    "{d} 時点で計算しています — 現在に戻るまで編集はできません",
  "reference date — everything on screen is computed against it (:asof)":
    "基準日 — 画面上のすべてはこの日を基準に計算されます (:asof)",
  "office mode — light, no glow (gt)":
    "オフィスモード — 明るく、発光なし (gt)",
  "neon mode (gt)": "ネオンモード (gt)",
  "node {id} · :ticket to share, :join <ticket> to connect":
    "ノード {id} · 共有は :ticket、接続は :join <ticket>",
  "started with --no-sync": "--no-sync で起動しています",
  "{n} projects open — switch, rename, forget (or :proj)":
    "{n} 件を開いています — 切替・改名・一覧から外す (:proj でも)",
  "projects — new, rename, forget (or :proj)":
    "プロジェクト — 新規・改名・一覧から外す (:proj でも)",

  // ---- the list --------------------------------------------------
  //
  // `st` and `p` head columns three characters wide; 状 and 優 are the
  // one-character forms that fit where 状態 and 優先度 would not.
  "1 task": "1 タスク",
  "{n} tasks": "{n} タスク",
  "{n} done": "{n} 完了",
  "{k} order": "{k} 順",
  st: "状",
  task: "タスク",
  due: "期限",
  p: "優",
  "complete / reopen": "完了 / 再開",
  "projected to finish {n}d past its due date": "期日より {n} 日遅れで終わる見込み",
  "to open a new task": "で新しいタスク",
  "for keys": "でキー一覧",
  // 担当 rather than 担当者: the row shows the name already, so the
  // tooltip only has to say what the `@` means. The column heading is
  // the same two characters — 担当者 would not fit the 8ch cell it sits
  // over, and the header row is where a label has least room to spare.
  "assigned to {who}": "担当: {who}",
  owner: "担当",
  "who owns it": "このタスクの担当者",
  // The cell is a button now, so the tooltip no longer has to name the
  // command that was the only way in — clicking it *is* the way in.
  "nobody has taken it yet": "担当が決まっていません",
  "new task below, at this level — o": "同じ階層に下へ追加 — o",
  "no tasks yet.": "まだタスクがありません。",
  "nothing matches this filter.": "この絞り込みに一致するものがありません。",

  // ---- the date columns and the calendar over them ---------------
  // Plan and record read as a pair here, so the actuals take the plan's
  // words with 実 in front rather than two unrelated ones: 着手 / 実了
  // was shorter and made the two columns look like different measures.
  start: "開始",
  end: "終了",
  began: "実開始",
  ended: "実終了",
  "planned start — dim means the scheduler placed it":
    "計画の開始 — 淡い表示はスケジューラが置いた日",
  "planned finish — picking a date sets the duration":
    "計画の終了 — 日付を選ぶと期間が決まります",
  "when work actually began": "実際に着手した日",
  "when work actually finished": "実際に完了した日",
  "a summary's dates come from its children":
    "サマリの日付は子タスクから決まります",
  "previous month — [": "前の月 — [",
  "next month — ]": "次の月 — ]",
  today: "今日",
  clear: "消去",

  // ---- the owner panel -------------------------------------------
  // 1語 rather than 空白なし: the rule is what a name *is*, not what it
  // may not contain, and the affirmative form is shorter on a line that
  // also has to carry two key hints.
  "filter, or a name that is new": "絞り込み、または新しい名前",
  "add @{name}": "@{name} を追加",
  "one word · ⏎ commit · ⌫ clear · esc close":
    "1語 · ⏎ 確定 · ⌫ 担当を外す · esc 閉じる",

  // ---- the status line, per mode ---------------------------------
  "j/k move · o new · x done · D link · ? help":
    "j/k 移動 · o 追加 · x 完了 · D 依存 · ? ヘルプ",
  "⏎ commit · esc cancel": "⏎ 確定 · esc 取消",
  "j/k extend · x done · d delete · esc cancel":
    "j/k 拡張 · x 完了 · d 削除 · esc 取消",
  "⏎ run · esc cancel": "⏎ 実行 · esc 取消",
  "⏎ jump · esc cancel": "⏎ 移動 · esc 取消",
  "pick the task this one waits for · ⏎ confirm · esc cancel":
    "待つ相手を選ぶ · ⏎ 確定 · esc 取消",
  "pick the dependency to cut · ⏎ confirm · esc cancel":
    "切る依存を選ぶ · ⏎ 確定 · esc 取消",

  // ---- what the status line says back ----------------------------
  "no task under the cursor": "カーソル行にタスクがありません",
  "saved on every edit — nothing to flush":
    "編集のたびに保存しています — 書き出すものはありません",
  "close the tab to quit — the server keeps running":
    "終了するにはタブを閉じてください — サーバーは動き続けます",
  "reloaded": "再読み込みしました",
  "viewing the past — :asof today to make changes":
    "過去を表示しています — 編集するには :asof today",
  "reference date: today": "基準日: 今日",
  "as of {d}": "{d} 時点",
  "office mode": "オフィスモード",
  "neon mode": "ネオンモード",
  "dates — click a cell to pick one": "日付列 — セルをクリックで選べます",
  "split at {n}%": "分割 {n}%",
  "compact columns": "コンパクト表示",
  "filter: {q}": "絞込: {q}",
  "filter cleared": "絞込を解除しました",
  "sorted by {k}": "{k} 順に並べ替えました",
  "showing everything": "すべて表示しています",
  "all levels": "すべての階層",
  "level {n}": "階層 {n}",
  "focused “{title}” — :all to come back":
    "「{title}」に絞りました — :all で戻ります",
  "focused “{title}” — zF to come back":
    "「{title}」に絞りました — zF で戻ります",
  "moved to the top level": "最上位へ移動しました",
  "moved under “{title}”": "「{title}」の下へ移動しました",
  "depends on “{title}”": "「{title}」を待ちます",
  // 待ちます + 間隔。+0 は「同日に着手できる」なので 日後 ではなく
  // そのまま記号で出す — 数字が0のときに「0日後」は日本語として妙。
  "depends on “{title}” · +{n}d": "「{title}」を待ちます · +{n}日",
  "unlinked from “{title}”": "「{title}」との依存を切りました",
  "already linked": "すでに依存があります",
  "no dependency between those two": "その2つに依存関係はありません",
  "no such dependency": "その依存はありません",
  "a task can't depend on itself": "自分自身には依存できません",
  "a task can't block itself": "自分自身を待つことはできません",
  "a task can't contain itself": "自分自身を含むことはできません",
  "a row cannot be dropped inside itself": "行を自分自身の中へは落とせません",
  "nothing above to nest under": "上に入れ子にできる行がありません",
  "already at the top level": "すでに最上位です",
  "already the first row": "すでに先頭の行です",
  "already the last row": "すでに末尾の行です",
  "this row is the focus — zF to come back, then move it":
    "この行がフォーカス元です — zF で戻ってから動かしてください",
  "rows only move in manual order — :sort manual":
    "行を動かせるのは manual 順のときだけです — :sort manual",
  "clear the filter before moving rows — :f":
    "行を動かす前に絞込を解除してください — :f",
  "nothing yanked": "ヤンクしたものがありません",
  "yanked {n}": "{n} 件ヤンクしました",
  "pasted {n}": "{n} 件貼り付けました",
  "already at the oldest change": "これ以上は戻れません",
  "already at the newest change": "これ以上はやり直せません",
  "undo: {label}": "元に戻す: {label}",
  "redo: {label}": "やり直す: {label}",
  "pattern not found: {q}": "見つかりません: {q}",
  "pick what this task waits for — ⏎ to confirm":
    "待つ相手を選んでください — ⏎ で確定",
  "pick the dependency to cut — ⏎ to confirm":
    "切る依存を選んでください — ⏎ で確定",
  "deleted {n}": "{n} 件削除しました",
  "project · {name}": "プロジェクト · {name}",
  "renamed {from} → {to}": "{from} → {to} に改名しました",
  "sync is off — started with --no-sync":
    "同期は無効です — --no-sync で起動しています",
  "ticket copied · {ticket}": "チケットをコピーしました · {ticket}",
  "joined · {n} peer(s)": "接続しました · ピア {n}",

  // ---- undo labels, which the two lines above quote ---------------
  "new task": "新規タスク",
  "delete {n}": "{n} 件削除",
  link: "依存",
  unlink: "依存解除",
  notes: "メモ",
  unassigned: "担当なし",
  unparent: "階層を外す",
  reparent: "階層を変更",

  // ---- refusals from the command line ----------------------------
  "usage: :view {list}": "使い方: :view {list}",
  "usage: :zoom {list}": "使い方: :zoom {list}",
  "usage: :cols {list}  (bare :cols toggles)":
    "使い方: :cols {list}（引数なしで切替）",
  "usage: :split [percent]": "使い方: :split [パーセント]",
  "usage: :sort {list}": "使い方: :sort {list}",
  "usage: :new <title>": "使い方: :new <タイトル>",
  "usage: :dur <days ≥ 1>": "使い方: :dur <1以上の日数>",
  "usage: :prio 0|1|2|3": "使い方: :prio 0|1|2|3",
  "usage: :progress 0..100": "使い方: :progress 0..100",
  "usage: :tag +dev -ui": "使い方: :tag +dev -ui",
  "usage: :dep ⟨row⟩ [+days]": "使い方: :dep ⟨行番号⟩ [+日数]",
  "a lag of more than {n} days is not a plan": "{n} 日を超える間隔は計画とは呼べません",
  // 重ねられない rather than 負の値は不可: the rule is about what an edge
  // can mean, not about which numbers are typeable.
  "a dependency cannot overlap — the earliest is +0":
    "依存は重ねられません — 最短は +0（同日）",
  "usage: :assign ⟨name⟩  (bare clears)":
    "使い方: :assign ⟨名前⟩（引数なしで担当を外す）",
  // The suggestion carries the fix, so the sentence only has to say
  // what the rule is — 空白は使えません would say it twice.
  "one word per name — try {joined}": "名前は1語です — {joined} はどうですか",
  "usage: :theme dark|light  (bare :theme toggles)":
    "使い方: :theme dark|light（引数なしで切替）",
  "usage: :lang en|ja  (bare :lang toggles)":
    "使い方: :lang en|ja（引数なしで切替）",
  "usage: :level <0 or more>  (:level with no argument shows all)":
    "使い方: :level <0以上>（引数なしですべて表示）",
  "usage: :join <ticket>": "使い方: :join <チケット>",
  "usage: :proj {verb} ⟨name⟩": "使い方: :proj {verb} ⟨名前⟩",
  "not a command: {name}  (try :help)":
    "コマンドではありません: {name}（:help を参照）",
  "bad date: {d}": "日付として読めません: {d}",
  "no row {n} (1..{max})": "{n} 行目はありません（1..{max}）",
  "no end date is stored — set the span with :dur, or move it with :start none":
    "終了日は保存されていません — 期間は :dur、移動は :start none で",
  "“{title}” is a summary — its {field} comes from its children":
    "「{title}」はサマリです — {field} は子タスクから決まります",
  // The four fields that sentence names. Translated at the call site
  // rather than inside the refusal, so the scan that keeps this file
  // honest can see them.
  "start date": "開始日",
  dates: "日付",
  span: "期間",
  progress: "進捗",
  "usage: :proj rename ⟨new name⟩ — renames the project you are on":
    "使い方: :proj rename ⟨新しい名前⟩ — いま開いているプロジェクトを改名します",
  "“{title}” has no start to measure from":
    "「{title}」には基準となる開始日がありません",
  "{d} is before the start ({start})": "{d} は開始日 ({start}) より前です",
  "{d} is after work finished ({end})": "{d} は完了日 ({end}) より後です",
  "{d} is before work started ({start})": "{d} は着手日 ({start}) より前です",

  // ---- the project palette ---------------------------------------
  projects: "プロジェクト",
  "new name for {old}": "{old} の新しい名前",
  "type to filter, or a name that does not exist yet":
    "入力で絞り込み、存在しない名前ならそのまま作成",
  "? it leaves the list — the database stays on disk":
    " を一覧から外しますか？ データベースはディスクに残ります",
  current: "現在",
  "no sync": "同期なし",
  "1 peer": "ピア 1",
  "{n} peers": "ピア {n}",
  rename: "改名",
  forget: "一覧から外す",
  "new project": "新規プロジェクト",
  "no project matches": "一致するプロジェクトがありません",
  "enter rename · esc back — the database keeps the name it was made with":
    "enter 改名 · esc 戻る — データベース名は作成時のままです",
  "enter forget · esc back": "enter 実行 · esc 戻る",
  "enter creates it · esc cancel": "enter で作成 · esc 取消",
  "^n / ^p move · enter switch · ^r rename · ^d forget · esc cancel":
    "^n / ^p 移動 · enter 切替 · ^r 改名 · ^d 一覧から外す · esc 取消",

  // ---- the help panel --------------------------------------------
  "YAIBA 刃 — KEYS": "YAIBA 刃 — キー一覧",
  MOVE: "移動",
  EDIT: "編集",
  PLAN: "計画",
  MOUSE: "マウス",
  BREAKDOWN: "階層",
  "DATE PICKER": "日付ピッカー",
  PEERS: "ピア",
  PROJECTS: "プロジェクト",
  OWNER: "担当",
  // The colon is kept: these four groups are what you type on the `:`
  // line, and the heading says so before the first row does.
  ": COMMANDS": ": コマンド",
  ": ACTUALS": ": 実績",
  ": AS OF": ": 基準日",
  ": BREAKDOWN": ": 階層",
  "down / up": "下 / 上",
  "first / last": "先頭 / 末尾",
  "half page": "半ページ",
  "top / middle / bottom": "画面の上 / 中 / 下",
  "search, next, previous": "検索・次・前",
  "cycle split → list → gantt": "split → list → gantt を巡回",
  "new task below / above, at this level": "同じ階層に行を追加（下 / 上）",
  "edit the title (head)": "タイトルを編集（先頭へ）",
  "edit the title (tail)": "タイトルを編集（末尾へ）",
  "clear the title and edit": "タイトルを消して編集",
  "toggle done": "完了 / 未完了",
  delete: "削除",
  "yank / paste a copy": "ヤンク / 複製を貼り付け",
  "move the row down / up, level and all": "行を下 / 上へ（階層ごと）",
  "undo / redo": "元に戻す / やり直す",
  "duration ±1 day": "期間 ±1日",
  "priority up / down": "優先度を上げる / 下げる",
  "progress ∓10%": "進捗 ∓10%",
  "add a dependency": "依存を張る",
  "remove a dependency": "依存を切る",
  "gantt zoom out / in": "ガントを縮小 / 拡大",
  "visual line select": "行単位で選択",
  "date columns ⇄ compact": "日付列 ⇄ コンパクト",
  "office mode ⇄ neon mode": "オフィス ⇄ ネオン",
  "put the cursor on a row": "その行にカーソルを置く",
  "new task below, at this level": "同じ階層に下へ追加",
  // 担当欄 rather than just 担当: this row names the *thing you click*,
  // and the panel's own heading two rows down is the plain 担当.
  "pick who it belongs to — in :dates": "担当欄をクリックで選ぶ — :dates 時",
  "open the owner panel": "担当パネルを開く",
  "the same panel, from the column": "同じパネルを列から開く",
  "filter, or write a name that is new": "絞り込み、または新しい名前を入力",
  "walk the names in use": "使われている名前を移動",
  "set it without the panel — bare clears":
    "パネルを使わず指定 — 引数なしで外す",
  "fold a summary": "サマリを畳む",
  // 境界 rather than 仕切り: it is the line between the two panes, and
  // that is the word the README uses for it too.
  "drag the divider": "境界をドラッグ",
  "resize the split · dbl-click resets":
    "分割幅を変える · ダブルクリックで既定",
  // フォーカス, not 選択: the grip takes focus like a control, and the
  // keys only reach it once it has.
  "divider, focused": "境界にフォーカス中",
  "← → or h l move it 2% · Home resets":
    "← → または h l で 2% ずつ · Home で既定",
  "the list's percent of the width": "一覧の幅の割合（%）",
  "drag to resize · double-click to reset":
    "ドラッグで幅を変更 · ダブルクリックで既定に戻す",
  "edit the title": "タイトルを編集",
  reorder: "並べ替え",
  "move the start date": "開始日を動かす",
  "change the duration": "期間を変える",
  "make that task wait for this one": "そのタスクをこれの後ろに回す",
  "cut that dependency": "その依存を切る",
  "reference date, a day at a time": "基準日を1日ずつ",
  "jump to one — or back to now": "日付へ跳ぶ — 現在にも戻れます",
  "nest under the row above / move out": "上の行の下へ入れる / 外へ出す",
  "fold one level shallower / deeper": "1階層 浅く / 深く畳む",
  // 出て rather than 戻って: the cursor moves to the parent, which is a
  // direction in the tree, not a step back through history.
  "open this fold / close it, or step out and close":
    "この行を開く / 閉じる（葉なら親へ出て閉じる）",
  "fold / unfold — arrows too": "畳む / 開く — 矢印キーも同じ",
  "fold to projects only / unfold all": "プロジェクトだけに / すべて展開",
  "toggle this row · zo open · zc close": "この行を開閉 · zo 開く · zc 閉じる",
  "focus this subtree / show everything": "この部分木に絞る / すべて表示",
  "add a task": "タスクを追加",
  "pin a start date": "開始日を固定する",
  "land it on a date — sets the duration":
    "その日に着地させる — 期間が決まります",
  "duration in days": "期間（日数）",
  "0 none … 3 high": "0 なし … 3 高",
  "progress percent": "進捗（%）",
  "add / remove tags": "タグを追加 / 削除",
  "hand it to somebody — bare clears": "担当を決める（引数なしで外す）",
  "wait for row n": "n 行目を待つ",
  // 同日 carries it: the point is that the two share a calendar
  // square, not that the number is zero.
  "…and may start the same day": "…同日に着手可（既定は翌日）",
  "when work really began": "実際に着手した日",
  "when it really finished — none clears": "実際に終えた日 — none で消去",
  "plan vs actual, and an owner column — gd toggles":
    "計画と実績、担当の列 — gd で切替",
  "calendar on the planned start / end": "計画の開始 / 終了にカレンダー",
  "calendar on the actual start / end": "実績の着手 / 完了にカレンダー",
  "open the calendar over it": "そのセルの上にカレンダーを開く",
  "walk the grid": "グリッドを移動",
  "previous / next month": "前の月 / 次の月",
  "jump to the reference date": "基準日へ跳ぶ",
  "clear it — not the planned end": "消去する — 計画の終了日は不可",
  "commit / close": "確定 / 閉じる",
  "copy this replica's invite": "この複製の招待をコピー",
  "merge this project with that peer":
    "このプロジェクトを相手のものと統合する",
  "pick one — click the name in the bar too":
    "選ぶ — 上部バーの名前をクリックしても開きます",
  "switch straight to it": "そのまま切り替える",
  "start one of your own": "自分のものを新しく作る",
  "rename the current one": "いま開いているものを改名",
  "drop it from the list; database stays":
    "一覧から外す（データベースは残ります）",
  "in the picker: rename / forget": "ピッカー内で 改名 / 一覧から外す",
  "see the plan as it stood then": "その時点の計画を見る",
  "back to now": "現在に戻る",
  "show down to level n (bare = all)":
    "階層 n まで表示（引数なしですべて）",
  "move under row n (bare = top level)":
    "n 行目の下へ移す（引数なしで最上位）",
  "focus this subtree / clear": "この部分木に絞る / 解除",
  "dark / light — bare toggles": "dark / light（引数なしで切替）",
  "straight to office mode": "そのままオフィスモードへ",
  "en / ja — bare toggles": "en / ja（引数なしで切替）",
  "Edits save as they happen. Dates accept today / tom / mon / +3d / 8-14. On the : line, tab completes and s-tab walks back. Press ? or esc to close.":
    "編集はその場で保存されます。日付は today / tom / mon / +3d / 8-14 のように書けます。: の行では tab が補完し、s-tab が戻ります。? か esc で閉じます。",
};
