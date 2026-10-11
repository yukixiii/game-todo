import { describe, expect, it } from "vitest";
import { currentPeriod, parseRule, ServerClock } from "../src/recurrence";

// Asia server: UTC+8, reset 04:00 server = 05:00 JST.
const clock: ServerClock = { utcOffset: 8, resetHour: 4, weeklyResetDay: 1 };
const jst = (s: string) => Date.parse(`${s}+09:00`);
const rule = (s: string) => parseRule(s, clock)!;

describe("parseRule", () => {
	it("parses supported rules", () => {
		expect(rule("daily")).toEqual({ kind: "daily" });
		expect(rule("weekly")).toEqual({ kind: "weekly", dow: 1 });
		expect(rule("weekly:thu")).toEqual({ kind: "weekly", dow: 4 });
		expect(rule("monthly:16")).toEqual({ kind: "monthly", day: 16 });
		expect(rule("interval:28@2026-09-01")).toEqual({ kind: "interval", days: 28, anchor: { y: 2026, m: 9, d: 1 } });
		expect(parseRule("monthly:31", clock)).toBeNull();
		expect(parseRule("hourly", clock)).toBeNull();
	});
});

describe("currentPeriod", () => {
	it("daily switches at the reset hour", () => {
		const before = currentPeriod(rule("daily"), jst("2026-10-12T04:59"), clock);
		expect(before).toEqual({ start: jst("2026-10-11T05:00"), end: jst("2026-10-12T05:00"), label: "2026-10-11" });
		const after = currentPeriod(rule("daily"), jst("2026-10-12T05:00"), clock);
		expect(after.label).toBe("2026-10-12");
		expect(after.end).toBe(jst("2026-10-13T05:00"));
	});

	it("weekly starts on the reset weekday", () => {
		// 2026-10-12 is Monday. Monday 04:30 JST is still the previous week.
		const p = currentPeriod(rule("weekly"), jst("2026-10-12T04:30"), clock);
		expect(p.label).toBe("2026-10-05");
		expect(p.end).toBe(jst("2026-10-12T05:00"));
		const q = currentPeriod(rule("weekly"), jst("2026-10-15T12:00"), clock);
		expect(q).toEqual({ start: jst("2026-10-12T05:00"), end: jst("2026-10-19T05:00"), label: "2026-10-12" });
	});

	it("monthly crosses month and year boundaries", () => {
		const p = currentPeriod(rule("monthly:16"), jst("2026-10-16T04:00"), clock);
		expect(p.label).toBe("2026-09-16");
		const q = currentPeriod(rule("monthly:16"), jst("2026-12-20T00:00"), clock);
		expect(q).toEqual({ start: jst("2026-12-16T05:00"), end: jst("2027-01-16T05:00"), label: "2026-12-16" });
		const r = currentPeriod(rule("monthly:1"), jst("2027-01-01T04:59"), clock);
		expect(r.label).toBe("2026-12-01");
	});

	it("interval counts from the anchor", () => {
		const p = currentPeriod(rule("interval:28@2026-09-01"), jst("2026-10-12T12:00"), clock);
		expect(p).toEqual({ start: jst("2026-09-29T05:00"), end: jst("2026-10-27T05:00"), label: "2026-09-29" });
	});
});
