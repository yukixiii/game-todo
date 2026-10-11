import { parseWallClock } from "../time";
import { FetchJson, ImportedEvent, Source } from "./types";

/** Unofficial HoYoverse in-game announcement list (no auth). Times are server wall-clock. */
export const GENSHIN_ANN_URL =
	"https://sg-hk4e-api.hoyoverse.com/common/hk4e_global/announcement/api/getAnnList" +
	"?game=hk4e&game_biz=hk4e_global&lang=ja-jp&bundle_id=hk4e_global&platform=pc&region=os_asia&level=55&uid=100000000";

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

export function parseGenshinAnnList(json: unknown, filter: GenshinFilter, now: number): ImportedEvent[] {
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
			const end = parseWallClock(a.end_time, tz);
			if (end != null && end < now) continue;
			out.push({
				sourceId: `hoyoverse-ann:${a.ann_id}`,
				game: "genshin",
				title,
				start: parseWallClock(a.start_time, tz),
				end,
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
		fetch: async (now) => parseGenshinAnnList(await fetchJson(GENSHIN_ANN_URL), filter(), now),
	};
}
