import { Game, GAME_LABEL } from "../model";
import { FetchJson, ImportedEvent } from "./types";

/** One importable quest (Genshin chapter/act, Wuthering Waves story). */
export interface QuestEntry {
	sourceId: string;
	game: Game;
	/** Quest name as written in conditions (「…」), so event prerequisites can link to it. */
	title: string;
	/** "魔神任務" / "潮汐任務" ... */
	series: string;
	/** "序章 第一幕" ... */
	label: string;
	/** Previous quest(s) in the same chain, derived from the catalog order. */
	prereqSourceIds: string[];
	detailUrl: string;
	/** Human-readable page of the quest on the data site. */
	pageUrl: string;
	/** Extra searchable words that are not shown (English name, character name ...). */
	keywords?: string[];
}

export interface QuestDetail {
	/** Number of quest steps. */
	steps: number;
	description?: string;
	/** Sub-quest names, listed in the note body. */
	parts: string[];
	/** Play time predicted from the detail (minutes, unrounded, before the user's scale). */
	minutes?: number;
	/** What the prediction was based on, written to the note ("手順数 68" ...). */
	basis?: string;
}

export interface QuestCatalog {
	game: Game;
	label: string;
	list(): Promise<QuestEntry[]>;
	detail(e: QuestEntry): Promise<QuestDetail>;
}

export interface QuestParsers {
	parseList(json: unknown): QuestEntry[];
	parseDetail(json: unknown): QuestDetail;
}

export function questCatalog(
	fetchJson: FetchJson,
	game: Game,
	label: string,
	listUrl: string,
	p: QuestParsers,
): QuestCatalog {
	return {
		game,
		label,
		list: async () => p.parseList(await fetchJson(listUrl)),
		detail: async (e) => p.parseDetail(await fetchJson(e.detailUrl)),
	};
}

/** Applies the user's pace (1 = wiki pace) and rounds to 5 minutes, minimum 5. */
export function scaleEstimate(minutes: number | undefined, scale: number): number | undefined {
	if (!minutes || minutes <= 0 || scale <= 0) return undefined;
	return Math.max(5, Math.round((minutes * scale) / 5) * 5);
}

export function questToImported(e: QuestEntry, d: QuestDetail | undefined): ImportedEvent {
	const lines = [`${e.series} ${e.label}`.trim(), ""];
	if (d?.description) lines.push(d.description, "");
	if (d?.parts.length && !(d.parts.length === 1 && d.parts[0] === e.title)) {
		lines.push("## 構成", ...d.parts.map((p) => `- ${p}`), "");
	}
	return {
		sourceId: e.sourceId,
		game: e.game,
		title: e.title,
		kind: "quest",
		catalog: true,
		prereqSourceIds: e.prereqSourceIds,
		url: e.pageUrl,
		suggestedEstimate: d?.minutes,
		estimateBasis: d?.basis,
		body: lines.join("\n"),
	};
}

/** Text searched by the quest picker. */
export function questHaystack(e: QuestEntry): string {
	return [e.title, e.label, e.series, GAME_LABEL[e.game], ...(e.keywords ?? [])].join("\n");
}

const KANJI_DIGITS = "一二三四五六七八九";

/** "三" / "十二" / "二十" / "3" / "３" -> number. */
function parseNumber(s: string): number | undefined {
	if (/^\d+$/.test(s)) return Number(s);
	const m = s.match(/^([一二三四五六七八九])?(十)?([一二三四五六七八九])?$/);
	if (!m || !s) return undefined;
	const digit = (c?: string) => (c ? KANJI_DIGITS.indexOf(c) + 1 : 0);
	if (!m[2]) return m[3] ? undefined : digit(m[1]);
	return (m[1] ? digit(m[1]) : 1) * 10 + digit(m[3]);
}

export const EPILOGUE_RANK = 1000;

const UPPER_MIDDLE_LOWER: Record<string, number> = { 上: 1, 中: 2, 下: 3 };

/**
 * Story position of an ordinal word: 序章 = 0, 第三章 / 第三首 / 其の三 / 三日目 / 3ページ目 / プレゼント3 / 三 / 3 = 3,
 * 上 / 中 / 下 = 1 / 2 / 3, 最終章 = 900, エピローグ / 後日談 / おまけページ = 1000. Undefined when the word is
 * not an ordinal.
 */
export function ordinalRank(word: string): number | undefined {
	const w = word.normalize("NFKC").replace(/[!?！？]+$/, "").trim();
	if (/^(序章|序曲|序幕|プロローグ)$/.test(w)) return 0;
	if (/^(終|終章|最終章|最終幕)$/.test(w)) return 900;
	if (/^(エピローグ|後日談|おまけページ)$/.test(w)) return EPILOGUE_RANK;
	if (UPPER_MIDDLE_LOWER[w]) return UPPER_MIDDLE_LOWER[w];
	const m = w.match(/^(?:第(.+?)(?:章|幕|話|首|回|部|ラウンド)|其の(.+)|(.+?)(?:日目|ページ目)|[ァ-ヶー]+(\d+)|(.+))$/);
	return m ? parseNumber(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]) : undefined;
}

/**
 * "諧律のカンティクル·第一章" -> { base: "諧律のカンティクル", rank: 1 }. Splits at the last separator
 * (・, the U+00B7 middle dot used in game data, or a space), since names can contain ・ themselves.
 * "…童話の王国！1ページ目" has no separator before the page number.
 */
export function splitOrdinal(name: string): { base: string; rank: number } | undefined {
	const m = name.trim().match(/^(.*\S)[\s・·]+([^\s・·]+)$/) ?? name.trim().match(/^(.*\S)(\d+ページ目|おまけページ)$/);
	if (!m) return undefined;
	const rank = ordinalRank(m[2]);
	return rank == null ? undefined : { base: m[1], rank };
}

/** Chains entries in the given order: each one requires the previous. */
export function chain(entries: QuestEntry[]): void {
	for (let i = 1; i < entries.length; i++) entries[i].prereqSourceIds.push(entries[i - 1].sourceId);
}
