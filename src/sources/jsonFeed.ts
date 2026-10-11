import { Game, GAME_LABEL } from "../model";
import { parseDate } from "../time";
import { FetchJson, ImportedEvent, Source } from "./types";

/**
 * Generic feed for games without a known API (e.g. Wuthering Waves).
 * Expected JSON: [{ "id": "...", "title": "...", "start": "<ISO>", "end": "<ISO>", "url": "..." }]
 * or { "events": [...] }.
 */
export function parseJsonFeed(json: unknown, game: Game, feedId: string, now: number): ImportedEvent[] {
	const list = Array.isArray(json) ? json : (json as { events?: unknown })?.events;
	if (!Array.isArray(list)) throw new Error("JSON フィードの形式が不正です（配列または { events: [...] }）");
	const out: ImportedEvent[] = [];
	for (const raw of list) {
		const e = raw as Record<string, unknown>;
		if (typeof e.title !== "string" || !e.title.trim()) continue;
		const end = parseDate(e.end);
		if (end != null && end < now) continue;
		const id = e.id != null ? String(e.id) : e.title.trim();
		out.push({
			sourceId: `${feedId}:${id}`,
			game,
			title: e.title.trim(),
			start: parseDate(e.start),
			end,
			url: typeof e.url === "string" ? e.url : undefined,
		});
	}
	return out;
}

export function jsonFeedSource(fetchJson: FetchJson, game: Game, url: string): Source {
	return {
		id: `feed-${game}`,
		label: `${GAME_LABEL[game]} JSON フィード`,
		game,
		fetch: async (now) => parseJsonFeed(await fetchJson(url), game, `feed-${game}`, now),
	};
}
