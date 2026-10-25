import { chain, EPILOGUE_RANK, questCatalog, QuestCatalog, QuestDetail, QuestEntry, splitOrdinal } from "./quests";
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
	chapterImageTitle?: string | null;
	route?: string | null;
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
			// English name, and the character (legend quests) or region shown on the chapter card.
			keywords: [c.route, c.chapterImageTitle].filter((k): k is string => !!k),
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
	chainSeries(chapters.filter((c) => c.type === "wq").map((c) => byId.get(c.id)!), false);
	chainSeries(chapters.filter((c) => c.type === "eq").map((c) => byId.get(c.id)!), true);
	return chapters.map((c) => byId.get(c.id)!);
}

type Member = { rank: number; e: QuestEntry };

/**
 * World / event quest series are named "<series>·第一章" in the chapter number, or "<series>·其の一" in the
 * title when there is no chapter number. Entries are chained in story order (ids do not follow it).
 * Siblings without an ordinal (お茶会への再招待・<character> ...) are left unchained, since they may be
 * played in any order. "<quest>·後日談" requires "<quest>" when exactly one quest of the type has that name.
 *
 * Repeated positions leave a world quest series unchained. Events reuse their names across years
 * (風花祭·1…4, then 風花祭·1…3), so with `splitEditions` a repeated position instead starts a new edition
 * (entries come in id order).
 */
function chainSeries(list: QuestEntry[], splitEditions: boolean): void {
	const byTitle = new Map<string, QuestEntry[]>();
	for (const e of list) byTitle.set(e.title, [...(byTitle.get(e.title) ?? []), e]);
	const groups = new Map<string, Member[]>();
	for (const e of list) {
		const s = splitOrdinal(e.label || e.title);
		if (!s) continue;
		groups.set(s.base, [...(groups.get(s.base) ?? []), { rank: s.rank, e }]);
		if (!e.label) e.label = s.base;
	}
	for (const [base, members] of groups) {
		for (const edition of splitEditions ? editions(members) : [members]) {
			edition.sort((a, b) => a.rank - b.rank);
			if (new Set(edition.map((m) => m.rank)).size < edition.length) continue;
			const entries = edition.map((m) => m.e);
			const main = byTitle.get(base);
			if (edition[0].rank === EPILOGUE_RANK && main?.length === 1) entries.unshift(main[0]);
			chain(entries);
		}
	}
}

/** Splits id-ordered members where a position repeats. */
function editions(members: Member[]): Member[][] {
	const out: Member[][] = [[]];
	for (const m of members) {
		if (out[out.length - 1].some((x) => x.rank === m.rank)) out.push([]);
		out[out.length - 1].push(m);
	}
	return out;
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
