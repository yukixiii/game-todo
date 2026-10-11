import { debounce, Notice, Plugin, requestUrl } from "obsidian";
import { buildTaskNote, buildTemplateNote, GAME_LABEL, GAMES, linkTarget, safeFileName, Task } from "./model";
import { PERIODIC_PRESETS, PeriodicPreset, presetSource } from "./periodic";
import { currentPeriod, kindForRule, parseRule } from "./recurrence";
import { TaskRepo } from "./repo";
import { schedule, ScheduleResult } from "./scheduler";
import { DEFAULT_SETTINGS, GameTodoSettings, GameTodoSettingTab, mergeSettings } from "./settings";
import { genshinSource } from "./sources/genshin";
import { genshinQuestCatalog } from "./sources/genshinQuests";
import { jsonFeedSource } from "./sources/jsonFeed";
import { addLinksToContent, attachArticles, fetchNews, linksMarkdown } from "./sources/news";
import { linkableQuestNames } from "./sources/noticeBody";
import { QuestCatalog, QuestDetail, QuestEntry, questToImported, scaleEstimate } from "./sources/quests";
import { FetchJson, ImportedEvent, Source } from "./sources/types";
import { WUWA_NOTICE_URL, wuwaSource } from "./sources/wuwa";
import { wuwaQuestCatalog } from "./sources/wuwaQuests";
import { formatLocalIso, HOUR, MINUTE } from "./time";
import { ConfirmModal, ImportCandidate, ImportModal, PeriodicImportModal, QuestImportModal, TaskModal } from "./ui/modals";
import { TaskTableView, VIEW_TYPE_TABLE } from "./view/TaskTableView";
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
		this.registerView(VIEW_TYPE_TABLE, (leaf) => new TaskTableView(leaf, this));
		this.addRibbonIcon("swords", "Game ToDo を開く", () => this.activateView());
		this.addSettingTab(new GameTodoSettingTab(this.app, this));

		this.addCommand({ id: "open-view", name: "ビューを開く", callback: () => this.activateView() });
		this.addCommand({ id: "open-table", name: "タスク一覧を開く（検索）", callback: () => this.activateTable() });
		this.addCommand({ id: "new-task", name: "タスクを追加", callback: () => this.openNewTask() });
		this.addCommand({ id: "import-events", name: "イベントを取り込む", callback: () => this.importEvents() });
		this.addCommand({ id: "import-quests", name: "任務を取り込む", callback: () => this.importQuests() });
		this.addCommand({
			id: "generate-recurring",
			name: "繰り返しタスクを生成",
			callback: async () => {
				const n = await this.generateRecurring();
				new Notice(n ? `繰り返しタスクを ${n} 件作成しました` : "新しく作成する繰り返しタスクはありません");
			},
		});
		this.addCommand({ id: "new-template", name: "繰り返しテンプレートを作成", callback: () => this.createTemplate() });
		this.addCommand({ id: "import-periodic", name: "周期コンテンツを取り込む", callback: () => this.importPeriodic() });
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
		for (const type of [VIEW_TYPE, VIEW_TYPE_TABLE]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				if (leaf.view instanceof TodoView || leaf.view instanceof TaskTableView) leaf.view.render();
			}
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

	/** Opens the searchable task table as a tab in the main area. */
	async activateTable(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_TABLE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_TABLE, active: true });
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
					url: tpl.url,
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

	importPeriodic(): void {
		const templates = this.repo.loadTemplates();
		const existing = new Set(
			PERIODIC_PRESETS.filter((p) =>
				templates.some((t) => t.source === presetSource(p) || (t.game === p.game && t.title === p.title)),
			).map((p) => p.id),
		);
		new PeriodicImportModal(this.app, PERIODIC_PRESETS, existing, async (chosen) => {
			await this.createPresetTemplates(chosen);
		}).open();
	}

	/** Creates recurring templates for the chosen presets (with the estimates the user confirmed) and their first instances. */
	async createPresetTemplates(chosen: { preset: PeriodicPreset; estimate?: number }[]): Promise<void> {
		for (const { preset: p, estimate } of chosen) {
			await this.repo.create(
				this.repo.recurringFolder(),
				p.title,
				buildTemplateNote(
					{ game: p.game, rule: p.rule, estimate, source: presetSource(p), url: p.url },
					`${GAME_LABEL[p.game]}の周期コンテンツ。${p.schedule}。\n\n更新日がずれたら \`rule\` を直してください。\n`,
				),
			);
		}
		const created = await this.generateRecurring();
		new Notice(`周期コンテンツ: テンプレート ${chosen.length} 件、今期のタスク ${created} 件を作成しました`);
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

	private fetchJson: FetchJson = async (url, headers) => (await requestUrl({ url, headers })).json;

	private sources(): Source[] {
		const out: Source[] = [];
		if (this.settings.genshinImport) {
			out.push(
				genshinSource(this.fetchJson, () => ({
					excludeKeywords: this.settings.genshinExcludeKeywords,
					utcOffset: this.settings.games.genshin.utcOffset,
				})),
			);
		}
		if (this.settings.wuwaImport) {
			out.push(
				wuwaSource(
					this.fetchJson,
					() => this.settings.wuwaNoticeUrl || WUWA_NOTICE_URL,
					() => ({
						excludeKeywords: this.settings.wuwaExcludeKeywords,
						utcOffset: this.settings.games.wuwa.utcOffset,
					}),
				),
			);
		}
		for (const g of GAMES) {
			const url = this.settings.games[g].feedUrl;
			if (url) out.push(jsonFeedSource(this.fetchJson, g, url));
		}
		return out;
	}

	async importEvents(): Promise<void> {
		const sources = this.sources();
		if (!sources.length) {
			new Notice("取り込み元がありません。設定でお知らせの取り込みを有効にするか、フィード URL を設定してください");
			return;
		}
		const notice = new Notice("イベントを取得中…", 0);
		const now = Date.now();
		const errors: string[] = [];
		const fetched = (
			await Promise.all(
				sources.map((s) =>
					s.fetch(now).catch((e: unknown) => {
						errors.push(`${s.label}: 取得に失敗しました（${errorText(e)}）`);
						return [];
					}),
				),
			)
		).flat();
		notice.hide();

		const bySource = this.tasksBySource();
		const events = this.scaleEstimates(fetched);
		const candidates: ImportCandidate[] = events.map((event) => {
			const t = bySource.get(event.sourceId);
			return { event, existing: t?.path, changed: t ? needsUpdate(t, event) : undefined };
		});
		new ImportModal(this.app, candidates, errors, (chosen) => this.applyImport(chosen.map((c) => c.event))).open();
	}

	async importQuests(): Promise<void> {
		const catalogs: QuestCatalog[] = [genshinQuestCatalog(this.fetchJson), wuwaQuestCatalog(this.fetchJson)];
		const notice = new Notice("任務一覧を取得中…", 0);
		const errors: string[] = [];
		const entries = (
			await Promise.all(
				catalogs.map((c) =>
					c.list().catch((e: unknown) => {
						errors.push(`${c.label}: 取得に失敗しました（${errorText(e)}）`);
						return [] as QuestEntry[];
					}),
				),
			)
		).flat();
		notice.hide();
		// sourceId -> whether the estimate is confirmed; unconfirmed ones can be re-selected to refresh the suggestion.
		const existing = new Map([...this.tasksBySource()].map(([id, t]) => [id, t.estimate != null]));
		new QuestImportModal(this.app, entries, existing, errors, async (chosen) => {
			const progress = new Notice(`任務の詳細を取得中…（${chosen.length} 件）`, 0);
			const details = new Map<string, QuestDetail>();
			const queue = [...chosen];
			const worker = async () => {
				for (let e = queue.shift(); e; e = queue.shift()) {
					const entry = e;
					const catalog = catalogs.find((c) => c.game === entry.game)!;
					const d = await catalog.detail(entry).catch(() => undefined);
					if (d) details.set(entry.sourceId, d);
				}
			};
			await Promise.all([worker(), worker(), worker(), worker()]);
			progress.hide();
			const missing = chosen.length - details.size;
			if (missing) new Notice(`${missing} 件は詳細を取得できなかったため、推定所要時間なしで作成します`);
			const news = new Map(
				await Promise.all(
					[...new Set(chosen.map((e) => e.game))].map(async (g) => [g, await fetchNews(this.fetchJson, g)] as const),
				),
			);
			const items = chosen.map((e) => {
				const ev = questToImported(e, details.get(e.sourceId));
				return attachArticles([ev], news.get(e.game) ?? [], (i) => [i.title])[0];
			});
			await this.applyImport(this.scaleEstimates(items));
		}).open();
	}

	/** Applies the per-game estimate scale to the raw predictions of the sources. */
	private scaleEstimates(items: ImportedEvent[]): ImportedEvent[] {
		return items.map((ev) => ({
			...ev,
			suggestedEstimate: scaleEstimate(ev.suggestedEstimate, this.settings.games[ev.game].estimateScale),
		}));
	}

	private tasksBySource(): Map<string, Task> {
		return new Map(
			this.repo
				.loadTasks()
				.filter((t) => t.source)
				.map((t) => [t.source!, t]),
		);
	}

	/**
	 * Creates notes for new items (prerequisites first, so chains can link to notes made in the same batch)
	 * and updates deadline / unlock / unconfirmed suggested estimate / missing links of already imported ones.
	 */
	async applyImport(items: ImportedEvent[]): Promise<void> {
		const tasks = this.repo.loadTasks();
		const bySource = new Map(tasks.filter((t) => t.source).map((t) => [t.source!, t]));
		/** sourceId -> note name usable in a wiki-link. */
		const noteBySource = new Map([...bySource].map(([id, t]) => [id, t.title]));
		const taskTitles = new Set(tasks.map((t) => t.title));
		const createdTitles: string[] = [];
		let updated = 0;

		for (const ev of prereqsFirst(items)) {
			const t = bySource.get(ev.sourceId);
			const links = linkNames(ev, noteBySource, taskTitles);
			if (t) {
				const add = missingLinks(t, links);
				if (!needsUpdate(t, ev) && !add.length) continue;
				await this.repo.update(t.path, (fm) => {
					if (!ev.catalog) fm.deadline = ev.end != null ? formatLocalIso(ev.end) : null;
					if (kindChanged(t, ev)) fm.kind = ev.kind;
					if (!t.unlock.length && ev.conditions?.length) fm.unlock = ev.conditions;
					if (estimateChanged(t, ev)) fm.suggestedEstimate = ev.suggestedEstimate;
					if (!t.url && ev.url) fm.url = ev.url;
					if (add.length) {
						const cur: unknown[] = Array.isArray(fm.prereqs) ? fm.prereqs : fm.prereqs ? [fm.prereqs] : [];
						fm.prereqs = [...cur, ...add.map((n) => `[[${n}]]`)];
					}
				});
				// Notes imported before links existed get the link section once, together with `url`.
				if (!t.url && ev.url) {
					const url = ev.url;
					await this.repo.processContent(t.path, (c) => addLinksToContent(c, url, ev.links, ev.urlLabel));
				}
				updated++;
				continue;
			}
			const file = await this.repo.create(
				this.repo.inboxFolder(),
				ev.title,
				buildTaskNote(
					{
						game: ev.game,
						kind: ev.kind ?? "event",
						start: ev.start,
						deadline: ev.end,
						suggestedEstimate: ev.suggestedEstimate,
						prereqLinks: [...new Set(links)].map((n) => `[[${n}]]`),
						unlock: ev.conditions,
						source: ev.sourceId,
						url: ev.url,
					},
					[ev.body, ev.estimateBasis && `推定根拠: ${ev.estimateBasis}`, linksMarkdown(ev.url, ev.links, ev.urlLabel)]
						.filter(Boolean)
						.join("\n\n"),
				),
			);
			noteBySource.set(ev.sourceId, file.basename);
			taskTitles.add(file.basename);
			createdTitles.push(file.basename);
		}

		const linked = await this.linkConditionsTo(tasks, createdTitles);
		new Notice(
			`取り込み: 新規 ${createdTitles.length} 件 / 更新 ${updated} 件` +
				(linked ? ` / 既存タスクに前提リンクを ${linked} 件追加` : ""),
		);
	}

	/**
	 * Adds prerequisite links to existing tasks whose unlock conditions quote a newly created note
	 * (same exclusions as at import: "※" notes and recommendations).
	 */
	private async linkConditionsTo(tasks: Task[], titles: string[]): Promise<number> {
		if (!titles.length) return 0;
		const names = new Set(titles);
		let n = 0;
		for (const t of tasks) {
			const add = linkableQuestNames(t.unlock).filter((q) => names.has(q));
			if (!add.length) continue;
			await this.repo.update(t.path, (fm) => {
				const cur: unknown[] = Array.isArray(fm.prereqs) ? fm.prereqs : fm.prereqs ? [fm.prereqs] : [];
				const have = new Set(cur.map((c) => linkTarget(String(c))));
				const extra = add.filter((q) => !have.has(q)).map((q) => `[[${q}]]`);
				if (extra.length) {
					fm.prereqs = [...cur, ...extra];
					n += extra.length;
				}
			});
		}
		return n;
	}
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** The suggestion is refreshed only while the user has not confirmed an estimate. */
function estimateChanged(t: Task, ev: ImportedEvent): boolean {
	return t.estimate == null && ev.suggestedEstimate != null && t.suggestedEstimate !== ev.suggestedEstimate;
}

/** Notices that turn out to be quests (世界任務「…」) are re-labelled; user-set kinds are kept. */
function kindChanged(t: Task, ev: ImportedEvent): boolean {
	return !!ev.kind && ev.kind !== t.kind && t.kind === "event";
}

/** True when an already imported item should be updated from the source (catalog quests: only the suggestion). */
export function needsUpdate(t: Task, ev: ImportedEvent): boolean {
	if (estimateChanged(t, ev) || (!t.url && !!ev.url)) return true;
	if (ev.catalog) return false;
	return t.deadline !== ev.end || kindChanged(t, ev) || (!t.unlock.length && !!ev.conditions?.length);
}

/**
 * Note names to link as prerequisites: the previous quests in a chain, and quests named in the title or
 * conditions when a task note with that name exists (never dangling links).
 */
function linkNames(ev: ImportedEvent, noteBySource: Map<string, string>, taskTitles: Set<string>): string[] {
	const names = [
		...(ev.prereqSourceIds ?? []).map((id) => noteBySource.get(id)),
		...(ev.conditionQuests ?? []).filter((q) => taskTitles.has(q) && q !== ev.title),
	].filter((n): n is string => !!n);
	return [...new Set(names)];
}

/** Links not yet among the task's prerequisites (compared by note name). */
function missingLinks(t: Task, names: string[]): string[] {
	const have = new Set([...t.prereqs.map((p) => p.replace(/^.*\//, "").replace(/\.md$/, "")), ...t.missingPrereqs]);
	return names.filter((n) => !have.has(n) && n !== t.title);
}

/** Orders items so that each comes after the prerequisites it references within the batch. */
export function prereqsFirst(items: ImportedEvent[]): ImportedEvent[] {
	const byId = new Map(items.map((i) => [i.sourceId, i]));
	const done = new Set<string>();
	const out: ImportedEvent[] = [];
	const visit = (i: ImportedEvent) => {
		if (done.has(i.sourceId)) return;
		done.add(i.sourceId);
		for (const p of i.prereqSourceIds ?? []) {
			const dep = byId.get(p);
			if (dep) visit(dep);
		}
		out.push(i);
	};
	items.forEach(visit);
	return out;
}
