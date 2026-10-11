import { App, Modal, Notice, Setting } from "obsidian";
import { Game, GAME_LABEL, GAMES, Kind, KIND_LABEL, KINDS, NewTaskFields } from "../model";
import { PeriodicPreset } from "../periodic";
import { QuestEntry } from "../sources/quests";
import { ImportedEvent } from "../sources/types";
import { formatShort, parseDate } from "../time";

/** "2026-10-15T11:00" for <input type=datetime-local>. */
function toLocalInput(ms: number | undefined): string {
	if (ms == null) return "";
	const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
	return d.toISOString().slice(0, 16);
}

export interface TaskFormResult extends NewTaskFields {
	title: string;
}

export class TaskModal extends Modal {
	private f: TaskFormResult = { title: "", game: "genshin", kind: "event", prereqLinks: [] };

	constructor(
		app: App,
		/** Titles of existing tasks offered as prerequisites. */
		private taskTitles: string[],
		private onSubmit: (r: TaskFormResult) => Promise<void>,
		initial?: Partial<TaskFormResult>,
	) {
		super(app);
		Object.assign(this.f, initial);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("ゲームタスクを追加");
		const f = this.f;

		new Setting(contentEl).setName("タイトル").addText((t) => {
			t.setValue(f.title).onChange((v) => (f.title = v));
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(contentEl)
			.setName("ゲーム / 種類")
			.addDropdown((d) => {
				GAMES.forEach((g) => d.addOption(g, GAME_LABEL[g]));
				d.setValue(f.game).onChange((v) => (f.game = v as Game));
			})
			.addDropdown((d) => {
				KINDS.forEach((k) => d.addOption(k, KIND_LABEL[k]));
				d.setValue(f.kind).onChange((v) => (f.kind = v as Kind));
			});
		const dateSetting = (name: string, desc: string, key: "start" | "deadline") =>
			new Setting(contentEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) => {
					t.inputEl.type = "datetime-local";
					t.setValue(toLocalInput(f[key])).onChange((v) => (f[key] = parseDate(v)));
				});
		dateSetting("開始", "任意。この時刻より前には予定しません", "start");
		dateSetting("期限", "イベント終了日時（ローカル時刻）", "deadline");
		new Setting(contentEl)
			.setName("所要時間（分）")
			.setDesc("空欄なら Inbox 扱い（スケジュール対象外）")
			.addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.min = "0";
				t.setValue(f.estimate != null ? String(f.estimate) : "").onChange((v) => {
					f.estimate = v.trim() === "" ? undefined : Math.max(0, Number(v) || 0);
				});
			});

