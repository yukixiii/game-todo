import { App, PluginSettingTab, Setting } from "obsidian";
import type GameTodoPlugin from "./main";
import { Game, GAME_LABEL, GAMES } from "./model";
import { ServerClock } from "./recurrence";
import { Capacity } from "./scheduler";
import { WUWA_NOTICE_URL } from "./sources/wuwa";

export interface GameSettings extends ServerClock {
	/** JSON feed URL for importing events (used for games without a built-in source). */
	feedUrl: string;
	/**
	 * Multiplier for suggested estimates of imported quests/events. 1 = the wiki pace the quest
	 * formulas were fitted to (voices played, no skipping).
	 */
	estimateScale: number;
}

export interface GameTodoSettings {
	rootFolder: string;
	capacity: Capacity;
	horizonDays: number;
	games: Record<Game, GameSettings>;
	genshinImport: boolean;
	genshinExcludeKeywords: string[];
	wuwaImport: boolean;
	/** Override for the notice JSON; empty = built-in default, so updates to the default reach existing installs. */
	wuwaNoticeUrl: string;
	wuwaExcludeKeywords: string[];
	autoDeleteExpiredRecurring: boolean;
}

export const DEFAULT_SETTINGS: GameTodoSettings = {
	rootFolder: "GameTodo",
	capacity: { weekday: 60, weekend: 180, perDay: [null, null, null, null, null, null, null], playStartHour: 20 },
	horizonDays: 180,
	games: {
		genshin: { utcOffset: 8, resetHour: 4, weeklyResetDay: 1, feedUrl: "", estimateScale: 1 },
		wuwa: { utcOffset: 8, resetHour: 4, weeklyResetDay: 1, feedUrl: "", estimateScale: 1 },
	},
	genshinImport: true,
	genshinExcludeKeywords: ["祈願", "チャージ", "アンケート"],
	wuwaImport: true,
	wuwaNoticeUrl: "",
	wuwaExcludeKeywords: ["パック", "アンケート"],
	autoDeleteExpiredRecurring: true,
};

