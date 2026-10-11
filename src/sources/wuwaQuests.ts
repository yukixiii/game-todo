import { chain, questCatalog, QuestCatalog, QuestDetail, QuestEntry } from "./quests";
import { FetchJson } from "./types";

/** encore.moe story archive, extracted from game data. */
export const WUWA_STORY_LIST_URL = "https://api.encore.moe/ja/story";

/**
 * TypeId -> label. 潮汐任務 is chained across chapters, 連星任務 per character (Descrtption)
 * within a region group; 逸話任務 are independent.
 */
const TYPES: Record<string, string> = { "1": "潮汐任務", "2": "連星任務", "4": "逸話任務" };

interface Story {
	Id: number;
	Name: string;
	Descrtption?: string;
}

interface ListResponse {
	storyTypes?: { TypeId: string; Stories?: { Group: string; Stories?: Story[] }[] }[];
}

export function parseWuwaStoryList(json: unknown): QuestEntry[] {
	const types = (json as ListResponse)?.storyTypes;
	if (!Array.isArray(types)) throw new Error("鳴潮の任務一覧の形式が不正です");
	const out: QuestEntry[] = [];
	for (const t of types) {
		const series = TYPES[t.TypeId];
		if (!series) continue;
		let mainLine: QuestEntry[] = [];
		for (const g of t.Stories ?? []) {
			// Time-limited event quests are listed inside 潮汐任務 but are not part of the main line.
			if (g.Group.includes("イベント")) continue;
			const stories = (g.Stories ?? []).filter((s) => s.Name?.trim());
			const entries = stories.map((s) => ({
				sourceId: `encore-story:${s.Id}`,
				game: "wuwa" as const,
				title: s.Name.trim(),
				series,
				label: [g.Group, s.Descrtption && s.Descrtption !== g.Group ? s.Descrtption : ""]
					.filter(Boolean)
					.join(" "),
				prereqSourceIds: [] as string[],
				detailUrl: `${WUWA_STORY_LIST_URL}/${s.Id}`,
				pageUrl: `https://encore.moe/story/${s.Id}?lang=ja`,
			}));
			if (t.TypeId === "1") mainLine = mainLine.concat(entries);
			else if (t.TypeId === "2") {
				const byCharacter = new Map<string, QuestEntry[]>();
				stories.forEach((s, i) => {
					const key = s.Descrtption ?? "";
					byCharacter.set(key, [...(byCharacter.get(key) ?? []), entries[i]]);
				});
				byCharacter.forEach(chain);
			}
			out.push(...entries);
		}
		chain(mainLine);
	}
	return out;
}

interface DetailResponse {
	QuestDesc?: string;
	Chapters?: { Title?: string; Dialogues?: { Type?: string; PlotLineKey?: string }[] }[];
}

/**
 * Play time from the amount of dialogue text, fitted (log-log least squares) to the per-act times on
 * wikiwiki.jp/w-w for 42 潮汐任務 acts (2026-10; leave-one-out median error about ×1.16). Those times
 * are for listening to all voices without skipping. Falls back to the step count when there is no text.
 */
export function wuwaQuestMinutes(dialogueChars: number, steps: number): number | undefined {
	if (dialogueChars > 0) return 0.082 * dialogueChars ** 0.74;
	return steps > 0 ? 20.3 * steps ** 0.46 : undefined;
}

export function parseWuwaStoryDetail(json: unknown): QuestDetail {
	const d = json as DetailResponse;
	const chapters = d?.Chapters ?? [];
	const steps = chapters.filter((c) => "Title" in c).length;
	// Summary ("Outline") entries are not shown in play; <ano=ruby> markup is not counted.
	const chars = chapters
		.flatMap((c) => c.Dialogues ?? [])
		.filter((x) => x.Type !== "Outline")
		.reduce((n, x) => n + (x.PlotLineKey ?? "").replace(/<[^>]*>/g, "").length, 0);
	return {
		steps,
		description: d?.QuestDesc?.trim() || undefined,
		parts: [],
		minutes: wuwaQuestMinutes(chars, steps),
		basis: chars
			? `会話 ${chars.toLocaleString("ja-JP")} 文字（潮汐任務の実測時間から求めた式）`
			: steps
				? `手順数 ${steps}（会話データなし）`
				: undefined,
	};
}

export function wuwaQuestCatalog(fetchJson: FetchJson): QuestCatalog {
	return questCatalog(fetchJson, "wuwa", "鳴潮 任務（encore.moe）", WUWA_STORY_LIST_URL, {
		parseList: parseWuwaStoryList,
		parseDetail: parseWuwaStoryDetail,
	});
}
