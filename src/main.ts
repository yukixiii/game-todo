import { debounce, Notice, Plugin, requestUrl } from "obsidian";
import { buildTaskNote, GAMES, safeFileName, Task } from "./model";
import { currentPeriod, kindForRule, parseRule } from "./recurrence";
import { TaskRepo } from "./repo";
import { schedule, ScheduleResult } from "./scheduler";
import { DEFAULT_SETTINGS, GameTodoSettings, GameTodoSettingTab, mergeSettings } from "./settings";
import { genshinSource } from "./sources/genshin";
import { jsonFeedSource } from "./sources/jsonFeed";
import { FetchJson, Source } from "./sources/types";
import { formatLocalIso, HOUR, MINUTE } from "./time";
import { ConfirmModal, ImportCandidate, ImportModal, TaskModal } from "./ui/modals";
import { TodoView, VIEW_TYPE } from "./view/TodoView";

export default class GameTodoPlugin extends Plugin {
	settings: GameTodoSettings = DEFAULT_SETTINGS;
	repo!: TaskRepo;
	result: ScheduleResult | null = null;
	private tasks: Task[] = [];
	private housekeepingRunning = false;

	async onload(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
		this.repo = new TaskRepo(this.app, () => this.settings.rootFolder);

		this.registerView(VIEW_TYPE, (leaf) => new TodoView(leaf, this));
		this.addRibbonIcon("swords", "Game ToDo を開く", () => this.activateView());
		this.addSettingTab(new GameTodoSettingTab(this.app, this));

		this.addCommand({ id: "open-view", name: "ビューを開く", callback: () => this.activateView() });
		this.addCommand({ id: "new-task", name: "タスクを追加", callback: () => this.openNewTask() });
		this.addCommand({ id: "import-events", name: "イベントを取り込む", callback: () => this.importEvents() });
		this.addCommand({
			id: "generate-recurring",
			name: "繰り返しタスクを生成",
			callback: async () => {
				const n = await this.generateRecurring();
				new Notice(n ? `繰り返しタスクを ${n} 件作成しました` : "新しく作成する繰り返しタスクはありません");
			},
		});
		this.addCommand({ id: "new-template", name: "繰り返しテンプレートを作成", callback: () => this.createTemplate() });
		this.addCommand({
			id: "delete-expired",
			name: "期限切れタスクを削除",
			callback: () => {
				this.refresh(false);
				const dead = [...(this.result?.byPath.values() ?? [])].filter(
					(pt) => pt.state === "expired" || pt.state === "unreachable",
				);
				if (!dead.length) new Notice("期限切れのタスクはありません");
				else this.confirmDelete(dead.map((pt) => pt.task.path));
			},
		});

		const later = debounce(() => this.refresh(false), 300, true);
		this.registerEvent(this.app.metadataCache.on("changed", later));
		this.registerEvent(this.app.vault.on("delete", later));
		this.registerEvent(this.app.vault.on("rename", later));
		// Time passing changes states (expired, today's window) even without edits.
		this.registerInterval(window.setInterval(() => this.refresh(false), 5 * MINUTE));
		this.registerInterval(window.setInterval(() => this.housekeeping(), HOUR));

		this.app.workspace.onLayoutReady(async () => {
			this.refresh(false);
			await this.housekeeping();
			// Prerequisite links may not be resolved yet right after startup; run once more when they are.
			const ref = this.app.metadataCache.on("resolved", async () => {
				this.app.metadataCache.offref(ref);
				this.refresh(false);
				await this.housekeeping();
			});
			this.registerEvent(ref);
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refresh(false);
	}

	refresh(notify: boolean): void {
		this.tasks = this.repo.loadTasks();
		this.result = schedule(this.tasks, Date.now(), this.settings.capacity, { horizonDays: this.settings.horizonDays });
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof TodoView) leaf.view.render();
		}
		if (notify) new Notice(`${this.tasks.length} 件のタスクを再計算しました`);
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	/** Generates recurring instances and auto-deletes expired ones. */
	private async housekeeping(): Promise<void> {
		if (this.housekeepingRunning) return;
		this.housekeepingRunning = true;
		try {
			await this.generateRecurring();
			if (this.settings.autoDeleteExpiredRecurring) {
				this.refresh(false);
				const dead = this.tasks.filter(
					(t) => t.recurrenceOf && this.result?.byPath.get(t.path)?.state === "expired",
				);
				for (const t of dead) await this.repo.trash(t.path);
			}
		} catch (e) {
			console.error("[game-todo] housekeeping failed", e);
		} finally {
			this.housekeepingRunning = false;
		}
	}

	async generateRecurring(now = Date.now()): Promise<number> {
		const tasks = this.repo.loadTasks();
		let created = 0;
		for (const tpl of this.repo.loadTemplates()) {
			const clock = this.settings.games[tpl.game];
			const rule = parseRule(tpl.rule, clock);
			if (!rule) {
				new Notice(`テンプレート「${tpl.title}」の rule を解釈できません: ${tpl.rule}`);
				continue;
			}
			const period = currentPeriod(rule, now, clock);
			const exists = tasks.some((t) => t.recurrenceOf === tpl.title && t.start === period.start);
			const folder = this.repo.tasksFolder(tpl.game);
			const title = safeFileName(`${tpl.title} ${period.label}`);
			if (exists || this.repo.exists(`${folder}/${title}.md`)) continue;
			await this.repo.create(
				folder,
				title,
				buildTaskNote({
					game: tpl.game,
					kind: tpl.kind === "periodic" ? kindForRule(rule) : tpl.kind,
					start: period.start,
					deadline: period.end,
					estimate: tpl.estimate,
					prereqLinks: tpl.prereqLinks,
					recurrenceOf: `[[${tpl.title}]]`,
				}),
			);
			created++;
		}
		return created;
	}

	async createTemplate(): Promise<void> {
		const content = [
			"---",
			"gtodo: recurring",
			"game: genshin",
			"kind: weekly",
			"# daily / weekly / weekly:mon / monthly:16 / interval:28@2026-09-01",
			"rule: weekly",
			"estimate: 30",
			"prereqs: []",
			"---",
			"",
			"繰り返しタスクのテンプレートです。期間ごとに Tasks フォルダへインスタンスが作られます。",
			"",
		].join("\n");
		const file = await this.repo.create(this.repo.recurringFolder(), "新しい繰り返しタスク", content);
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	openNewTask(): void {
		const titles = this.tasks.filter((t) => t.status !== "done").map((t) => t.title);
		new TaskModal(this.app, titles, async (f) => {
			await this.repo.create(this.repo.tasksFolder(f.game), f.title, buildTaskNote(f));
			new Notice(`「${f.title}」を作成しました`);
		}).open();
	}

	confirmDelete(paths: string[]): void {
		const names = paths.map((p) => this.result?.byPath.get(p)?.task.title ?? p);
		new ConfirmModal(this.app, `${paths.length} 件のタスクを削除しますか？`, names, "削除", async () => {
			for (const p of paths) await this.repo.trash(p);
			new Notice(`${paths.length} 件を削除しました`);
		}).open();
	}

	private sources(): Source[] {
		const fetchJson: FetchJson = async (url) => (await requestUrl({ url })).json;
		const out: Source[] = [];
		if (this.settings.genshinImport) {
			out.push(
				genshinSource(fetchJson, () => ({
					excludeKeywords: this.settings.genshinExcludeKeywords,
					utcOffset: this.settings.games.genshin.utcOffset,
				})),
			);
		}
		for (const g of GAMES) {
			const url = this.settings.games[g].feedUrl;
			if (url) out.push(jsonFeedSource(fetchJson, g, url));
		}
		return out;
	}

	async importEvents(): Promise<void> {
		const sources = this.sources();
		if (!sources.length) {
			new Notice("取り込み元がありません。設定で原神の取り込みを有効にするか、フィード URL を設定してください");
			return;
		}
		const notice = new Notice("イベントを取得中…", 0);
		const now = Date.now();
		const errors: string[] = [];
		const events = (
			await Promise.all(
				sources.map((s) =>
					s.fetch(now).catch((e: unknown) => {
						errors.push(`${s.label}: 取得に失敗しました（${e instanceof Error ? e.message : String(e)}）`);
						return [];
					}),
				),
			)
		).flat();
		notice.hide();

		const tasks = this.repo.loadTasks();
		const bySource = new Map(tasks.filter((t) => t.source).map((t) => [t.source!, t]));
		const candidates: ImportCandidate[] = events.map((event) => {
			const t = bySource.get(event.sourceId);
			return { event, existing: t?.path, changed: t ? t.deadline !== event.end : undefined };
		});
		new ImportModal(this.app, candidates, errors, async (chosen) => {
			let created = 0;
			let updated = 0;
			for (const c of chosen) {
				if (c.existing) {
					if (!c.changed) continue;
					await this.repo.update(c.existing, (fm) => {
						fm.deadline = c.event.end != null ? formatLocalIso(c.event.end) : null;
					});
					updated++;
				} else {
					await this.repo.create(
						this.repo.inboxFolder(),
						c.event.title,
						buildTaskNote(
							{
								game: c.event.game,
								kind: "event",
								start: c.event.start,
								deadline: c.event.end,
								source: c.event.sourceId,
							},
							c.event.url ? `${c.event.url}\n` : "",
						),
					);
					created++;
				}
			}
			new Notice(`取り込み: 新規 ${created} 件 / 期限更新 ${updated} 件`);
		}).open();
	}
}
