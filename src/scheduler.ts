import { minutesLeft, Task } from "./model";
import { HOUR, MINUTE } from "./time";

export type TaskState = "done" | "expired" | "unreachable" | "cycle" | "inbox" | "active";

export interface Capacity {
	/** Minutes available on Mon–Fri. */
	weekday: number;
	/** Minutes available on Sat/Sun. */
	weekend: number;
	/** Optional per-weekday override, index 0 = Sunday. */
	perDay?: (number | null | undefined)[];
	/** Local hour (may be fractional) when the daily play window starts. */
	playStartHour: number;
}

export interface Allocation {
	path: string;
	start: number;
	end: number;
	minutes: number;
}

export interface PlannedTask {
	task: Task;
	state: TaskState;
	/** Human-readable reason for non-active states and warnings. */
	reasons: string[];
	/** Deadline after back-propagation from dependents. */
	effDeadline?: number;
	/** Own remaining minutes plus all unfinished prerequisites (each counted once). */
	totalMinutes: number;
	plannedStart?: number;
	plannedEnd?: number;
	/** effDeadline − plannedEnd (ms); undefined if no deadline or not scheduled. */
	slack?: number;
	late: boolean;
	/** 1-based priority among active tasks. */
	rank?: number;
}

export interface ScheduleResult {
	byPath: Map<string, PlannedTask>;
	/** Active tasks in priority order. */
	ordered: PlannedTask[];
	allocations: Allocation[];
	/** The first play window that ends after `now` (the "today" window). */
	firstWindow?: { start: number; end: number };
}

export interface ScheduleOptions {
	horizonDays?: number;
}

export function capacityFor(cap: Capacity, dayOfWeek: number): number {
	const override = cap.perDay?.[dayOfWeek];
	if (override != null) return Math.max(0, override);
	return dayOfWeek === 0 || dayOfWeek === 6 ? cap.weekend : cap.weekday;
}

/** Play windows (local time) from yesterday onward that end after `now`, clipped to start at `now`. */
export function playWindows(now: number, cap: Capacity, days: number): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = [];
	const base = new Date(now);
	base.setHours(0, 0, 0, 0);
	for (let i = -1; i < days; i++) {
		const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
		const minutes = capacityFor(cap, d.getDay());
		if (minutes <= 0) continue;
		const start = d.getTime() + cap.playStartHour * HOUR;
		const end = start + minutes * MINUTE;
		if (end <= now) continue;
		out.push({ start: Math.max(start, now), end });
	}
	return out;
}

/** Tarjan SCC; returns the set of paths that are part of a dependency cycle. */
function findCycles(tasks: Map<string, Task>): Set<string> {
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const inCycle = new Set<string>();
	let counter = 0;

	const visit = (v: string) => {
		index.set(v, counter);
		low.set(v, counter);
		counter++;
		stack.push(v);
		onStack.add(v);
		for (const w of tasks.get(v)!.prereqs) {
			if (!tasks.has(w)) continue;
			if (!index.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v)!, low.get(w)!));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v)!, index.get(w)!));
			}
		}
		if (low.get(v) === index.get(v)) {
			const comp: string[] = [];
			let w: string;
			do {
				w = stack.pop()!;
				onStack.delete(w);
				comp.push(w);
			} while (w !== v);
			if (comp.length > 1) comp.forEach((c) => inCycle.add(c));
		}
	};
	for (const v of tasks.keys()) if (!index.has(v)) visit(v);
	return inCycle;
}

