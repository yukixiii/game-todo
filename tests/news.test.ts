import { describe, expect, it } from "vitest";
import {
	addLinksToContent,
	attachArticles,
	fetchNews,
	keyNames,
	linksMarkdown,
	matchArticles,
	parseHoyolabNews,
	parseKuroNews,
} from "../src/sources/news";

const hoyolab = parseHoyolabNews({
	retcode: 0,
	data: {
		list: [
			{ post: { post_id: "47008743", subject: "「七聖召喚」熱闘モード：オートメーション対局", created_at: 1791000000 } },
			{ post: { post_id: "47000001", subject: "Ver.7.1「七聖召喚」新カード紹介", created_at: 1792000000 } },
			{ post: { post_id: "1", subject: "関係のない記事", created_at: 1793000000 } },
			{ post: { subject: "id なし" } },
		],
	},
});

describe("news articles", () => {
	it("parses HoYoLAB and Kuro lists", () => {
		expect(hoyolab).toHaveLength(3);
		expect(hoyolab[0].url).toBe("https://www.hoyolab.com/article/47008743");
		expect(parseHoyolabNews({ retcode: -1 })).toEqual([]);
		const kuro = parseKuroNews([
			{ articleId: 5554, articleTitle: "イベント予告 | ＜勇者ダンダン大乱闘＞ ミニイベントまもなく開催！", startTime: "2026-09-29 14:16:35" },
			{ articleTitle: "id なし" },
		]);
		expect(kuro).toEqual([
			expect.objectContaining({ url: "https://wutheringwaves.kurogames.com/jp/main/news/detail/5554" }),
		]);
		expect(parseKuroNews({})).toEqual([]);
	});

	it("finds the original by title and related articles by quoted names", () => {
		const title = "「七聖召喚」熱闘モード：オートメーション対局";
		expect(keyNames(title)).toEqual(["七聖召喚"]);
		expect(keyNames("『原神』Webイベント「星々の宴」")).toEqual(["星々の宴"]);
		expect(keyNames("新規周期コンテンツ 【終焉マトリクス】")).toEqual(["終焉マトリクス"]);
		const m = matchArticles("「七聖召喚」 熱闘モード：オートメーション対局", keyNames(title), hoyolab);
		expect(m.original?.url).toBe("https://www.hoyolab.com/article/47008743");
		expect(m.related.map((a) => a.url)).toEqual(["https://www.hoyolab.com/article/47000001"]);
	});

	it("attaches links and keeps an existing url (quests) as the original", () => {
		const [ev] = attachArticles([{ game: "genshin" as const, title: "「七聖召喚」熱闘モード：オートメーション対局" }], hoyolab);
		expect(ev.url).toBe("https://www.hoyolab.com/article/47008743");
		expect(ev.links!.map((l) => l.url)).toEqual([
			"https://www.hoyolab.com/article/47000001",
			"https://wikiwiki.jp/genshinwiki/::cmd/search?word=%E4%B8%83%E8%81%96%E5%8F%AC%E5%96%9A",
		]);
		const [q] = attachArticles(
			[{ game: "wuwa" as const, title: "七聖召喚", url: "https://encore.moe/story/1?lang=ja" }],
			hoyolab,
			(i) => [i.title],
		);
		expect(q.url).toBe("https://encore.moe/story/1?lang=ja");
		expect(q.links![0].label).toContain("七聖召喚");
		expect(q.links!.at(-1)!.url).toContain("wikiwiki.jp/w-w/");
	});

	it("asks HoYoLAB for Japanese titles", async () => {
		const calls: [string, Record<string, string> | undefined][] = [];
		await fetchNews(async (url, headers) => {
			calls.push([url, headers]);
			return { retcode: 0, data: { list: [] } };
		}, "genshin");
		expect(calls).toHaveLength(3);
		expect(calls.every(([, h]) => h?.["x-rpc-language"] === "ja-jp")).toBe(true);
	});

	it("falls back to the best related article when no title matches", () => {
		const kuro = parseKuroNews([
			{ articleId: 1, articleTitle: "第二十二回【鳴潮 バトルラッシュ】勇者ダンダン大乱闘 動画募集", startTime: "2026-10-01 10:00:00" },
			{ articleId: 5554, articleTitle: "イベント予告 | ＜勇者ダンダン大乱闘＞ ミニイベントまもなく開催！", startTime: "2026-09-29 14:16:35" },
		]);
		const [ev] = attachArticles([{ game: "wuwa" as const, title: "ミニイベント 「勇者ダンダン大乱闘」" }], kuro);
		expect(ev.url).toBe("https://wutheringwaves.kurogames.com/jp/main/news/detail/5554");
		expect(ev.urlLabel).toContain("関連する公式記事");
		expect(ev.links.map((l) => l.url)[0]).toBe("https://wutheringwaves.kurogames.com/jp/main/news/detail/1");
		const [none] = attachArticles([{ game: "wuwa" as const, title: "「謎」" }], kuro);
		expect(none.url).toBeUndefined();
		// An overview article whose body mentions the event is the last resort.
		const overview = { title: "Ver.3.7 コンテンツ紹介", url: "https://k/5570", time: 0, body: "期間限定戦闘イベント「天工の探し物」…" };
		const [byBody] = attachArticles([{ game: "wuwa" as const, title: "期間限定戦闘イベント 「天工の探し物」" }], [...kuro, overview]);
		expect(byBody.url).toBe("https://k/5570");
		expect(byBody.urlLabel).toContain("紹介のある公式記事");
	});

	it("inserts the original into an existing link section", () => {
		const note = "---\nurl: \"https://a\"\n---\n本文\n\n## リンク\n- [wiki](https://w)\n";
		expect(addLinksToContent(note, "https://a")).toBe("---\nurl: \"https://a\"\n---\n本文\n\n## リンク\n- 元記事: https://a\n- [wiki](https://w)\n");
		expect(addLinksToContent("本文\n", "https://a", [], "元記事（関連）")).toBe("本文\n\n## リンク\n- 元記事（関連）: https://a\n");
		const done = "本文\n\n## リンク\n- 元記事: https://a\n";
		expect(addLinksToContent(done, "https://a")).toBe(done);
	});

	it("renders a link section", () => {
		expect(linksMarkdown(undefined, [])).toBe("");
		expect(linksMarkdown("https://a", [{ label: "[告知] B", url: "https://b" }])).toBe(
			"## リンク\n- 元記事: https://a\n- [\\[告知\\] B](https://b)\n",
		);
	});
});
