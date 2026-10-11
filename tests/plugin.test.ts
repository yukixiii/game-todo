import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GameTodoPlugin from "../src/main";
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

	it("updates status through frontmatter", async () => {
		const { app, plugin } = setup();
		app.write("GameTodo/Tasks/原神/a.md", "---\ngtodo: task\nestimate: 10\nstatus: todo\n---\nbody\n");
		await plugin.repo.setStatus("GameTodo/Tasks/原神/a.md", "done");
		expect(app.files.get("GameTodo/Tasks/原神/a.md")!.content).toContain("status: done");
		expect(app.files.get("GameTodo/Tasks/原神/a.md")!.content).toContain("body");
		expect(DEFAULT_SETTINGS.rootFolder).toBe("GameTodo");
	});
});
