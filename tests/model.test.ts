import { describe, expect, it } from "vitest";
import { buildTaskNote, linkTarget, parseTask, parseTemplate, safeFileName } from "../src/model";
import { formatLocalIso, parseDate, parseWallClock } from "../src/time";

const notes: Record<string, string> = { "魔神任務": "T/魔神任務.md", "前提": "T/前提.md" };
const resolve = (l: string) => notes[l] ?? null;

describe("time", () => {
	it("parses dates", () => {
		expect(parseDate("2026-11-04T04:59+09:00")).toBe(Date.UTC(2026, 10, 3, 19, 59));
		expect(parseDate("2026-11-04 04:59")).toBe(new Date(2026, 10, 4, 4, 59).getTime());
		expect(parseDate("2026-11-04")).toBe(new Date(2026, 10, 4, 23, 59, 59).getTime());
		expect(parseDate("")).toBeUndefined();
		expect(parseDate("nope")).toBeUndefined();
		expect(parseWallClock("2026-11-03 03:59:59", 8)).toBe(Date.UTC(2026, 10, 2, 19, 59, 59));
	});

	it("formats local ISO round-trip", () => {
		const t = new Date(2026, 10, 4, 4, 59).getTime();
		expect(formatLocalIso(t)).toBe("2026-11-04T04:59+09:00");
		expect(parseDate(formatLocalIso(t))).toBe(t);
	});
});

describe("model", () => {
	it("extracts link targets", () => {
		expect(linkTarget("[[a|b]]")).toBe("a");
		expect(linkTarget("[[a#h]]")).toBe("a");
		expect(linkTarget(" a ")).toBe("a");
	});

	it("parses a task note", () => {
		const t = parseTask(
			"T/ev.md",
			"ev",
			{
				gtodo: "task",
				game: "wuwa",
				kind: "event",
				deadline: "2026-11-04T04:59+09:00",
				estimate: "90",
				prereqs: ["[[魔神任務]]", "[[ない]]", "[[ev]]"],
				status: "doing",
			},
			(l) => (l === "ev" ? "T/ev.md" : resolve(l)),
		)!;
		expect(t.game).toBe("wuwa");
		expect(t.estimate).toBe(90);
		expect(t.prereqs).toEqual(["T/魔神任務.md"]);
		expect(t.missingPrereqs).toEqual(["ない"]);
		expect(t.status).toBe("doing");
		expect(parseTask("x.md", "x", { tags: [] }, resolve)).toBeNull();
	});

	it("defaults invalid values and blank estimate", () => {
		const t = parseTask("x.md", "x", { gtodo: "task", game: "hsr", status: "?", estimate: null }, resolve)!;
		expect(t.game).toBe("genshin");
		expect(t.status).toBe("todo");
		expect(t.estimate).toBeUndefined();
	});

	it("parses recurring templates", () => {
		const t = parseTemplate("R/週ボス.md", "週ボス", { gtodo: "recurring", game: "genshin", rule: "weekly", estimate: 30 })!;
		expect(t.rule).toBe("weekly");
		expect(t.kind).toBe("periodic");
		expect(parseTemplate("R/x.md", "x", { gtodo: "recurring" })).toBeNull();
	});

	it("builds a note with frontmatter", () => {
		const s = buildTaskNote({
			game: "genshin",
			kind: "event",
			deadline: new Date(2026, 10, 4, 4, 59).getTime(),
			prereqLinks: ['[[魔神任務 "第五章"]]'],
			source: "hoyoverse-ann:1",
		});
		expect(s).toContain("deadline: 2026-11-04T04:59+09:00");
		expect(s).toContain('  - "[[魔神任務 \\"第五章\\"]]"');
		expect(s).toContain("estimate:\n");
		expect(s).toContain('source: "hoyoverse-ann:1"');
	});

	it("round-trips unlock conditions and the suggested estimate", () => {
		const s = buildTaskNote({
			game: "wuwa",
			kind: "event",
			suggestedEstimate: 35,
			unlock: ["ユニオンレベル≧14", '潮汐任務「惹かれ合う声」をクリア'],
		});
		expect(s).toContain("estimate:\nsuggestedEstimate: 35\n");
		expect(s).toContain('unlock:\n  - "ユニオンレベル≧14"\n');
		const t = parseTask("I/x.md", "x", { gtodo: "task", suggestedEstimate: 35, unlock: ["a", "b"] }, () => null)!;
		expect(t.estimate).toBeUndefined();
		expect(t.suggestedEstimate).toBe(35);
		expect(t.unlock).toEqual(["a", "b"]);
		expect(buildTaskNote({ game: "genshin", kind: "event" })).not.toContain("unlock");
	});

	it("sanitizes file names", () => {
		expect(safeFileName('イベント「A」：B/C?')).toBe("イベント「A」：B C");
	});
});
