import { App, Modal, Notice, Setting } from "obsidian";
import { Game, GAME_LABEL, GAMES, Kind, KIND_LABEL, KINDS, NewTaskFields } from "../model";
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
			text: "新規は Inbox に作成されます（所要時間を入力するとスケジュール対象になります）。登録済みは期限のみ更新します。",
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
				c.existing ? (c.changed ? "登録済み・期限変更あり" : "登録済み") : "新規",
			].filter(Boolean);
			body.createDiv({ cls: "gtodo-meta", text: meta.join(" ・ ") });
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
