import { describe, expect, it } from "vitest";
import { Task } from "../src/model";
import { Capacity, schedule } from "../src/scheduler";
import { DEFAULT_QUERY, normalizeQuery, queryTasks, TaskQuery } from "../src/search";

// 2026-10-12 is a Monday. TZ is Asia/Tokyo (see vitest.config.mjs).
const at = (d: number, h = 0, mi = 0) => new Date(2026, 9, d, h, mi).getTime();
const cap: Capacity = { weekday: 60, weekend: 180, playStartHour: 20 };
const now = at(12, 12);

function task(path: string, p: Partial<Task> = {}): Task {
	return { path, title: path, game: "genshin", kind: "event", prereqs: [], missingPrereqs: [], unlock: [], status: "todo", estimate: 30, ...p };
}

const r = schedule(
	[
		task("海灯祭", { deadline: at(12, 23), estimate: 30 }),
		task("週ボス", { kind: "weekly", deadline: at(14), estimate: 20 }),
		task("鳴潮イベント", { game: "wuwa", deadline: at(30), estimate: 60, unlock: ["ソラリス 第一章"] }),
		task("長い任務", { kind: "quest", deadline: at(13, 20, 30), estimate: 300 }),
		task("終わった", { deadline: at(10) }),
		task("済み", { status: "done" }),
		task("未見積", { game: "wuwa", kind: "quest", estimate: undefined }),
	],
	now,
	cap,
);

const titles = (q: Partial<TaskQuery>) => queryTasks(r, normalizeQuery({ ...DEFAULT_QUERY, ...q }), now).map((p) => p.task.title);

describe("queryTasks", () => {
	it("hides done tasks by default and sorts by rank with unranked last", () => {
		const list = titles({});
		expect(list).not.toContain("済み");
		expect(list.slice(-2).sort()).toEqual(["未見積", "終わった"]);
		expect(list[0]).toBe("海灯祭");
	});

	it("searches title, unlock and reasons with AND and exclusion", () => {
		expect(titles({ text: "ソラリス" })).toEqual(["鳴潮イベント"]);
		expect(titles({ text: "イベント 鳴潮" })).toEqual(["鳴潮イベント"]);
		expect(titles({ text: "所要時間が未設定" })).toEqual(["未見積"]);
		expect(titles({ text: "任務 -長い", states: [] })).toEqual(["未見積"]);
	});

	it("filters by game, kind and state", () => {
		expect(titles({ games: ["wuwa"] }).sort()).toEqual(["未見積", "鳴潮イベント"]);
		expect(titles({ kinds: ["weekly", "quest"], games: ["genshin"] }).sort()).toEqual(["週ボス", "長い任務"]);
		expect(titles({ states: ["done"] })).toEqual(["済み"]);
		expect(titles({ states: ["late"] }).sort()).toEqual(["週ボス", "長い任務"]); // the long quest eats both windows
		expect(titles({ states: [] })).toContain("済み");
	});

	it("filters by deadline range", () => {
		expect(titles({ due: "today" })).toEqual(["海灯祭"]);
		expect(titles({ due: "3d" }).sort()).toEqual(["海灯祭", "週ボス", "長い任務"].sort());
		expect(titles({ due: "overdue" })).toEqual(["終わった"]);
		expect(titles({ due: "none" })).toEqual(["未見積"]);
	});

	it("sorts by column in both directions, keeping missing values last", () => {
		expect(titles({ sort: "deadline" })).toEqual(["終わった", "海灯祭", "長い任務", "週ボス", "鳴潮イベント", "未見積"]);
		expect(titles({ sort: "deadline", desc: true })).toEqual(["鳴潮イベント", "週ボス", "長い任務", "海灯祭", "終わった", "未見積"]);
	});

	it("sorts by own minutes and by minutes including prerequisites", () => {
		const r2 = schedule(
			[task("前提", { estimate: 120 }), task("本体", { estimate: 10, prereqs: ["前提"] }), task("単独", { estimate: 60 })],
			now,
			cap,
		);
		const sorted = (q: Partial<TaskQuery>) =>
			queryTasks(r2, normalizeQuery({ ...DEFAULT_QUERY, ...q }), now).map((p) => p.task.title);
		expect(sorted({ sort: "minutes" })).toEqual(["本体", "単独", "前提"]);
		expect(sorted({ sort: "totalMinutes" })).toEqual(["単独", "前提", "本体"]);
	});
});
