import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parseGenshinAnnList } from "../src/sources/genshin";
import { parseJsonFeed } from "../src/sources/jsonFeed";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/genshin-annlist.json", import.meta.url), "utf8"));
const now = Date.UTC(2026, 9, 11, 3, 0); // 2026-10-11 12:00 JST

describe("genshin getAnnList", () => {
	it("keeps only current events from the event group and applies keyword filter", () => {
		const ev = parseGenshinAnnList(fixture, { excludeKeywords: ["祈願"], utcOffset: 8 }, now);
		expect(ev.length).toBeGreaterThan(0);
		expect(ev.every((e) => e.sourceId.startsWith("hoyoverse-ann:"))).toBe(true);
		expect(ev.some((e) => e.title.includes("祈願"))).toBe(false);
		expect(ev.some((e) => e.title.includes("Ver.7.1最新情報一覧"))).toBe(false); // 重要 group
		const sk = ev.find((e) => e.sourceId === "hoyoverse-ann:21368")!;
		// "2026-10-26 03:59:59" at UTC+8
		expect(sk.end).toBe(Date.UTC(2026, 9, 25, 19, 59, 59));
	});

	it("throws on API errors", () => {
		expect(() => parseGenshinAnnList({ retcode: -1, message: "bad" }, { excludeKeywords: [], utcOffset: 8 }, now)).toThrow(
			/-1 bad/,
		);
	});
});

describe("json feed", () => {
	it("accepts arrays and {events}", () => {
		const items = [
			{ id: 1, title: "A", end: "2026-12-01T04:00+08:00" },
			{ title: "old", end: "2026-01-01" },
			{ title: "" },
		];
		const a = parseJsonFeed(items, "wuwa", "feed-wuwa", now);
		expect(a.map((e) => e.sourceId)).toEqual(["feed-wuwa:1"]);
		expect(parseJsonFeed({ events: items }, "wuwa", "feed-wuwa", now)).toHaveLength(1);
		expect(() => parseJsonFeed({}, "wuwa", "f", now)).toThrow();
	});
});
