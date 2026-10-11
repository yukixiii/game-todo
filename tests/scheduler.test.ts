import { describe, expect, it } from "vitest";
import { Task } from "../src/model";
import { Capacity, playWindows, schedule } from "../src/scheduler";

const M = 60_000;
// 2026-10-12 is a Monday. TZ is Asia/Tokyo (see vitest.config.mjs).
const at = (d: number, h = 0, mi = 0) => new Date(2026, 9, d, h, mi).getTime();
const cap: Capacity = { weekday: 60, weekend: 180, playStartHour: 20 };

function task(path: string, p: Partial<Task> = {}): Task {
	return { path, title: path, game: "genshin", kind: "event", prereqs: [], missingPrereqs: [], status: "todo", estimate: 30, ...p };
}

describe("playWindows", () => {
	it("clips the current window and uses weekday/weekend capacity", () => {
		const w = playWindows(at(12, 20, 30), cap, 7);
		expect(w[0]).toEqual({ start: at(12, 20, 30), end: at(12, 21) });
		expect(w[1]).toEqual({ start: at(13, 20), end: at(13, 21) });
		// Saturday 10/17
		expect(w[5]).toEqual({ start: at(17, 20), end: at(17, 23) });
	});

	it("continues yesterday's window that crosses midnight", () => {
		const w = playWindows(at(18, 0, 30), { ...cap, weekend: 300 }, 2);
		// Saturday 20:00 + 5h = Sunday 01:00
		expect(w[0]).toEqual({ start: at(18, 0, 30), end: at(18, 1) });
	});
});

describe("schedule", () => {
	it("orders by deadline and projects finish times", () => {
		const r = schedule(
			[task("a", { deadline: at(20), estimate: 30 }), task("b", { deadline: at(14), estimate: 60 })],
			at(12, 12),
			cap,
		);
		expect(r.ordered.map((p) => p.task.path)).toEqual(["b", "a"]);
		const b = r.byPath.get("b")!;
		expect(b.plannedStart).toBe(at(12, 20));
		expect(b.plannedEnd).toBe(at(12, 21));
		expect(b.late).toBe(false);
		expect(r.byPath.get("a")!.plannedEnd).toBe(at(13, 20, 30));
	});

	it("schedules prerequisites first and back-propagates deadlines", () => {
		const r = schedule(
			[
				task("story", { estimate: 90 }), // no own deadline
				task("event", { prereqs: ["story"], deadline: at(15), estimate: 60 }),
				task("other", { deadline: at(14, 12), estimate: 30 }),
			],
			at(12, 12),
			cap,
		);
		const story = r.byPath.get("story")!;
		expect(story.effDeadline).toBe(at(15) - 60 * M);
		expect(r.byPath.get("event")!.totalMinutes).toBe(150);
		// other (10/14 12:00) is due before story (eff 10/14 23:00).
		expect(r.ordered.map((p) => p.task.path)).toEqual(["other", "story", "event"]);
		// other 10/12 20:00-20:30, story 20:30-21:00 + 10/13 20:00-21:00, event needs 10/14 20:00-21:00
		expect(story.plannedEnd).toBe(at(13, 21));
		expect(r.byPath.get("event")!.plannedEnd).toBe(at(14, 21));
		expect(r.byPath.get("event")!.late).toBe(false);
	});

	it("flags tasks that cannot finish before the deadline", () => {
		const r = schedule([task("big", { deadline: at(13, 23), estimate: 180 })], at(12, 12), cap);
		const big = r.byPath.get("big")!;
		expect(big.late).toBe(true);
		expect(big.slack).toBeLessThan(0);
	});

	it("waits for the start time", () => {
		const r = schedule([task("later", { start: at(14, 20, 15), estimate: 30 })], at(12, 12), cap);
		expect(r.byPath.get("later")!.plannedStart).toBe(at(14, 20, 15));
		expect(r.byPath.get("later")!.plannedEnd).toBe(at(14, 20, 45));
	});

	it("preempts for a more urgent task that becomes available", () => {
		const r = schedule(
			[
				task("long", { estimate: 60, deadline: at(30) }),
				task("urgent", { start: at(12, 20, 20), deadline: at(12, 23), estimate: 20 }),
			],
			at(12, 12),
			cap,
		);
		expect(r.allocations.map((a) => [a.path, a.minutes])).toEqual([
			["long", 20],
			["urgent", 20],
			["long", 20],
			["long", 20],
		]);
	});

	it("uses remaining over estimate", () => {
		const r = schedule([task("x", { estimate: 120, remaining: 15 })], at(12, 12), cap);
		expect(r.byPath.get("x")!.plannedEnd).toBe(at(12, 20, 15));
	});

	it("classifies expired, unreachable, cycle, inbox and done", () => {
		const r = schedule(
			[
				task("old", { deadline: at(11) }),
				task("needsOld", { prereqs: ["old"], deadline: at(20) }),
				task("chain", { prereqs: ["needsOld"] }),
				task("c1", { prereqs: ["c2"] }),
				task("c2", { prereqs: ["c1"] }),
				task("noEstimate", { estimate: undefined }),
				task("waitsInbox", { prereqs: ["noEstimate"] }),
				task("fin", { status: "done", deadline: at(1) }),
				task("afterFin", { prereqs: ["fin"] }),
			],
			at(12, 12),
			cap,
		);
		const s = (p: string) => r.byPath.get(p)!.state;
		expect(s("old")).toBe("expired");
		expect(s("needsOld")).toBe("unreachable");
		expect(s("chain")).toBe("unreachable");
		expect(s("c1")).toBe("cycle");
		expect(s("c2")).toBe("cycle");
		expect(s("noEstimate")).toBe("inbox");
		expect(s("waitsInbox")).toBe("active");
		expect(r.byPath.get("waitsInbox")!.reasons.join()).toContain("未設定");
		expect(s("fin")).toBe("done");
		expect(s("afterFin")).toBe("active");
		expect(r.ordered.map((p) => p.task.path).sort()).toEqual(["afterFin", "waitsInbox"]);
	});

	it("counts a shared prerequisite once in the total", () => {
		const r = schedule(
			[
				task("root", { estimate: 10 }),
				task("l", { prereqs: ["root"], estimate: 20 }),
				task("r", { prereqs: ["root"], estimate: 30 }),
				task("top", { prereqs: ["l", "r"], estimate: 40 }),
			],
			at(12, 12),
			cap,
		);
		expect(r.byPath.get("top")!.totalMinutes).toBe(100);
	});

	it("marks tasks beyond the horizon as late when they have a deadline", () => {
		const r = schedule([task("huge", { estimate: 100000, deadline: at(31) })], at(12, 12), cap, { horizonDays: 3 });
		const huge = r.byPath.get("huge")!;
		expect(huge.plannedEnd).toBeUndefined();
		expect(huge.late).toBe(true);
	});
});