export function schedule(
	taskList: Task[],
	now: number,
	cap: Capacity,
	opts: ScheduleOptions = {},
): ScheduleResult {
	const horizonDays = opts.horizonDays ?? 180;
	const tasks = new Map(taskList.map((t) => [t.path, t]));
	const byPath = new Map<string, PlannedTask>();
	const name = (p: string) => tasks.get(p)?.title ?? p;

	for (const t of taskList) {
		byPath.set(t.path, { task: t, state: "active", reasons: [], totalMinutes: 0, late: false });
	}

	// Done tasks never block anything; the rest of the graph only considers unfinished ones.
	const open = new Map([...tasks].filter(([, t]) => t.status !== "done"));
	for (const t of tasks.values()) if (t.status === "done") byPath.get(t.path)!.state = "done";

	const unfinishedPrereqs = (t: Task) => t.prereqs.filter((p) => open.has(p));

	const cycles = findCycles(open);
	for (const p of cycles) {
		const pt = byPath.get(p)!;
		pt.state = "cycle";
		pt.reasons.push("前提任務が循環しています");
	}
	for (const t of open.values()) {
		const pt = byPath.get(t.path)!;
		if (pt.state !== "active") continue;
		if (t.deadline != null && t.deadline < now) {
			pt.state = "expired";
			pt.reasons.push("期限切れ");
		} else if (t.estimate == null && t.remaining == null) {
			pt.state = "inbox";
			pt.reasons.push("所要時間が未設定");
		}
		for (const m of t.missingPrereqs) pt.reasons.push(`前提「${m}」が見つかりません`);
	}

	// Topological order of open, non-cycle tasks (prerequisites first).
	const topo: string[] = [];
	const seen = new Set<string>();
	const visit = (p: string) => {
		if (seen.has(p) || cycles.has(p)) return;
		seen.add(p);
		for (const q of unfinishedPrereqs(open.get(p)!)) visit(q);
		topo.push(p);
	};
	for (const p of open.keys()) visit(p);

	// Unreachable: any unfinished prerequisite can no longer be completed.
	for (const p of topo) {
		const pt = byPath.get(p)!;
		if (pt.state !== "active" && pt.state !== "inbox") continue;
		const dead = unfinishedPrereqs(pt.task).filter((q) => {
			const s = byPath.get(q)!.state;
			return s === "expired" || s === "unreachable" || s === "cycle";
		});
		if (dead.length) {
			pt.state = "unreachable";
			pt.reasons.unshift(`前提任務が実行不能: ${dead.map(name).join(", ")}`);
		}
	}

	const schedulable = (p: string) => byPath.get(p)?.state === "active";
	// Inbox prerequisites have unknown duration; dependents wait for them (counted as 0 min).
	for (const p of topo) {
		const pt = byPath.get(p)!;
		if (pt.state !== "active") continue;
		const inbox = unfinishedPrereqs(pt.task).filter((q) => byPath.get(q)!.state === "inbox");
		if (inbox.length) pt.reasons.push(`前提の所要時間が未設定: ${inbox.map(name).join(", ")}`);
	}

	// Total minutes including every unfinished ancestor once.
	for (const p of topo) {
		const pt = byPath.get(p)!;
		if (pt.state !== "active") continue;
		const acc = new Set<string>();
		const walk = (q: string) => {
			if (acc.has(q)) return;
			acc.add(q);
			for (const r of unfinishedPrereqs(open.get(q)!)) if (!cycles.has(r)) walk(r);
		};
		walk(p);
		pt.totalMinutes = [...acc].reduce((s, q) => s + minutesLeft(open.get(q)!), 0);
	}

	// Back-propagate deadlines: a prerequisite must finish before its dependent can start.
	const dependents = new Map<string, string[]>();
	for (const p of topo) {
		if (!schedulable(p)) continue;
		for (const q of unfinishedPrereqs(open.get(p)!)) {
			if (!schedulable(q)) continue;
			(dependents.get(q) ?? dependents.set(q, []).get(q)!).push(p);
		}
	}
	const eff = new Map<string, number>();
	for (let i = topo.length - 1; i >= 0; i--) {
		const p = topo[i];
		if (!schedulable(p)) continue;
		let d = open.get(p)!.deadline ?? Infinity;
		for (const c of dependents.get(p) ?? []) {
			d = Math.min(d, eff.get(c)! - minutesLeft(open.get(c)!) * MINUTE);
		}
		eff.set(p, d);
		if (d !== Infinity) byPath.get(p)!.effDeadline = d;
	}

	// Forward simulation over play windows, earliest effective deadline first, preemptive.
	const windows = playWindows(now, cap, horizonDays);
	const remaining = new Map<string, number>();
	const finished = new Set<string>();
	const pending = new Set<string>();
	for (const p of topo) {
		if (!schedulable(p)) continue;
		remaining.set(p, minutesLeft(open.get(p)!));
		pending.add(p);
	}
	const isReady = (p: string) =>
		unfinishedPrereqs(open.get(p)!).every((q) => finished.has(q) || byPath.get(q)!.state === "inbox");
	const startOf = (p: string) => open.get(p)!.start ?? -Infinity;
	const priority = (a: string, b: string) =>
		eff.get(a)! - eff.get(b)! ||
		remaining.get(a)! - remaining.get(b)! ||
		open.get(a)!.title.localeCompare(open.get(b)!.title);

	const allocations: Allocation[] = [];
	const firstStart = new Map<string, number>();
	const finish = (p: string, at: number) => {
		pending.delete(p);
		finished.add(p);
		const pt = byPath.get(p)!;
		pt.plannedEnd = at;
		if (!firstStart.has(p)) firstStart.set(p, at);
	};

	for (const w of windows) {
		let cursor = w.start;
		while (pending.size) {
			// Zero-minute tasks complete instantly once ready and started.
			let progressed = true;
			while (progressed) {
				progressed = false;
				for (const p of [...pending]) {
					if (remaining.get(p) === 0 && isReady(p) && startOf(p) <= cursor) {
						finish(p, cursor);
						progressed = true;
					}
				}
			}
			if (cursor >= w.end || !pending.size) break;
			const ready = [...pending].filter(isReady);
			const startedNow = ready.filter((p) => startOf(p) <= cursor).sort(priority);
			const nextStart = Math.min(...ready.map(startOf).filter((s) => s > cursor));
			if (!startedNow.length) {
				if (nextStart < w.end) {
					cursor = nextStart;
					continue;
				}
				break;
			}
			const p = startedNow[0];
			const sliceEnd = Math.min(w.end, nextStart, cursor + remaining.get(p)! * MINUTE);
			const minutes = (sliceEnd - cursor) / MINUTE;
			if (!firstStart.has(p)) firstStart.set(p, cursor);
			const last = allocations[allocations.length - 1];
			if (last && last.path === p && last.end === cursor) {
				last.end = sliceEnd;
				last.minutes += minutes;
			} else {
				allocations.push({ path: p, start: cursor, end: sliceEnd, minutes });
			}
			remaining.set(p, Math.max(0, remaining.get(p)! - minutes));
			cursor = sliceEnd;
			if (remaining.get(p)! <= 1e-9) {
				remaining.set(p, 0);
				finish(p, cursor);
			}
		}
		if (!pending.size) break;
	}

	const active = topo.filter(schedulable).map((p) => byPath.get(p)!);
	for (const pt of active) {
		pt.plannedStart = firstStart.get(pt.task.path);
		if (pt.effDeadline != null) {
			if (pt.plannedEnd != null) {
				pt.slack = pt.effDeadline - pt.plannedEnd;
				pt.late = pt.slack < 0;
			} else {
				pt.late = true;
			}
		}
		if (pt.plannedEnd == null) pt.reasons.push(`${horizonDays}日以内に予定できません`);
	}
	const ordered = active.sort(
		(a, b) =>
			(a.plannedStart ?? Infinity) - (b.plannedStart ?? Infinity) ||
			(a.effDeadline ?? Infinity) - (b.effDeadline ?? Infinity) ||
			a.task.title.localeCompare(b.task.title),
	);
	ordered.forEach((pt, i) => (pt.rank = i + 1));

	return { byPath, ordered, allocations, firstWindow: windows[0] };
}

/** States that mean the task can no longer be executed and may be deleted. */
export function isDead(state: TaskState): boolean {
	return state === "expired" || state === "unreachable";
}

