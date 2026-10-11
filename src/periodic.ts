import { Game } from "./model";

/**
 * Built-in recurring content that resets on a fixed schedule, offered by the "周期コンテンツを取り込む"
 * command as recurring templates. Schedules were taken from the fan wikis (wikiwiki.jp) on 2026-10-12;
 * times are server time (reset 04:00 at UTC+8 = 05:00 JST), so the rules below use the game's reset hour.
 *
 * Content whose period follows the version schedule instead (Genshin 幽境の激戦, Wuthering Waves
 * 終焉マトリクス) cannot be expressed as a rule; it is announced in-game and comes in through the event import.
 */
export interface PeriodicPreset {
	/** Stable id, saved as `source: "preset:<id>"` on the template. */
	id: string;
	game: Game;
	title: string;
	/** Recurrence rule (see recurrence.ts). */
	rule: string;
	/** Default estimate in minutes; the user confirms it before the template is created. */
	estimate: number;
	/** Human-readable schedule, shown in the dialog and the note. */
	schedule: string;
	url: string;
}

export const PERIODIC_PRESETS: PeriodicPreset[] = [
	{
		id: "genshin-abyss",
		game: "genshin",
		title: "深境螺旋",
		rule: "monthly:16",
		estimate: 60,
		schedule: "毎月16日 05:00（JST）に更新",
		url: "https://wikiwiki.jp/genshinwiki/%E6%B7%B1%E5%A2%83%E8%9E%BA%E6%97%8B",
	},
	{
		id: "genshin-theater",
		game: "genshin",
		title: "幻想シアター",
		rule: "monthly:1",
		estimate: 90,
		schedule: "毎月1日 05:00（JST）に更新",
		url: "https://wikiwiki.jp/genshinwiki/%E5%B9%BB%E6%83%B3%E3%82%B7%E3%82%A2%E3%82%BF%E3%83%BC",
	},
	{
		id: "genshin-weekly-boss",
		game: "genshin",
		title: "週ボス",
		rule: "weekly",
		estimate: 30,
		schedule: "毎週（週リセット曜日の設定）に更新",
		url: "https://wikiwiki.jp/genshinwiki/::cmd/search?word=%E9%80%B1%E3%83%9C%E3%82%B9",
	},
	{
		id: "wuwa-tower",
		game: "wuwa",
		title: "逆境深塔",
		rule: "interval:28@2026-09-14",
		estimate: 45,
		schedule: "4週間ごとに更新（2026-09-14 起点）",
		url: "https://wikiwiki.jp/w-w/%E9%80%86%E5%A2%83%E6%B7%B1%E5%A1%94",
	},
	{
		id: "wuwa-ruins",
		game: "wuwa",
		title: "死の歌が纏う海の廃墟",
		rule: "interval:28@2026-09-28",
		estimate: 45,
		schedule: "4週間ごとに更新（2026-09-28 起点、逆境深塔と交互）",
		url: "https://wikiwiki.jp/w-w/%E6%AD%BB%E3%81%AE%E6%AD%8C%E3%81%8C%E7%BA%8F%E3%81%86%E6%B5%B7%E3%81%AE%E5%BB%83%E5%A2%9F",
	},
	{
		id: "wuwa-weekly-boss",
		game: "wuwa",
		title: "週間ボス",
		rule: "weekly",
		estimate: 15,
		schedule: "毎週（週リセット曜日の設定）に更新",
		url: "https://wikiwiki.jp/w-w/::cmd/search?word=%E9%80%B1%E9%96%93%E3%83%9C%E3%82%B9",
	},
];

export function presetSource(p: PeriodicPreset): string {
	return `preset:${p.id}`;
}
