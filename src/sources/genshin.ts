import { parseWallClock } from "../time";
import { estimateEvent, eventEstimateBasis } from "./eventEstimate";
import { attachArticles, fetchNews, keyNames } from "./news";
import { htmlToLines, noticeBodyMarkdown, noticeFullTextMarkdown, parseNoticeBody } from "./noticeBody";
import { FetchJson, ImportedEvent, Source } from "./types";

const ANN_QUERY =
	"?game=hk4e&game_biz=hk4e_global&lang=ja-jp&bundle_id=hk4e_global&platform=pc&region=os_asia&level=55&uid=100000000";
const ANN_BASE = "https://sg-hk4e-api.hoyoverse.com/common/hk4e_global/announcement/api";

/** Unofficial HoYoverse in-game announcement list (no auth). Times are server wall-clock. */
export const GENSHIN_ANN_URL = `${ANN_BASE}/getAnnList${ANN_QUERY}`;
/** Bodies of the same announcements, joined by ann_id. */
export const GENSHIN_ANN_CONTENT_URL = `${ANN_BASE}/getAnnContent${ANN_QUERY}`;

/** type_id of the "イベント" group in getAnnList. */
export const EVENT_GROUP_ID = 1;

export interface GenshinFilter {
	/** Announcements whose title contains any of these are skipped. */
	excludeKeywords: string[];
	/** Fallback server offset when the response has no `timezone`. */
	utcOffset: number;
}

interface AnnItem {
	ann_id: number;
	title: string;
	start_time: string;
	end_time: string;
}

interface AnnResponse {
	retcode: number;
	message?: string;
	data?: { timezone?: number; list?: { type_id: number; list?: AnnItem[] }[] };
}

interface AnnContentResponse {
	retcode: number;
	data?: { list?: { ann_id: number; content?: string }[] };
}

/** ann_id -> body HTML. Returns an empty map on errors so the list still imports. */
export function parseGenshinAnnContent(json: unknown): Map<number, string> {
	const res = json as AnnContentResponse;
	const out = new Map<number, string>();
	if (!res || res.retcode !== 0) return out;
	for (const a of res.data?.list ?? []) if (a.content) out.set(a.ann_id, a.content);
	return out;
}

/**
 * Parses getAnnList. When a body is available, the event period written in it wins over the
 * announcement's display window (which often outlasts the event itself).
 */
export function parseGenshinAnnList(
	json: unknown,
	filter: GenshinFilter,
	now: number,
	contents: Map<number, string> = new Map(),
): ImportedEvent[] {
	const res = json as AnnResponse;
	if (!res || res.retcode !== 0 || !res.data?.list) {
		throw new Error(`getAnnList failed: ${res?.retcode ?? "?"} ${res?.message ?? ""}`.trim());
	}
	const tz = typeof res.data.timezone === "number" ? res.data.timezone : filter.utcOffset;
	const out: ImportedEvent[] = [];
	for (const group of res.data.list) {
		if (group.type_id !== EVENT_GROUP_ID) continue;
		for (const a of group.list ?? []) {
			const title = a.title.replace(/<[^>]*>/g, "").trim();
			if (filter.excludeKeywords.some((k) => k && title.includes(k))) continue;
			let start = parseWallClock(a.start_time, tz);
			let end = parseWallClock(a.end_time, tz);
			const html = contents.get(a.ann_id);
			const info = html ? parseNoticeBody(html, tz) : undefined;
			if (info?.end != null) end = info.end;
			// Permanent content (e.g. "世界任務「…」 7.1バージョンアップ後より開放"): the notice window is not a deadline.
			else if (info?.permanent) end = undefined;
			if (info?.start != null && (start == null || info.start > start)) start = info.start;
			if (end != null && end < now) continue;
			const est = estimateEvent(title, html ? htmlToLines(html) : []);
			out.push({
				sourceId: `hoyoverse-ann:${a.ann_id}`,
				game: "genshin",
				title,
				kind: /^(世界|魔神|伝説)任務/.test(title) ? "quest" : undefined,
				start,
				end,
				conditions: info?.conditions,
				conditionQuests: [...new Set([...keyNames(title), ...(info?.conditionQuests ?? [])])],
				suggestedEstimate: est.minutes,
				estimateBasis: eventEstimateBasis(est),
				body: info ? [noticeBodyMarkdown(info), noticeFullTextMarkdown(html!)].filter(Boolean).join("\n") : undefined,
			});
		}
	}
	return out;
}

export function genshinSource(fetchJson: FetchJson, filter: () => GenshinFilter): Source {
	return {
		id: "genshin-ann",
		label: "原神 ゲーム内お知らせ",
		game: "genshin",
		fetch: async (now) => {
			const [list, content, news] = await Promise.all([
				fetchJson(GENSHIN_ANN_URL),
				fetchJson(GENSHIN_ANN_CONTENT_URL).catch(() => null),
				fetchNews(fetchJson, "genshin"),
			]);
			return attachArticles(parseGenshinAnnList(list, filter(), now, parseGenshinAnnContent(content)), news);
		},
	};
}
