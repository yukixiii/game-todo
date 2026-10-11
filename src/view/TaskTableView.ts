import { ItemView, Keymap, setIcon, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type GameTodoPlugin from "../main";
import { GAME_LABEL, GAMES, KIND_LABEL, KINDS } from "../model";
import {
	DEFAULT_QUERY,
	DUE_LABEL,
	DueFilter,
	normalizeQuery,
	ownMinutes,
	queryTasks,
	SortKey,
	STATE_FILTERS,
	STATE_LABEL,
	TaskQuery,
	totalMinutes,
} from "../search";
import { PlannedTask } from "../scheduler";
import { formatMinutes, formatShort, formatSpan } from "../time";

export const VIEW_TYPE_TABLE = "game-todo-table";

const COLUMNS: { key: SortKey | null; label: string; cls?: string }[] = [
	{ key: null, label: "" },
	{ key: "rank", label: "#", cls: "is-num" },
	{ key: "game", label: "ゲーム" },
	{ key: "title", label: "タイトル" },
	{ key: "kind", label: "種類" },
	{ key: "state", label: "状態" },
	{ key: "deadline", label: "期限" },
	{ key: "minutes", label: "所要", cls: "is-num" },
	{ key: "totalMinutes", label: "前提込み", cls: "is-num" },
	{ key: "plannedEnd", label: "完了予定" },
	{ key: "slack", label: "余裕", cls: "is-num" },
];

/** Searchable table of all tasks, opened in the main area. */
export class TaskTableView extends ItemView {
	private query: TaskQuery = normalizeQuery(DEFAULT_QUERY);
	private filtersEl!: HTMLElement;
	private resultEl!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: GameTodoPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TABLE;
	}
	getDisplayText(): string {
		return "Game ToDo 一覧";
	}
	getIcon(): string {
		return "table";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), query: this.query };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const q = (state as { query?: Partial<TaskQuery> } | null)?.query;
		if (q) {
			this.query = normalizeQuery(q);
			if (this.filtersEl) this.renderFilters();
			this.renderTable();
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("gtodo-table-view");
		this.filtersEl = root.createDiv({ cls: "gtodo-filters" });
		this.resultEl = root.createDiv({ cls: "gtodo-table-wrap" });
		this.renderFilters();
		this.renderTable();
	}

	/** Re-renders only the table so the search box keeps focus while the schedule refreshes. */
	render(): void {
		this.renderTable();
	}

	private changed(rebuildFilters = false): void {
		if (rebuildFilters) this.renderFilters();
		this.renderTable();
		this.app.workspace.requestSaveLayout();
	}

	private renderFilters(): void {
		const el = this.filtersEl;
		el.empty();
		const q = this.query;

		const top = el.createDiv({ cls: "gtodo-filter-row" });
		const search = top.createEl("input", {
			type: "search",
			cls: "gtodo-search",
			attr: { placeholder: "検索（空白で AND、-語 で除外）" },
		});
		search.value = q.text;
		search.oninput = (e) => {
			if ((e as InputEvent).isComposing) return;
			q.text = search.value;
			this.changed();
		};
		search.addEventListener("compositionend", () => {
			q.text = search.value;
			this.changed();
		});

		const due = top.createEl("select", { cls: "dropdown" });
		for (const [id, label] of Object.entries(DUE_LABEL)) due.createEl("option", { value: id, text: label });
		due.value = q.due;
		due.onchange = () => {
			q.due = due.value as DueFilter;
			this.changed();
		};

		const clear = top.createEl("button", { text: "クリア" });
		clear.onclick = () => {
			this.query = normalizeQuery(DEFAULT_QUERY);
			this.changed(true);
		};
		this.iconButton(top, "plus", "タスクを追加", () => this.plugin.openNewTask());
		this.iconButton(top, "download", "イベントを取り込む", () => this.plugin.importEvents());
		this.iconButton(top, "scroll-text", "任務を取り込む", () => this.plugin.importQuests());
		this.iconButton(top, "refresh-cw", "再計算", () => this.plugin.refresh(true));

		this.chips(el, "ゲーム", GAMES, (g) => GAME_LABEL[g], q.games);
		this.chips(el, "種類", KINDS, (k) => KIND_LABEL[k], q.kinds);
		this.chips(el, "状態", STATE_FILTERS, (s) => STATE_LABEL[s], q.states);
	}

	/** Toggle chips that edit `selected` in place; none selected = no condition. */
	private chips<T extends string>(parent: HTMLElement, label: string, all: T[], text: (v: T) => string, selected: T[]): void {
		const row = parent.createDiv({ cls: "gtodo-filter-row" });
		row.createSpan({ cls: "gtodo-filter-label", text: label });
		for (const v of all) {
			const chip = row.createSpan({ cls: "gtodo-chip gtodo-toggle", text: text(v) });
			chip.toggleClass("is-active", selected.includes(v));
			chip.onclick = () => {
				const i = selected.indexOf(v);
				if (i >= 0) selected.splice(i, 1);
				else selected.push(v);
				chip.toggleClass("is-active", i < 0);
				this.changed();
			};
		}
	}

	private renderTable(): void {
		const el = this.resultEl;
		if (!el) return;
		el.empty();
		const r = this.plugin.result;
		if (!r) {
			el.createDiv({ cls: "gtodo-empty", text: "読み込み中…" });
			return;
		}
		const list = queryTasks(r, this.query, Date.now());
		el.createDiv({ cls: "gtodo-subhead", text: `${list.length} / ${r.byPath.size} 件` });
		if (!list.length) {
			el.createDiv({ cls: "gtodo-empty", text: "条件に合うタスクはありません" });
			return;
		}

		const table = el.createEl("table", { cls: "gtodo-table" });
		const head = table.createEl("thead").createEl("tr");
		for (const c of COLUMNS) {
			const th = head.createEl("th", { text: c.label, cls: c.cls });
			if (!c.key) continue;
			const key = c.key;
			th.addClass("is-sortable");
			if (this.query.sort === key) th.createSpan({ cls: "gtodo-sort", text: this.query.desc ? "▼" : "▲" });
			th.onclick = () => {
				if (this.query.sort === key) this.query.desc = !this.query.desc;
				else {
					this.query.sort = key;
					this.query.desc = false;
				}
				this.changed();
			};
		}
		const body = table.createEl("tbody");
		for (const pt of list) this.row(body, pt);
	}

	private row(body: HTMLElement, pt: PlannedTask): void {
		const t = pt.task;
		const tr = body.createEl("tr", { cls: "gtodo-trow" });
		if (pt.late) tr.addClass("is-late");
		if (pt.state === "done") tr.addClass("is-done");

		const cb = tr.createEl("td").createEl("input", { type: "checkbox", cls: "task-list-item-checkbox" });
		cb.checked = t.status === "done";
		cb.onclick = (e) => e.stopPropagation();
		cb.onchange = () => this.plugin.repo.setStatus(t.path, cb.checked ? "done" : "todo");

		tr.createEl("td", { cls: "is-num gtodo-rank", text: pt.rank != null ? String(pt.rank) : "" });
		tr.createEl("td").createSpan({ cls: `gtodo-game gtodo-game-${t.game}`, text: GAME_LABEL[t.game] });

		const titleCell = tr.createEl("td", { cls: "gtodo-title-cell" });
		const title = titleCell.createDiv({ cls: "gtodo-title" });
		title.createSpan({ text: t.title });
		if (t.url) {
			const url = t.url;
			const link = title.createSpan({ cls: "gtodo-link clickable-icon", attr: { "aria-label": "元記事を開く" } });
			setIcon(link, "external-link");
			link.onclick = (e) => {
				e.stopPropagation();
				window.open(url);
			};
		}
		if (pt.reasons.length) titleCell.createDiv({ cls: "gtodo-reason", text: pt.reasons.join(" / ") });

		tr.createEl("td", { text: KIND_LABEL[t.kind] });
		tr.createEl("td", { text: pt.late ? `${STATE_LABEL[pt.state]}・遅延` : STATE_LABEL[pt.state] });
		tr.createEl("td", { text: t.deadline != null ? formatShort(t.deadline) : "" });
		const own = ownMinutes(pt);
		tr.createEl("td", { cls: "is-num", text: own != null ? formatMinutes(own) : "" });
		const total = totalMinutes(pt);
		// Blank when it equals the task's own time, so only real prerequisite overhead stands out.
		const withPrereqs = total != null && total !== (own ?? 0) ? formatMinutes(total) : "";
		tr.createEl("td", { cls: "is-num gtodo-total", text: withPrereqs });
		tr.createEl("td", { text: pt.plannedEnd != null ? formatShort(pt.plannedEnd) : "" });
		tr.createEl("td", { cls: "is-num", text: pt.slack != null ? formatSpan(pt.slack) : "" });

		tr.onclick = (e) => this.app.workspace.openLinkText(t.path, "", Keymap.isModEvent(e));
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const b = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.onclick = onClick;
	}
}
