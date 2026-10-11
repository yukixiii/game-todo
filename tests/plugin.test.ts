import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GameTodoPlugin from "../src/main";
import { PERIODIC_PRESETS } from "../src/periodic";
import { parseRule } from "../src/recurrence";
import { TaskRepo } from "../src/repo";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";
import { FakeApp } from "./mocks/obsidian";

const jst = (s: string) => Date.parse(`${s}+09:00`);

function setup() {
	const app = new FakeApp();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const plugin = new GameTodoPlugin(app as any, {} as any);
	plugin.settings = mergeSettings(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	plugin.repo = new TaskRepo(app as any, () => plugin.settings.rootFolder);
	return { app, plugin };
}

describe("plugin with a fake vault", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("loads tasks and resolves prerequisites", () => {
		const { app, plugin } = setup();
		app.write("GameTodo/Tasks/原神/魔神任務.md", "---\ngtodo: task\ngame: genshin\nestimate: 60\n---\n");
		app.write("memo.md", "# not a task");
		app.write(
			"GameTodo/Tasks/原神/イベント.md",
			'---\ngtodo: task\ngame: genshin\nestimate: 30\ndeadline: 2026-10-20T04:59+09:00\nprereqs:\n  - "[[魔神任務]]"\n  - "[[memo]]"\n---\n',
		);
		const tasks = plugin.repo.loadTasks();
		const ev = tasks.find((t) => t.title === "イベント")!;
		expect(ev.prereqs).toEqual(["GameTodo/Tasks/原神/魔神任務.md"]);
		expect(ev.missingPrereqs).toEqual(["memo"]);
		vi.setSystemTime(jst("2026-10-12T12:00"));
		plugin.refresh(false);
		expect(plugin.result!.ordered.map((p) => p.task.title)).toEqual(["魔神任務", "イベント"]);
		expect(plugin.result!.byPath.get(ev.path)!.totalMinutes).toBe(90);
	});

	it("generates recurring instances once per period and trashes expired ones", async () => {
		const { app, plugin } = setup();
		app.write("GameTodo/Recurring/週ボス.md", "---\ngtodo: recurring\ngame: genshin\nrule: weekly\nestimate: 30\n---\n");

		vi.setSystemTime(jst("2026-10-13T12:00"));
		expect(await plugin.generateRecurring()).toBe(1);
		expect(await plugin.generateRecurring()).toBe(0);
		const path = "GameTodo/Tasks/原神/週ボス 2026-10-12.md";
		const inst = plugin.repo.loadTasks().find((t) => t.path === path)!;
		expect(inst.kind).toBe("weekly"); // inferred from the rule
		expect(inst.deadline).toBe(jst("2026-10-19T05:00"));
		expect(inst.recurrenceOf).toBe("週ボス");

		// Next week: a new instance appears and the old, unfinished one is trashed.
		vi.setSystemTime(jst("2026-10-19T06:00"));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugin as any).housekeeping();
		expect(app.trashed).toEqual([path]);
		expect(app.files.has("GameTodo/Tasks/原神/週ボス 2026-10-19.md")).toBe(true);
	});

	it("keeps completed recurring instances and non-recurring expired tasks", async () => {
		const { app, plugin } = setup();
		app.write("GameTodo/Tasks/原神/old event.md", "---\ngtodo: task\nestimate: 10\ndeadline: 2026-10-01T04:59+09:00\n---\n");
		app.write(
			"GameTodo/Tasks/原神/週ボス 2026-10-05.md",
			'---\ngtodo: task\nestimate: 10\nstatus: done\ndeadline: 2026-10-12T05:00+09:00\nrecurrenceOf: "[[週ボス]]"\n---\n',
		);
		vi.setSystemTime(jst("2026-10-13T12:00"));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugin as any).housekeeping();
		expect(app.trashed).toEqual([]);
		plugin.refresh(false);
		expect(plugin.result!.byPath.get("GameTodo/Tasks/原神/old event.md")!.state).toBe("expired");
	});

	it("imports quest chains in prerequisite order and links conditions both ways", async () => {
		const { app, plugin } = setup();
		app.write(
			"GameTodo/Inbox/月が照らす道.md",
			'---\ngtodo: task\ngame: wuwa\nkind: event\nestimate:\nprereqs: []\nunlock:\n  - "または、潮汐任務「惹かれ合う声」をクリア"\nsource: "kuro-notice:50606"\n---\n',
		);
		const quest = (id: number, title: string, prereq?: number) => ({
			sourceId: `encore-story:${id}`,
			game: "wuwa" as const,
			title,
			kind: "quest" as const,
			prereqSourceIds: prereq ? [`encore-story:${prereq}`] : [],
			suggestedEstimate: 30,
		});
		// Given out of order: the prerequisite must still be created first so it can be linked.
		await plugin.applyImport([quest(100003, "惹かれ合う声", 100002), quest(100002, "始まり・下", 100001)]);

		const tasks = plugin.repo.loadTasks();
		const act1 = tasks.find((t) => t.title === "惹かれ合う声")!;
		expect(act1.prereqs).toEqual(["GameTodo/Inbox/始まり・下.md"]);
		expect(act1.estimate).toBeUndefined();
		expect(act1.suggestedEstimate).toBe(30);
		// 100001 is neither selected nor imported, so no dangling link is written.
		expect(tasks.find((t) => t.title === "始まり・下")!.missingPrereqs).toEqual([]);
		// The existing event quoting the quest in its conditions now depends on it.
		expect(tasks.find((t) => t.title === "月が照らす道")!.prereqs).toEqual(["GameTodo/Inbox/惹かれ合う声.md"]);

		await plugin.applyImport([
			{
				sourceId: "kuro-notice:50603",
				game: "wuwa",
				title: "天工の探し物",
				end: jst("2026-10-26T04:59"),
				conditions: ["ユニオンレベル≧14、かつ「惹かれ合う声」をクリア"],
				conditionQuests: ["惹かれ合う声", "まだない任務"],
			},
		]);
		const ev = plugin.repo.loadTasks().find((t) => t.title === "天工の探し物")!;
		expect(ev.prereqs).toEqual(["GameTodo/Inbox/惹かれ合う声.md"]);
		expect(ev.missingPrereqs).toEqual([]);
		expect(ev.unlock).toEqual(["ユニオンレベル≧14、かつ「惹かれ合う声」をクリア"]);
		expect(ev.deadline).toBe(jst("2026-10-26T04:59"));
	});

	it("does not link quests quoted only in ※ notes or recommendations of existing tasks", async () => {
		const { app, plugin } = setup();
		app.write(
			"GameTodo/Inbox/勝者は誰だ.md",
			[
				"---",
				"gtodo: task",
				"game: genshin",
				"kind: event",
				"estimate: 10",
				"prereqs: []",
				"unlock:",
				'  - "魔神任務 序章・第三幕「龍と自由の歌」をクリア"',
				'  - "魔神任務第七章・第四幕「冥府へのレクイエム」をクリア後にプレイしていただくことで、より良いイベント体験をお楽しみいただけます。"',
				'  - "※期間中に「死魂の夜想曲」をクリアすると、エピローグ任務を受注できます。"',
				'source: "hoyoverse-ann:21887"',
				"---",
				"",
			].join("\n"),
		);
		const quest = (id: number, title: string) => ({
			sourceId: `yatta-quest:${id}`,
			game: "genshin" as const,
			title,
			kind: "quest" as const,
			prereqSourceIds: [],
		});
		await plugin.applyImport([quest(1703, "冥府へのレクイエム"), quest(1702, "死魂の夜想曲"), quest(1003, "龍と自由の歌")]);

		const ev = plugin.repo.loadTasks().find((t) => t.title === "勝者は誰だ")!;
		expect(ev.prereqs).toEqual(["GameTodo/Inbox/龍と自由の歌.md"]);
	});

	it("fills missing unlock conditions on re-import without touching other fields", async () => {
		const { app, plugin } = setup();
		const path = "GameTodo/Inbox/ev.md";
		app.write(path, '---\ngtodo: task\ngame: genshin\nestimate: 20\ndeadline: 2026-10-20T04:59+09:00\nsource: "hoyoverse-ann:1"\n---\n');
		await plugin.applyImport([
			{
				sourceId: "hoyoverse-ann:1",
				game: "genshin",
				title: "ev",
				end: jst("2026-10-20T04:59"),
				conditions: ["冒険ランク20以上"],
			},
		]);
		const t = plugin.repo.loadTasks().find((x) => x.path === path)!;
		expect(t.unlock).toEqual(["冒険ランク20以上"]);
		expect(t.estimate).toBe(20);
		expect(app.files.size).toBe(1);
	});

	it("refreshes the suggested estimate only while the estimate is unconfirmed", async () => {
		const { app, plugin } = setup();
		const note = (estimate: string, id: number) =>
			`---\ngtodo: task\ngame: genshin\nkind: quest\nestimate:${estimate}\nsuggestedEstimate: 275\nsource: "yatta-quest:${id}"\n---\nbody\n`;
		app.write("GameTodo/Inbox/a.md", note("", 1700));
		app.write("GameTodo/Inbox/b.md", note(" 200", 1701));
		const quest = (id: number) => ({
			sourceId: `yatta-quest:${id}`,
			game: "genshin" as const,
			title: String(id),
			kind: "quest" as const,
			suggestedEstimate: 270,
		});
		await plugin.applyImport([quest(1700), quest(1701)]);
		const tasks = plugin.repo.loadTasks();
		const a = tasks.find((t) => t.source === "yatta-quest:1700")!;
		const b = tasks.find((t) => t.source === "yatta-quest:1701")!;
		expect(a.suggestedEstimate).toBe(270);
		expect(a.deadline).toBeUndefined();
		expect(b.suggestedEstimate).toBe(275);
		expect(b.estimate).toBe(200);
		expect(app.files.get("GameTodo/Inbox/a.md")!.content).toContain("body");
		expect(app.files.size).toBe(2);
	});

	it("saves the original article as url and lists related links", async () => {
		const { app, plugin } = setup();
		app.write("GameTodo/Inbox/old.md", '---\ngtodo: task\ngame: wuwa\nestimate:\nsource: "kuro-notice:1"\n---\n本文\n');
		app.write(
			"GameTodo/Inbox/linked.md",
			'---\ngtodo: task\ngame: wuwa\nestimate:\nsource: "kuro-notice:2"\nurl: "https://example.com/keep"\n---\n本文\n',
		);
		const links = [{ label: "予告", url: "https://wutheringwaves.kurogames.com/jp/main/news/detail/5554" }];
		const ev = (id: number, title: string) => ({
			sourceId: `kuro-notice:${id}`,
			game: "wuwa" as const,
			title,
			url: `https://wutheringwaves.kurogames.com/jp/main/news/detail/${id}`,
			links,
		});
		await plugin.applyImport([ev(1, "old"), ev(2, "linked"), ev(3, "新イベント")]);
		const tasks = plugin.repo.loadTasks();
		const created = tasks.find((t) => t.title === "新イベント")!;
		expect(created.url).toBe("https://wutheringwaves.kurogames.com/jp/main/news/detail/3");
		const body = app.files.get(created.path)!.content;
		expect(body).toContain("## リンク\n- 元記事: https://wutheringwaves.kurogames.com/jp/main/news/detail/3");
		expect(body).toContain("- [予告](https://wutheringwaves.kurogames.com/jp/main/news/detail/5554)");
		// Existing notes without a url get it once, with the link section appended after the body.
		const old = app.files.get("GameTodo/Inbox/old.md")!.content;
		expect(old).toContain('url: "https://wutheringwaves.kurogames.com/jp/main/news/detail/1"');
		expect(old).toMatch(/本文\n\n## リンク\n/);
		expect(app.files.get("GameTodo/Inbox/linked.md")!.content).not.toContain("## リンク");
		await plugin.applyImport([ev(1, "old")]);
		expect(app.files.get("GameTodo/Inbox/old.md")!.content.match(/## リンク/g)).toHaveLength(1);
	});

	it("creates periodic content templates and their current instances", async () => {
		const { app, plugin } = setup();
		vi.setSystemTime(jst("2026-10-12T12:00"));
		const preset = (id: string) => PERIODIC_PRESETS.find((p) => p.id === id)!;
		await plugin.createPresetTemplates([
			{ preset: preset("genshin-abyss"), estimate: 50 },
			{ preset: preset("wuwa-tower"), estimate: undefined },
		]);
		const tpl = plugin.repo.loadTemplates();
		expect(tpl.map((t) => [t.title, t.rule, t.estimate, t.source])).toEqual([
			["深境螺旋", "monthly:16", 50, "preset:genshin-abyss"],
			["逆境深塔", "interval:28@2026-09-14", undefined, "preset:wuwa-tower"],
		]);
		const tasks = plugin.repo.loadTasks();
		const abyss = tasks.find((t) => t.recurrenceOf === "深境螺旋")!;
		expect(abyss.start).toBe(jst("2026-09-16T05:00"));
		expect(abyss.deadline).toBe(jst("2026-10-16T05:00"));
		expect(abyss.estimate).toBe(50);
		expect(abyss.kind).toBe("periodic");
		expect(abyss.url).toContain("wikiwiki.jp/genshinwiki/");
		const tower = tasks.find((t) => t.recurrenceOf === "逆境深塔")!;
		expect(tower.start).toBe(jst("2026-10-12T05:00"));
		expect(tower.deadline).toBe(jst("2026-11-09T05:00"));
		expect(tower.estimate).toBeUndefined(); // left for the inbox
		expect(app.files.has("GameTodo/Recurring/深境螺旋.md")).toBe(true);
	});

	it("has a valid rule for every periodic preset", () => {
		for (const p of PERIODIC_PRESETS) expect(parseRule(p.rule, DEFAULT_SETTINGS.games[p.game]), p.id).not.toBeNull();
	});

	it("links existing notices to quests on re-import and clears deadlines of permanent quests", async () => {
		const { app, plugin } = setup();
		app.write("GameTodo/Inbox/冥府へのレクイエム.md", '---\ngtodo: task\ngame: genshin\nkind: quest\nestimate:\nsource: "yatta-quest:1703"\n---\n');
		app.write("GameTodo/Inbox/死魂の夜想曲.md", '---\ngtodo: task\ngame: genshin\nkind: quest\nestimate:\nsource: "yatta-quest:1701"\n---\n');
		app.write(
			"GameTodo/Inbox/bonus.md",
			'---\ngtodo: task\ngame: genshin\nkind: event\nestimate: 5\ndeadline: 2026-11-03T15:59+09:00\nprereqs: []\nsource: "hoyoverse-ann:21880"\n---\n',
		);
		app.write(
			"GameTodo/Inbox/wq.md",
			'---\ngtodo: task\ngame: genshin\nkind: event\nestimate: 60\ndeadline: 2026-11-03T19:00+09:00\nprereqs: []\nsource: "hoyoverse-ann:21882"\n---\n',
		);
		await plugin.applyImport([
			{
				sourceId: "hoyoverse-ann:21880",
				game: "genshin",
				title: "「冥府へのレクイエム」期間中に魔神任務をクリアすると…",
				end: jst("2026-11-03T15:59"),
				conditions: ["魔神任務 第七章・第二幕「死魂の夜想曲」をクリア"],
				conditionQuests: ["冥府へのレクイエム", "死魂の夜想曲"],
			},
			{
				sourceId: "hoyoverse-ann:21882",
				game: "genshin",
				title: "世界任務「追想の変奏曲」",
				kind: "quest",
				conditionQuests: ["追想の変奏曲", "死魂の夜想曲"],
			},
		]);
		const tasks = plugin.repo.loadTasks();
		const bonus = tasks.find((t) => t.source === "hoyoverse-ann:21880")!;
		expect(bonus.prereqs).toEqual(["GameTodo/Inbox/冥府へのレクイエム.md", "GameTodo/Inbox/死魂の夜想曲.md"]);
		expect(bonus.deadline).toBe(jst("2026-11-03T15:59"));
		const wq = tasks.find((t) => t.source === "hoyoverse-ann:21882")!;
		expect(wq.deadline).toBeUndefined();
		expect(wq.kind).toBe("quest");
		expect(wq.prereqs).toEqual(["GameTodo/Inbox/死魂の夜想曲.md"]);
		expect(wq.estimate).toBe(60);
	});

	it("drops the obsolete minutesPerStep setting", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const s = mergeSettings({ games: { genshin: { minutesPerStep: 2, utcOffset: 9 } } } as any);
		expect(s.games.genshin).not.toHaveProperty("minutesPerStep");
		expect(s.games.genshin.utcOffset).toBe(9);
		expect(s.games.genshin.estimateScale).toBe(1);
	});

	it("updates status through frontmatter", async () => {
		const { app, plugin } = setup();
		app.write("GameTodo/Tasks/原神/a.md", "---\ngtodo: task\nestimate: 10\nstatus: todo\n---\nbody\n");
		await plugin.repo.setStatus("GameTodo/Tasks/原神/a.md", "done");
		expect(app.files.get("GameTodo/Tasks/原神/a.md")!.content).toContain("status: done");
		expect(app.files.get("GameTodo/Tasks/原神/a.md")!.content).toContain("body");
		expect(DEFAULT_SETTINGS.rootFolder).toBe("GameTodo");
	});
});