		const prereqSetting = new Setting(contentEl).setName("前提任務");
		const chips = contentEl.createDiv({ cls: "gtodo-chips" });
		const renderChips = () => {
			chips.empty();
			for (const link of f.prereqLinks ?? []) {
				const chip = chips.createSpan({ cls: "gtodo-chip", text: link.replace(/^\[\[|\]\]$/g, "") });
				chip.createSpan({ cls: "gtodo-chip-x", text: "×" }).onclick = () => {
					f.prereqLinks = f.prereqLinks!.filter((l) => l !== link);
					renderChips();
				};
			}
		};
		const listId = `gtodo-titles-${Date.now()}`;
		const datalist = contentEl.createEl("datalist", { attr: { id: listId } });
		for (const t of this.taskTitles) datalist.createEl("option", { value: t });
		prereqSetting.addText((t) => {
			t.setPlaceholder("既存タスク名を入力して Enter");
			t.inputEl.setAttr("list", listId);
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key !== "Enter" || e.isComposing) return;
				e.preventDefault();
				const v = t.getValue().trim();
				if (!v) return;
				const link = `[[${v}]]`;
				if (!f.prereqLinks!.includes(link)) f.prereqLinks!.push(link);
				t.setValue("");
				renderChips();
			});
		});
		renderChips();

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("作成")
				.setCta()
				.onClick(async () => {
					if (!f.title.trim()) {
						new Notice("タイトルを入力してください");
						return;
					}
					if (f.start != null && f.deadline != null && f.start >= f.deadline) {
						new Notice("開始は期限より前にしてください");
						return;
					}
					await this.onSubmit({ ...f, title: f.title.trim() });
					this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private items: string[],
		private confirmText: string,
		private onConfirm: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		const ul = this.contentEl.createEl("ul", { cls: "gtodo-confirm-list" });
		for (const i of this.items) ul.createEl("li", { text: i });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setWarning()
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface ImportCandidate {
	event: ImportedEvent;
	/** Path of an already imported note with the same source id. */
	existing?: string;
	/** True when the existing note's deadline differs from the source. */
	changed?: boolean;
}

export class ImportModal extends Modal {
	private selected = new Set<string>();

	constructor(
		app: App,
		private candidates: ImportCandidate[],
		private errors: string[],
		private onImport: (chosen: ImportCandidate[]) => Promise<void>,
	) {
		super(app);
		for (const c of candidates) if (!c.existing || c.changed) this.selected.add(c.event.sourceId);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("イベントを取り込む");
		for (const e of this.errors) contentEl.createDiv({ cls: "gtodo-error", text: e });
		if (!this.candidates.length) {
			contentEl.createDiv({ text: "取り込めるイベントはありません。" });
			return;
		}
		contentEl.createDiv({
			cls: "setting-item-description",
			text: "新規は Inbox に作成されます（所要時間を入力するとスケジュール対象になります）。登録済みは期限・未記入の参加条件・未確定の推定所要時間のみ更新します。",
		});
		const list = contentEl.createDiv({ cls: "gtodo-import-list" });
		for (const c of this.candidates) {
			const row = list.createEl("label", { cls: "gtodo-import-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = this.selected.has(c.event.sourceId);
			cb.onchange = () => (cb.checked ? this.selected.add(c.event.sourceId) : this.selected.delete(c.event.sourceId));
			const body = row.createDiv();
			body.createDiv({ text: `[${GAME_LABEL[c.event.game]}] ${c.event.title}` });
			const meta = [
				c.event.start != null ? `開始 ${formatShort(c.event.start)}` : "",
				c.event.end != null ? `終了 ${formatShort(c.event.end)}` : "",
				c.event.suggestedEstimate != null ? `推定 ${c.event.suggestedEstimate} 分` : "",
				c.existing ? (c.changed ? "登録済み・更新あり" : "登録済み") : "新規",
			].filter(Boolean);
			body.createDiv({ cls: "gtodo-meta", text: meta.join(" ・ ") });
			if (c.event.conditions?.length) {
				body.createDiv({ cls: "gtodo-meta", text: `条件: ${c.event.conditions.join(" / ")}` });
			}
		}
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("取り込む")
				.setCta()
				.onClick(async () => {
					this.close();
					await this.onImport(this.candidates.filter((c) => this.selected.has(c.event.sourceId)));
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

const QUEST_ROW_LIMIT = 300;

/** Picks quests from the Genshin / Wuthering Waves catalogs, filtered by series and keyword. */
export class QuestImportModal extends Modal {
	private selected = new Set<string>();
	private series = "";
	private query = "";

	constructor(
		app: App,
		private entries: QuestEntry[],
		/** Source ids that already have a note -> whether its estimate is confirmed. */
		private existing: Map<string, boolean>,
		private errors: string[],
		private onImport: (chosen: QuestEntry[]) => Promise<void>,
	) {
		super(app);
	}

	private seriesKey(e: QuestEntry): string {
		return `${GAME_LABEL[e.game]} ${e.series}`;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("任務を取り込む");
		for (const e of this.errors) contentEl.createDiv({ cls: "gtodo-error", text: e });
		if (!this.entries.length) {
			contentEl.createDiv({ text: "取り込める任務はありません。" });
			return;
		}
		contentEl.createDiv({
			cls: "setting-item-description",
			text: "選んだ任務を Inbox に作成します。前後の任務が登録済みか同時に取り込む場合は前提任務としてリンクします。所要時間は手順数や会話量からの推定値を表示するので、確認して確定してください。",
		});
		const keys = [...new Set(this.entries.map((e) => this.seriesKey(e)))];
		this.series = keys[0] ?? "";
		const count = contentEl.createDiv({ cls: "gtodo-meta" });
		const list = contentEl.createDiv({ cls: "gtodo-import-list" });
		const render = () => {
			list.empty();
			const q = this.query.trim();
			const shown = this.entries.filter(
				(e) =>
					(!this.series || this.seriesKey(e) === this.series) &&
					(!q || e.title.includes(q) || e.label.includes(q)),
			);
			for (const e of shown.slice(0, QUEST_ROW_LIMIT)) {
				const row = list.createEl("label", { cls: "gtodo-import-row" });
				const cb = row.createEl("input", { type: "checkbox" });
				// Confirmed notes are locked; unconfirmed ones can be picked again to refresh the suggested estimate.
				const done = this.existing.get(e.sourceId) === true;
				const refresh = this.existing.get(e.sourceId) === false;
				cb.checked = done || this.selected.has(e.sourceId);
				cb.disabled = done;
				cb.onchange = () => {
					if (cb.checked) this.selected.add(e.sourceId);
					else this.selected.delete(e.sourceId);
					updateCount();
				};
				const body = row.createDiv();
				body.createDiv({ text: e.title });
				body.createDiv({
					cls: "gtodo-meta",
					text: [this.seriesKey(e), e.label, done ? "登録済み" : refresh ? "登録済み・選ぶと推定値を再計算" : ""]
						.filter(Boolean)
						.join(" ・ "),
				});
			}
			if (shown.length > QUEST_ROW_LIMIT) {
				list.createDiv({ cls: "gtodo-meta", text: `ほか ${shown.length - QUEST_ROW_LIMIT} 件（キーワードで絞り込んでください）` });
			}
		};
		const updateCount = () => count.setText(`${this.selected.size} 件選択中`);

		new Setting(contentEl)
			.setName("絞り込み")
			.addDropdown((d) => {
				d.addOption("", "すべて");
				for (const k of keys) d.addOption(k, k);
				d.setValue(this.series).onChange((v) => {
					this.series = v;
					render();
				});
			})
			.addText((t) =>
				t.setPlaceholder("キーワード").onChange((v) => {
					this.query = v;
					render();
				}),
			);
		contentEl.append(count, list);
		render();
		updateCount();

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("取り込む")
				.setCta()
				.onClick(async () => {
					const chosen = this.entries.filter((e) => this.selected.has(e.sourceId));
					if (!chosen.length) {
						new Notice("任務を選んでください");
						return;
					}
					this.close();
					await this.onImport(chosen);
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Lets the user pick built-in periodic content and confirm each estimate before templates are created. */
export class PeriodicImportModal extends Modal {
	private chosen = new Map<string, number | undefined>();

	constructor(
		app: App,
		private presets: PeriodicPreset[],
		/** Preset ids that already have a template. */
		private existing: Set<string>,
		private onImport: (chosen: { preset: PeriodicPreset; estimate?: number }[]) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("周期コンテンツを取り込む");
		contentEl.createDiv({
			cls: "setting-item-description",
			text: "選んだコンテンツの繰り返しテンプレートを作り、今期のタスクを作成します。所要時間は目安なので、必要なら直してから取り込んでください。期間がバージョンごとに変わるもの（幽境の激戦・終焉マトリクスなど）はお知らせに載るので、イベント取り込みで取り込めます。",
		});
		const list = contentEl.createDiv({ cls: "gtodo-import-list" });
		for (const p of this.presets) {
			const done = this.existing.has(p.id);
			const row = list.createDiv({ cls: "gtodo-import-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = done;
			cb.disabled = done;
			const body = row.createDiv({ cls: "gtodo-main" });
			body.createDiv({ text: `[${GAME_LABEL[p.game]}] ${p.title}` });
			body.createDiv({ cls: "gtodo-meta", text: [p.schedule, `rule: ${p.rule}`, done ? "登録済み" : ""].filter(Boolean).join(" ・ ") });
			const est = row.createEl("input", { type: "number", cls: "gtodo-estimate", attr: { min: "0", step: "5", "aria-label": "所要時間（分）" } });
			est.value = String(p.estimate);
			est.disabled = done;
			const sync = () => {
				const n = Number(est.value);
				if (cb.checked) this.chosen.set(p.id, est.value.trim() !== "" && Number.isFinite(n) && n > 0 ? n : undefined);
				else this.chosen.delete(p.id);
			};
			cb.onchange = sync;
			est.oninput = sync;
			row.createSpan({ cls: "gtodo-meta", text: "分" });
		}
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("取り込む")
				.setCta()
				.onClick(async () => {
					const chosen = this.presets
						.filter((p) => this.chosen.has(p.id))
						.map((p) => ({ preset: p, estimate: this.chosen.get(p.id) }));
					if (!chosen.length) {
						new Notice("コンテンツを選んでください");
						return;
					}
					this.close();
					await this.onImport(chosen);
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
