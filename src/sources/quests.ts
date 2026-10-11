import { Game } from "../model";
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

/** Chains entries in the given order: each one requires the previous. */
export function chain(entries: QuestEntry[]): void {
	for (let i = 1; i < entries.length; i++) entries[i].prereqSourceIds.push(entries[i - 1].sourceId);
}
