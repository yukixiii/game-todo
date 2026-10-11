import { chain, questCatalog, QuestCatalog, QuestDetail, QuestEntry } from "./quests";
import { FetchJson } from "./types";

/** Project Amber (yatta.moe) quest archive, extracted from game data. */
export const GENSHIN_QUEST_LIST_URL = "https://gi.yatta.moe/api/v2/jp/quest";

const SERIES: Record<string, string> = { aq: "魔神任務", lq: "伝説任務", wq: "世界任務", eq: "イベント任務" };

interface Chapter {
	id: number;
	type: string | null;
	chapterNum: string | null;
	chapterTitle: string | null;
	chapterIcon: string | null;
}

/** "#{MATEAVATAR#...}たち" style placeholders -> "旅人". */
function cleanText(s: string): string {
	return s.replace(/#\{[^}]*\}/g, "旅人").replace(/\s+/g, " ").trim();
}

/**
 * Archon quests are chained by id within a chapter (11xx, 12xx ...); the first act of a chapter
 * requires the last non-間章 act of the previous chapter. Legend quests are chained per character.
 */
export function parseGenshinQuestList(json: unknown): QuestEntry[] {
	const items = (json as { data?: { items?: Record<string, Chapter> } })?.data?.items;
	if (!items) throw new Error("原神の任務一覧の形式が不正です");
	const chapters = Object.values(items)
		.filter((c) => c.type && SERIES[c.type] && c.chapterTitle)
		.sort((a, b) => a.id - b.id);
	const byId = new Map<number, QuestEntry>();
	for (const c of chapters) {
		byId.set(c.id, {
			sourceId: `yatta-quest:${c.id}`,
			game: "genshin",
			title: cleanText(c.chapterTitle!),
			series: SERIES[c.type!],
			label: cleanText(c.chapterNum ?? ""),
			prereqSourceIds: [],
			detailUrl: `${GENSHIN_QUEST_LIST_URL}/${c.id}`,
			pageUrl: `https://gi.yatta.moe/jp/archive/quest/${c.id}`,
		});
	}

	const groups = new Map<string, Chapter[]>();
	for (const c of chapters) {
		const key = c.type === "aq" ? `aq:${Math.floor(c.id / 100)}` : c.type === "lq" ? `lq:${c.chapterIcon}` : "";
		if (key) groups.set(key, [...(groups.get(key) ?? []), c]);
	}
	let prevArchon: Chapter[] | undefined;
	for (const [key, list] of groups) {
		chain(list.map((c) => byId.get(c.id)!));
		if (!key.startsWith("aq:")) continue;
		const lastMain = prevArchon?.filter((c) => !(c.chapterNum ?? "").startsWith("間章")).pop();
		if (lastMain) byId.get(list[0].id)!.prereqSourceIds.unshift(byId.get(lastMain.id)!.sourceId);
		prevArchon = list;
	}
	return chapters.map((c) => byId.get(c.id)!);
}

interface DetailResponse {
	data?: {
		storyList?: Record<string, { info?: { title?: string; description?: string }; story?: Record<string, unknown> }>;
	};
}

/**
 * Play time from the step count, fitted (log-log least squares) to the per-act times on
 * wikiwiki.jp/genshinwiki for 46 archon quest acts (2026-10; leave-one-out median error about ×1.2).
 * Those times assume auto-played voices and some detours. Other quest types are extrapolated.
 */
export function genshinQuestMinutes(steps: number): number | undefined {
	return steps > 0 ? 17.2 * steps ** 0.56 : undefined;
}

export function parseGenshinQuestDetail(json: unknown): QuestDetail {
	const stories = Object.values((json as DetailResponse)?.data?.storyList ?? {});
	const description = stories[0]?.info?.description;
	const steps = stories.reduce((n, s) => n + Object.keys(s.story ?? {}).length, 0);
	return {
		steps,
		minutes: genshinQuestMinutes(steps),
		basis: steps ? `手順数 ${steps}（魔神任務の実測時間から求めた式）` : undefined,
		description: description ? cleanText(description) : undefined,
		parts: stories.map((s) => cleanText(s.info?.title ?? "")).filter(Boolean),
	};
}

export function genshinQuestCatalog(fetchJson: FetchJson): QuestCatalog {
	return questCatalog(fetchJson, "genshin", "原神 任務（Project Amber）", GENSHIN_QUEST_LIST_URL, {
		parseList: parseGenshinQuestList,
		parseDetail: parseGenshinQuestDetail,
	});
}
