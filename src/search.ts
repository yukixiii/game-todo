import { Game, GAME_LABEL, Kind, KIND_LABEL } from "./model";
import { PlannedTask, ScheduleResult, TaskState } from "./scheduler";
import { DAY } from "./time";

/** Task states plus "late" (active but not expected to finish in time). */
export type StateFilter = TaskState | "late";
export type DueFilter = "any" | "overdue" | "today" | "3d" | "7d" | "30d" | "none";
export type SortKey = "rank" | "title" | "game" | "kind" | "state" | "deadline" | "minutes" | "totalMinutes" | "plannedEnd" | "slack";

export interface TaskQuery {
	/** Space separated words, all must match; "-word" excludes. */
	text: string;
	/** Empty = no condition. */
	games: Game[];
	kinds: Kind[];
	states: StateFilter[];
	due: DueFilter;
	sort: SortKey;
	desc: boolean;
}

export const STATE_FILTERS: StateFilter[] = ["active", "late", "inbox", "expired", "unreachable", "cycle", "done"];
export const STATE_LABEL: Record<StateFilter, string> = {
	active: "予定中",
	late: "遅延見込み",
	inbox: "Inbox",
	expired: "期限切れ",
	unreachable: "実行不能",
	cycle: "循環",
	done: "完了",
};
export const DUE_LABEL: Record<DueFilter, string> = {
	any: "期限: すべて",
	overdue: "期限切れ",
	today: "今日中",
	"3d": "3日以内",
	"7d": "7日以内",
	"30d": "30日以内",
	none: "期限なし",
};

export const DEFAULT_QUERY: TaskQuery = {
	text: "",
	games: [],
	kinds: [],
	states: STATE_FILTERS.filter((s) => s !== "done"),
	due: "any",
	sort: "rank",
	desc: false,
};

/** Copies a (possibly persisted, partial) query onto the defaults. */
export function normalizeQuery(q: Partial<TaskQuery> | undefined): TaskQuery {
	return {
		...DEFAULT_QUERY,
		...q,
		games: [...(q?.games ?? DEFAULT_QUERY.games)],
		kinds: [...(q?.kinds ?? DEFAULT_QUERY.kinds)],
		states: [...(q?.states ?? DEFAULT_QUERY.states)],
	};
}

/** The task's own minutes (remaining overrides estimate); undefined when not estimated. */
export function ownMinutes(pt: PlannedTask): number | undefined {
	return pt.task.remaining ?? pt.task.estimate;
}

/** Minutes including unfinished prerequisites; only computed for active tasks. */
export function totalMinutes(pt: PlannedTask): number | undefined {
	return pt.state === "active" ? pt.totalMinutes : undefined;
}

function haystack(pt: PlannedTask): string {
	const t = pt.task;
	return [t.title, t.path, GAME_LABEL[t.game], KIND_LABEL[t.kind], ...t.unlock, ...pt.reasons, t.source ?? ""].join("\n");
}

/** Folds width and case, and the U+00B7 middle dot of game data to ・. */
export function normalizeSearch(s: string): string {
	return s.normalize("NFKC").toLowerCase().replace(/·/g, "・");
}

/** Space separated words, all must be contained in `hay`; "-word" excludes. */
export function matchesWords(hay: string, text: string): boolean {
	const words = normalizeSearch(text).split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const h = normalizeSearch(hay);
	return words.every((w) => (w.startsWith("-") && w.length > 1 ? !h.includes(w.slice(1)) : h.includes(w)));
}

function matchesText(pt: PlannedTask, text: string): boolean {
	return matchesWords(haystack(pt), text);
}

function endOfDay(now: number): number {
	const d = new Date(now);
	d.setHours(23, 59, 59, 999);
	return d.getTime();
}

function matchesDue(deadline: number | undefined, due: DueFilter, now: number): boolean {
	if (due === "any") return true;
	if (due === "none") return deadline == null;
	if (deadline == null) return false;
	if (due === "overdue") return deadline < now;
	if (deadline < now) return false;
	const limit = due === "today" ? endOfDay(now) : now + { "3d": 3, "7d": 7, "30d": 30 }[due] * DAY;
	return deadline <= limit;
}

export function matchesQuery(pt: PlannedTask, q: TaskQuery, now: number): boolean {
	const t = pt.task;
	if (q.games.length && !q.games.includes(t.game)) return false;
	if (q.kinds.length && !q.kinds.includes(t.kind)) return false;
	if (q.states.length && !q.states.includes(pt.state) && !(pt.late && q.states.includes("late"))) return false;
	if (!matchesDue(t.deadline, q.due, now)) return false;
	return matchesText(pt, q.text);
}

const STATE_ORDER: TaskState[] = ["active", "inbox", "cycle", "unreachable", "expired", "done"];

function sortValue(pt: PlannedTask, key: SortKey): number | string | undefined {
	const t = pt.task;
	switch (key) {
		case "rank":
			return pt.rank;
		case "title":
			return t.title;
		case "game":
			return t.game;
		case "kind":
			return t.kind;
		case "state":
			return STATE_ORDER.indexOf(pt.state);
		case "deadline":
			return t.deadline;
		case "minutes":
			return ownMinutes(pt);
		case "totalMinutes":
			return totalMinutes(pt);
		case "plannedEnd":
			return pt.plannedEnd;
		case "slack":
			return pt.slack;
	}
}

/** Missing values always sort last; ties fall back to deadline, then title. */
export function compareTasks(a: PlannedTask, b: PlannedTask, key: SortKey, desc: boolean): number {
	const va = sortValue(a, key);
	const vb = sortValue(b, key);
	if (va == null || vb == null) {
		if (va != null) return -1;
		if (vb != null) return 1;
	} else if (va !== vb) {
		const c = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
		return desc ? -c : c;
	}
	return (
		(a.task.deadline ?? Infinity) - (b.task.deadline ?? Infinity) ||
		a.task.title.localeCompare(b.task.title) ||
		a.task.path.localeCompare(b.task.path)
	);
}

export function queryTasks(r: ScheduleResult, q: TaskQuery, now: number): PlannedTask[] {
	return [...r.byPath.values()]
		.filter((pt) => matchesQuery(pt, q, now))
		.sort((a, b) => compareTasks(a, b, q.sort, q.desc));
}
