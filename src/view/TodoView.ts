import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type GameTodoPlugin from "../main";
import { Game, GAME_LABEL, GAMES, KIND_LABEL } from "../model";
import { isDead, PlannedTask, ScheduleResult } from "../scheduler";
import { formatMinutes, formatShort, formatSpan } from "../time";

export const VIEW_TYPE = "game-todo-view";

type Tab = "today" | "priority" | "expired" | "inbox";
const TABS: { id: Tab; label: string }[] = [
	{ id: "today", label: "次の枠" },
	{ id: "priority", label: "優先度順" },
	{ id: "expired", label: "期限切れ" },
	{ id: "inbox", label: "Inbox" },
];

export class TodoView extends ItemView {
	private tab: Tab = "today";
	private filter: Game | "all" = "all";

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: GameTodoPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Game ToDo";
	}
	getIcon(): string {
		return "swords";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	render(): void {
		const r = this.plugin.result;
		const root = this.contentEl;
		root.empty();
		root.addClass("gtodo-view");

		const bar = root.createDiv({ cls: "gtodo-toolbar" });
		const sel = bar.createEl("select", { cls: "dropdown" });
		sel.createEl("option", { value: "all", text: "すべて" });
		for (const g of GAMES) sel.createEl("option", { value: g, text: GAME_LABEL[g] });
		sel.value = this.filter;
		sel.onchange = () => {
			this.filter = sel.value as Game | "all";
			this.render();
		};
		this.iconButton(bar, "plus", "タスクを追加", () => this.plugin.openNewTask());
		this.iconButton(bar, "download", "イベントを取り込む", () => this.plugin.importEvents());
		this.iconButton(bar, "refresh-cw", "再計算", () => this.plugin.refresh(true));

		const counts = this.counts(r);
		const tabs = root.createDiv({ cls: "gtodo-tabs" });
		for (const t of TABS) {
			const el = tabs.createDiv({ cls: "gtodo-tab", text: t.label });
			const n = counts[t.id];
			if (n) el.createSpan({ cls: "gtodo-count", text: String(n) });
			if (t.id === this.tab) el.addClass("is-active");
			el.onclick = () => {
				this.tab = t.id;
				this.render();
			};
		}

		const body = root.createDiv({ cls: "gtodo-body" });
		if (!r) {
			body.createDiv({ cls: "gtodo-empty", text: "読み込み中…" });
			return;
		}
		if (this.tab === "today") this.renderToday(body, r);
		else if (this.tab === "priority") this.renderPriority(body, r);
		else if (this.tab === "expired") this.renderExpired(body, r);
		else this.renderInbox(body, r);
	}

	private visible(pt: PlannedTask): boolean {
		return this.filter === "all" || pt.task.game === this.filter;
	}

	private all(r: ScheduleResult): PlannedTask[] {
		return [...r.byPath.values()].filter((pt) => this.visible(pt));
	}

	private counts(r: ScheduleResult | null): Record<Tab, number> {
		if (!r) return { today: 0, priority: 0, expired: 0, inbox: 0 };
		const all = this.all(r);
		return {
			today: 0,
			priority: r.ordered.filter((pt) => this.visible(pt) && pt.late).length,
			expired: all.filter((pt) => isDead(pt.state)).length,
			inbox: all.filter((pt) => pt.state === "inbox" || pt.state === "cycle").length,
		};
	}

	private renderToday(el: HTMLElement, r: ScheduleResult): void {
		const w = r.firstWindow;
		if (!w) {
			el.createDiv({ cls: "gtodo-empty", text: "プレイ時間枠がありません（設定でプレイ時間を設定してください）" });
			return;
		}
		const allocs = r.allocations.filter((a) => a.start < w.end && this.visible(r.byPath.get(a.path)!));
		const used = allocs.reduce((s, a) => s + a.minutes, 0);
		el.createDiv({
			cls: "gtodo-window",
			text: `${formatShort(w.start)} 〜 ${formatShort(w.end).split(" ")[1]}（予定 ${formatMinutes(used)} / 枠 ${formatMinutes((w.end - w.start) / 60_000)}）`,
		});
		if (!allocs.length) el.createDiv({ cls: "gtodo-empty", text: "この枠でやることはありません" });
		for (const a of allocs) {
			const pt = r.byPath.get(a.path)!;
			this.row(el, pt, `${formatShort(a.start).split(" ")[1]}〜 ${formatMinutes(a.minutes)}`);
		}
		const late = r.ordered.filter((pt) => pt.late && this.visible(pt));
		if (late.length) {
			el.createDiv({ cls: "gtodo-subhead mod-warning", text: `間に合わない見込み: ${late.length} 件` });
			for (const pt of late) this.row(el, pt);
		}
	}

	private renderPriority(el: HTMLElement, r: ScheduleResult): void {
		const list = r.ordered.filter((pt) => this.visible(pt));
		if (!list.length) el.createDiv({ cls: "gtodo-empty", text: "予定中のタスクはありません" });
		for (const pt of list) this.row(el, pt);
		const done = this.all(r).filter((pt) => pt.state === "done");
		if (done.length) {
			const d = el.createEl("details", { cls: "gtodo-done" });
			d.createEl("summary", { text: `完了 ${done.length} 件` });
			for (const pt of done) this.row(d, pt);
		}
	}

	private renderExpired(el: HTMLElement, r: ScheduleResult): void {
		const dead = this.all(r).filter((pt) => isDead(pt.state));
		if (!dead.length) {
			el.createDiv({ cls: "gtodo-empty", text: "期限切れ・実行不能なタスクはありません" });
			return;
		}
		const head = el.createDiv({ cls: "gtodo-subhead" });
		head.createSpan({ text: `${dead.length} 件` });
		const btn = head.createEl("button", { cls: "mod-warning", text: "すべて削除" });
		btn.onclick = () => this.plugin.confirmDelete(dead.map((pt) => pt.task.path));
		for (const pt of dead) {
			const row = this.row(el, pt);
			const del = row.createEl("button", { cls: "gtodo-del clickable-icon", attr: { "aria-label": "削除" } });
			setIcon(del, "trash-2");
			del.onclick = (e) => {
				e.stopPropagation();
				this.plugin.confirmDelete([pt.task.path]);
			};
		}
	}

	private renderInbox(el: HTMLElement, r: ScheduleResult): void {
		const items = this.all(r).filter((pt) => pt.state === "inbox" || pt.state === "cycle");
		if (!items.length) el.createDiv({ cls: "gtodo-empty", text: "未設定のタスクはありません" });
		for (const pt of items) {
			const row = this.row(el, pt);
			if (pt.state !== "inbox") continue;
			const suggested = pt.task.suggestedEstimate;
			const setEstimate = async (n: number) => {
				await this.plugin.repo.update(pt.task.path, (fm) => {
					fm.estimate = n;
				});
				new Notice(`「${pt.task.title}」の所要時間を ${n} 分にしました`);
			};
			const input = row.createEl("input", {
				cls: "gtodo-estimate",
				type: "number",
				attr: { placeholder: suggested != null ? `推定${suggested}` : "分", min: "0" },
			});
			input.onclick = (e) => e.stopPropagation();
			input.onkeydown = async (e) => {
				if (e.key !== "Enter" || e.isComposing) return;
				const n = Number(input.value);
				if (!input.value.trim() || !Number.isFinite(n) || n < 0) return;
				await setEstimate(n);
			};
			if (suggested != null) {
				const adopt = row.createEl("button", {
					cls: "gtodo-adopt clickable-icon",
					attr: { "aria-label": `推定値 ${formatMinutes(suggested)} を採用` },
				});
				setIcon(adopt, "check");
				adopt.onclick = async (e) => {
					e.stopPropagation();
					await setEstimate(suggested);
				};
			}
		}
	}

	private row(parent: HTMLElement, pt: PlannedTask, lead?: string): HTMLElement {
		const t = pt.task;
		const row = parent.createDiv({ cls: "gtodo-row" });
		if (pt.late) row.addClass("is-late");
		if (pt.state === "done") row.addClass("is-done");

		const cb = row.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox" });
		cb.checked = t.status === "done";
		cb.onclick = (e) => e.stopPropagation();
		cb.onchange = () => this.plugin.repo.setStatus(t.path, cb.checked ? "done" : "todo");

		const main = row.createDiv({ cls: "gtodo-main" });
		const title = main.createDiv({ cls: "gtodo-title" });
		if (pt.rank != null) title.createSpan({ cls: "gtodo-rank", text: `${pt.rank}` });
		title.createSpan({ cls: `gtodo-game gtodo-game-${t.game}`, text: GAME_LABEL[t.game] });
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

		const meta: string[] = [];
		if (lead) meta.push(lead);
		meta.push(KIND_LABEL[t.kind]);
		if (t.deadline != null) meta.push(`期限 ${formatShort(t.deadline)}`);
		if (pt.state === "active") {
			meta.push(
				pt.totalMinutes !== (t.remaining ?? t.estimate ?? 0)
					? `前提込み ${formatMinutes(pt.totalMinutes)}`
					: formatMinutes(pt.totalMinutes),
			);
			if (!lead && pt.plannedEnd != null) meta.push(`完了予定 ${formatShort(pt.plannedEnd)}`);
			if (pt.slack != null) meta.push(`余裕 ${formatSpan(pt.slack)}`);
		}
		main.createDiv({ cls: "gtodo-meta", text: meta.join(" ・ ") });
		if (pt.reasons.length) main.createDiv({ cls: "gtodo-reason", text: pt.reasons.join(" / ") });

		row.onclick = () => this.app.workspace.openLinkText(t.path, "", false);
		return row;
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const b = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.onclick = onClick;
	}
}
