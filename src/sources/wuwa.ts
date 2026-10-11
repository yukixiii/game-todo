import { estimateEvent, eventEstimateBasis } from "./eventEstimate";
import { attachArticles, fetchNews, keyNames } from "./news";
import { htmlToLines, noticeBodyMarkdown, noticeFullTextMarkdown, parseNoticeBody } from "./noticeBody";
import { FetchJson, ImportedEvent, Source } from "./types";

/**
 * Kuro Games in-game notice JSON (official CDN, no auth). The hash segment was taken from
 * encore.moe and may change; it is overridable in settings.
 */
export const WUWA_NOTICE_URL =
	"https://aki-gm-resources-back.aki-game.net/gamenotice/G153/10cd7254d57e58ae560b15d51e34b4c8/ja.json";

/** `category` of the in-game "イベント" tab (1 = お知らせ, 3 = 唱喚, 4 = コミュニティ). */
export const WUWA_EVENT_CATEGORY = 2;

export interface WuwaFilter {
	excludeKeywords: string[];
	/** Server offset for times without an explicit zone. */
	utcOffset: number;
}

interface Notice {
	id: string;
	startTimeMs?: number;
	endTimeMs?: number;
	tabTitle?: string;
	content?: string;
	category?: number;
}

type NoticeResponse = Record<string, Notice[] | undefined>;

export function parseWuwaNotices(json: unknown, filter: WuwaFilter, now: number): ImportedEvent[] {
	const res = json as NoticeResponse;
	if (!res || typeof res !== "object" || !Array.isArray(res.game)) {
		throw new Error("鳴潮のお知らせ JSON の形式が不正です");
	}
	const seen = new Set<string>();
	const out: ImportedEvent[] = [];
	for (const key of ["game", "activity", "recommend"]) {
		for (const n of res[key] ?? []) {
			if (n.category !== WUWA_EVENT_CATEGORY || seen.has(n.id)) continue;
			seen.add(n.id);
			const title = (n.tabTitle ?? "").replace(/\s+/g, " ").trim();
			if (!title || filter.excludeKeywords.some((k) => k && title.includes(k))) continue;
			const info = n.content ? parseNoticeBody(n.content, filter.utcOffset) : undefined;
			const start = info?.start ?? n.startTimeMs;
			const end = info?.permanent && info.end == null ? undefined : (info?.end ?? n.endTimeMs);
			if (end != null && end < now) continue;
			const est = estimateEvent(title, n.content ? htmlToLines(n.content) : []);
			out.push({
				sourceId: `kuro-notice:${n.id}`,
				game: "wuwa",
				title,
				start,
				end,
				conditions: info?.conditions,
				conditionQuests: [...new Set([...keyNames(title), ...(info?.conditionQuests ?? [])])],
				suggestedEstimate: est.minutes,
				estimateBasis: eventEstimateBasis(est),
				body: info ? [noticeBodyMarkdown(info), noticeFullTextMarkdown(n.content!)].filter(Boolean).join("\n") : undefined,
			});
		}
	}
	return out;
}

export function wuwaSource(fetchJson: FetchJson, url: () => string, filter: () => WuwaFilter): Source {
	return {
		id: "wuwa-notice",
		label: "鳴潮 ゲーム内お知らせ",
		game: "wuwa",
		fetch: async (now) => {
			const [json, news] = await Promise.all([fetchJson(url()), fetchNews(fetchJson, "wuwa")]);
			return attachArticles(parseWuwaNotices(json, filter(), now), news);
		},
	};
}