export function mergeSettings(saved: Partial<GameTodoSettings> | null): GameTodoSettings {
	const s = saved ?? {};
	const game = (g: Game): GameSettings => {
		// minutesPerStep was replaced by estimateScale.
		const { minutesPerStep: _, ...rest } = (s.games?.[g] ?? {}) as Partial<GameSettings> & { minutesPerStep?: unknown };
		return { ...DEFAULT_SETTINGS.games[g], ...rest };
	};
	return {
		...DEFAULT_SETTINGS,
		...s,
		capacity: { ...DEFAULT_SETTINGS.capacity, ...s.capacity },
		games: { genshin: game("genshin"), wuwa: game("wuwa") },
	};
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function numberSetting(
	el: HTMLElement,
	name: string,
	desc: string,
	get: () => number,
	set: (n: number) => void,
	opts: { min?: number; max?: number; step?: number } = {},
): Setting {
	return new Setting(el)
		.setName(name)
		.setDesc(desc)
		.addText((t) => {
			t.inputEl.type = "number";
			if (opts.min != null) t.inputEl.min = String(opts.min);
			if (opts.max != null) t.inputEl.max = String(opts.max);
			if (opts.step != null) t.inputEl.step = String(opts.step);
			t.setValue(String(get())).onChange((v) => {
				const n = Number(v);
				if (v.trim() !== "" && Number.isFinite(n)) set(n);
			});
		});
}

export class GameTodoSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: GameTodoPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl)
			.setName("保存フォルダ")
			.setDesc("タスク・テンプレート・Inbox を作成するフォルダ")
			.addText((t) =>
				t.setValue(s.rootFolder).onChange(async (v) => {
					s.rootFolder = v.trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.rootFolder;
					await save();
				}),
			);

		new Setting(containerEl).setName("プレイ時間").setHeading();
		numberSetting(containerEl, "平日（分）", "月〜金に遊べる時間", () => s.capacity.weekday, async (n) => {
			s.capacity.weekday = Math.max(0, n);
			await save();
		});
		numberSetting(containerEl, "休日（分）", "土日に遊べる時間", () => s.capacity.weekend, async (n) => {
			s.capacity.weekend = Math.max(0, n);
			await save();
		});
		numberSetting(
			containerEl,
			"プレイ開始時刻",
			"毎日遊び始める時刻（時、例: 20 または 21.5）。その日の時間枠はここから始まります",
			() => s.capacity.playStartHour,
			async (n) => {
				s.capacity.playStartHour = Math.min(23.99, Math.max(0, n));
				await save();
			},
			{ min: 0, max: 23.5, step: 0.5 },
		);
		new Setting(containerEl)
			.setName("曜日ごとの上書き（分）")
			.setDesc("空欄なら平日/休日の値を使います")
			.then((setting) => {
				const perDay = (s.capacity.perDay ??= [null, null, null, null, null, null, null]);
				WEEKDAYS.forEach((label, i) => {
					setting.addText((t) => {
						t.inputEl.type = "number";
						t.inputEl.addClass("gtodo-perday");
						t.setPlaceholder(label)
							.setValue(perDay[i] != null ? String(perDay[i]) : "")
							.onChange(async (v) => {
								perDay[i] = v.trim() === "" ? null : Math.max(0, Number(v) || 0);
								await save();
							});
					});
				});
			});
		numberSetting(containerEl, "計画期間（日）", "この日数先までスケジュールを計算します", () => s.horizonDays, async (n) => {
			s.horizonDays = Math.max(1, Math.round(n));
			await save();
		});

		for (const game of GAMES) {
			const g = s.games[game];
			new Setting(containerEl).setName(`${GAME_LABEL[game]} サーバー`).setHeading();
			numberSetting(containerEl, "UTC オフセット（時）", "アジアサーバーは 8", () => g.utcOffset, async (n) => {
				g.utcOffset = n;
				await save();
			});
			numberSetting(containerEl, "デイリーリセット（サーバー時刻）", "通常 4", () => g.resetHour, async (n) => {
				g.resetHour = Math.min(23, Math.max(0, Math.round(n)));
				await save();
			});
			new Setting(containerEl)
				.setName("週リセット曜日")
				.setDesc("rule: weekly（曜日指定なし）で使う曜日")
				.addDropdown((d) => {
					WEEKDAYS.forEach((w, i) => d.addOption(String(i), w));
					d.setValue(String(g.weeklyResetDay)).onChange(async (v) => {
						g.weeklyResetDay = Number(v);
						await save();
					});
				});
			numberSetting(
				containerEl,
				"推定所要時間の倍率",
				"取り込んだ任務・イベントの推定値に掛ける倍率。1 は有志 wiki の目安（ボイスを聞きながら進めるペース）で、会話をよく飛ばすなら 0.5 程度。推定値は Inbox に表示されるだけで、採用するまでスケジュールには使いません",
				() => g.estimateScale,
				async (n) => {
					g.estimateScale = Math.max(0, n);
					await save();
				},
				{ min: 0, step: 0.1 },
			);
			new Setting(containerEl)
				.setName("イベント JSON フィード URL")
				.setDesc('任意。[{"id","title","start","end"}] 形式の JSON を取り込みます')
				.addText((t) =>
					t.setValue(g.feedUrl).onChange(async (v) => {
						g.feedUrl = v.trim();
						await save();
					}),
				);
		}

		new Setting(containerEl).setName("取り込み・自動処理").setHeading();
		new Setting(containerEl)
			.setName("原神のゲーム内お知らせから取り込む")
			.setDesc("HoYoverse の非公式 API を利用します。仕様変更で動かなくなる可能性があります")
			.addToggle((t) =>
				t.setValue(s.genshinImport).onChange(async (v) => {
					s.genshinImport = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("原神: 除外キーワード")
			.setDesc("タイトルにこれらを含むお知らせは取り込みません（カンマ区切り）")
			.addText((t) =>
				t.setValue(s.genshinExcludeKeywords.join(", ")).onChange(async (v) => {
					s.genshinExcludeKeywords = v.split(/[,、]/).map((k) => k.trim()).filter(Boolean);
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("鳴潮のゲーム内お知らせから取り込む")
			.setDesc("Kuro Games の公開 JSON を利用します。仕様変更で動かなくなる可能性があります")
			.addToggle((t) =>
				t.setValue(s.wuwaImport).onChange(async (v) => {
					s.wuwaImport = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("鳴潮: お知らせ JSON URL")
			.setDesc("取得できなくなったときに差し替えます（空欄で既定値）")
			.addText((t) =>
				t
					.setPlaceholder(WUWA_NOTICE_URL)
					.setValue(s.wuwaNoticeUrl)
					.onChange(async (v) => {
						s.wuwaNoticeUrl = v.trim();
						await save();
					}),
			);
		new Setting(containerEl)
			.setName("鳴潮: 除外キーワード")
			.setDesc("タイトルにこれらを含むお知らせは取り込みません（カンマ区切り）")
			.addText((t) =>
				t.setValue(s.wuwaExcludeKeywords.join(", ")).onChange(async (v) => {
					s.wuwaExcludeKeywords = v.split(/[,、]/).map((k) => k.trim()).filter(Boolean);
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("期限切れの繰り返しタスクを自動削除")
			.setDesc("日課・週課などのインスタンスが期限切れになったらゴミ箱へ移動します")
			.addToggle((t) =>
				t.setValue(s.autoDeleteExpiredRecurring).onChange(async (v) => {
					s.autoDeleteExpiredRecurring = v;
					await save();
				}),
			);
	}
}
