import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parseGenshinAnnContent, parseGenshinAnnList } from "../src/sources/genshin";
import { parseGenshinQuestDetail, parseGenshinQuestList } from "../src/sources/genshinQuests";
import { parseJsonFeed } from "../src/sources/jsonFeed";
import { parseNoticeBody, parsePeriod } from "../src/sources/noticeBody";
import { estimateEvent } from "../src/sources/eventEstimate";
import { questToImported, scaleEstimate } from "../src/sources/quests";
import { parseWuwaNotices } from "../src/sources/wuwa";
import { parseWuwaStoryDetail, parseWuwaStoryList } from "../src/sources/wuwaQuests";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const fixture = load("genshin-annlist.json");
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

const jst = (s: string) => Date.parse(`${s}+09:00`);

describe("announcement body", () => {
	it("parses ranges, open-ended periods and explicit JST", () => {
		expect(parsePeriod("2026年10月8日05:00 ~ 2026年10月26日04:59（日本標準時）", 8)).toEqual({
			start: jst("2026-10-08T05:00"),
			end: jst("2026-10-26T04:59"),
			permanent: false,
		});
		expect(parsePeriod("Ver3.7のアップデート後 ~ 2026年11月11日12:59（日本標準時）", 8)).toEqual({
			end: jst("2026-11-11T12:59"),
			permanent: false,
		});
		// Server time (UTC+8) when no zone is given.
		expect(parsePeriod("2026/09/28 00:00からVer.7.1終了まで", 8)).toEqual({
			start: jst("2026-09-28T01:00"),
			permanent: false,
		});
		expect(parsePeriod("Ver3.7のアップデート後から常時開放", 8)).toEqual({ permanent: true });
	});

	it("extracts Genshin sections (〓…〓 and inline) and conditions", () => {
		const bodies = parseGenshinAnnContent(load("genshin-anncontent.json"));
		const sk = parseNoticeBody(bodies.get(21368)!, 8);
		expect(sk.conditions[0]).toBe("冒険ランク32以上");
		expect(sk.conditionQuests).toEqual(["龍と自由の歌", "サイコロ、猫とカードの戦場"]);
		expect(parseNoticeBody(bodies.get(21879)!, 8).conditions).toContain("冒険ランク2以上");
		// A "better experience" recommendation is kept as text but not used for links.
		const rec = parseNoticeBody(bodies.get(21886)!, 8);
		expect(rec.conditions.some((c) => c.includes("ピエス・モンテ"))).toBe(true);
		expect(rec.conditionQuests).toEqual(["龍と自由の歌"]);
		const ww = parseNoticeBody(
			"<div>✦開放条件✦</div><div>ユニオンレベル≧14</div><div>（前提任務「勇者ダンダン大乱闘」をクリアした後に参加すると、よりお楽しみいただけます）</div>",
			8,
		);
		expect(ww.conditions).toHaveLength(2);
		expect(ww.conditionQuests).toEqual([]);
		expect(parseGenshinAnnContent({ retcode: -1 }).size).toBe(0);
	});

	it("reads 招待条件 / 魔神任務開放条件 and skips ※ notes for links", () => {
		const invite = parseNoticeBody(
			"<p>〓招待条件〓</p><p>冒険ランク18以上</p><p>かつ魔神任務 第七章・第四幕「冥府へのレクイエム」をクリア</p><p>〓イベント説明〓</p><p>※魔神任務 序章・第3幕「龍と自由の歌」をクリアしている旅人さんは…</p>",
			8,
		);
		expect(invite.conditions).toEqual(["冒険ランク18以上", "かつ魔神任務 第七章・第四幕「冥府へのレクイエム」をクリア"]);
		expect(invite.conditionQuests).toEqual(["冥府へのレクイエム"]);
		const bonus = parseNoticeBody(
			"<p>〓魔神任務開放条件〓</p><p>魔神任務 第七章・第二幕「死魂の夜想曲」をクリア</p><p>‍※期間中に「冥府へのレクイエム」をクリアすると、エピローグ任務を受注できます。</p>",
			8,
		);
		expect(bonus.conditions).toHaveLength(2);
		expect(bonus.conditionQuests).toEqual(["死魂の夜想曲"]);
	});

	it("does not give permanent world quests the notice window as a deadline", () => {
		const html =
			"<p>〓任務開放時間〓</p><p>7.1バージョンアップ後より開放</p><p>〓任務開放条件〓</p><p>魔神任務 第七章・第二幕「死魂の夜想曲」をクリア</p>";
		const body = parseNoticeBody(html, 8);
		expect(body.permanent).toBe(true);
		expect(body.end).toBeUndefined();
		const json = {
			retcode: 0,
			data: {
				timezone: 8,
				list: [
					{
						type_id: 1,
						list: [{ ann_id: 1, title: "世界任務「追想の変奏曲」", start_time: "2026-09-21 12:00:00", end_time: "2026-11-03 18:00:00" }],
					},
				],
			},
		};
		const [ev] = parseGenshinAnnList(json, { excludeKeywords: [], utcOffset: 8 }, now, new Map([[1, html]]));
		expect(ev.end).toBeUndefined();
		expect(ev.kind).toBe("quest");
		expect(ev.conditionQuests).toEqual(["追想の変奏曲", "死魂の夜想曲"]);
		// A limited event that "opens with the update" keeps its end date.
		expect(parsePeriod("Ver.7.1アップデート後より開放 ～ 2026/11/03 14:59", 8).end).toBeDefined();
	});

	it("uses the body period and conditions when joining getAnnContent", () => {
		const bodies = parseGenshinAnnContent(load("genshin-anncontent.json"));
		const ev = parseGenshinAnnList(fixture, { excludeKeywords: [], utcOffset: 8 }, now, bodies);
		const sk = ev.find((e) => e.sourceId === "hoyoverse-ann:21368")!;
		expect(sk.start).toBe(jst("2026-10-10T11:00"));
		expect(sk.conditions).toContain("冒険ランク32以上");
		expect(sk.body).toContain("## 参加条件");
	});
});

describe("wuthering waves gamenotice", () => {
	const ev = parseWuwaNotices(load("wuwa-gamenotice.json"), { excludeKeywords: ["パック"], utcOffset: 8 }, now);
	const byId = (id: string) => ev.find((e) => e.sourceId === `kuro-notice:${id}`);

	it("imports only the event tab and applies keyword filter", () => {
		expect(byId("50612")).toBeUndefined(); // お知らせ
		expect(byId("50585")).toBeUndefined(); // 唱喚
		expect(byId("50607")).toBeUndefined(); // お得パック
		expect(byId("50603")?.title).toBe("期間限定戦闘イベント 「天工の探し物」");
	});

	it("prefers the period in the body over the notice display window", () => {
		expect(byId("50606")!.end).toBe(jst("2026-11-11T12:59"));
		expect(byId("50603")!.start).toBe(jst("2026-10-08T05:00"));
		expect(byId("50599")!.end).toBeUndefined(); // 常時開放
	});

	it("extracts unlock conditions and quoted quest names", () => {
		const e = byId("50603")!;
		expect(e.conditions![0]).toMatch(/^ユニオンレベル≧14/);
		// Names quoted in the title come first; links are only made to existing notes.
		expect(e.conditionQuests).toEqual(["天工の探し物", "山雨来たらんと欲して風楼に満つ"]);
		expect(byId("50606")!.conditionQuests).toContain("惹かれ合う声");
	});

	it("keeps the whole notice as a collapsed callout", () => {
		const body = byId("50603")!.body!;
		expect(body).toContain("> [!quote]- 元のお知らせ（ゲーム内）");
		expect(body).toMatch(/^> .*開放条件/m);
	});

	it("rejects unexpected payloads", () => {
		expect(() => parseWuwaNotices({}, { excludeKeywords: [], utcOffset: 8 }, now)).toThrow();
	});
});

describe("quest catalogs", () => {
	it("chains Genshin archon quests across chapters and legend quests per character", () => {
		const q = parseGenshinQuestList(load("yatta-quest-list.json"));
		const pre = (id: number) => q.find((e) => e.sourceId === `yatta-quest:${id}`)!.prereqSourceIds;
		expect(q.find((e) => e.sourceId === "yatta-quest:1003")!.title).toBe("龍と自由の歌");
		expect(pre(1001)).toEqual([]);
		expect(pre(1002)).toEqual(["yatta-quest:1001"]);
		// 間章 follows 序章 but the next chapter starts after the last main act.
		expect(pre(1004)).toEqual(["yatta-quest:1003"]);
		expect(pre(1101)).toEqual(["yatta-quest:1003"]);
		expect(pre(2002)).toEqual([]); // different character from 2001
		expect(q.some((e) => e.sourceId === "yatta-quest:426")).toBe(false); // untyped
	});

	it("counts Genshin steps and suggests an estimate", () => {
		const d = parseGenshinQuestDetail(load("yatta-quest-1001.json"));
		expect(d.steps).toBe(68);
		expect(d.parts[0]).toBe("流浪者の足跡");
		const entry = parseGenshinQuestList(load("yatta-quest-list.json"))[0];
		const ev = questToImported(entry, d);
		expect(ev.kind).toBe("quest");
		// 17.2 × 68^0.56 ≈ 183 (the wiki says 1.5h for this act)
		expect(scaleEstimate(ev.suggestedEstimate, 1)).toBe(185);
		expect(scaleEstimate(ev.suggestedEstimate, 0.5)).toBe(90);
		expect(ev.estimateBasis).toMatch(/^手順数 68/);
		expect(ev.body).toContain("## 構成");
		expect(scaleEstimate(undefined, 1)).toBeUndefined();
		expect(scaleEstimate(100, 0)).toBeUndefined();
		expect(scaleEstimate(1, 1)).toBe(5);
	});

	it("chains the Wuthering Waves main line and companion stories per character", () => {
		const q = parseWuwaStoryList(load("encore-story-list.json"));
		const pre = (id: number) => q.find((e) => e.sourceId === `encore-story:${id}`)!.prereqSourceIds;
		expect(pre(100003)).toEqual(["encore-story:100002"]); // 序章 -> 第一章
		expect(q.find((e) => e.sourceId === "encore-story:100003")!.title).toBe("惹かれ合う声");
		expect(pre(101002)).toEqual([]); // different character
		expect(q.every((e) => !e.label.includes("イベント"))).toBe(true);
		expect(parseWuwaStoryDetail(load("encore-story-100001.json")).steps).toBe(12);
	});

	it("estimates Wuthering Waves stories from dialogue text, skipping summaries and ruby markup", () => {
		const d = parseWuwaStoryDetail({
			Chapters: [
				{ Title: "今州に向かう" },
				{
					Dialogues: [
						{ Speaker: "熾霞", PlotLineKey: "<ano=シカ>熾霞</ano>はあなたを案内した。" },
						{ Type: "Outline", PlotLineKey: "あらすじは数えない" },
					],
				},
			],
		});
		expect(d.steps).toBe(1);
		expect(d.minutes).toBeCloseTo(0.082 * 12 ** 0.74);
		expect(d.basis).toMatch(/^会話 12 文字/);
		// The trimmed fixture has no dialogue: falls back to the step count.
		const noText = parseWuwaStoryDetail(load("encore-story-100001.json"));
		expect(scaleEstimate(noText.minutes, 1)).toBe(65);
		expect(noText.basis).toMatch(/会話データなし/);
		expect(parseWuwaStoryDetail({}).minutes).toBeUndefined();
	});
});

describe("event estimate", () => {
	it("classifies events by title and body", () => {
		const cat = (title: string, body: string[] = []) => estimateEvent(title, body).category;
		expect(cat("7日間ログインボーナス 「朝月のプレゼント」")).toBe("ログイン");
		expect(cat("期間限定戦闘イベント 「天工の探し物」")).toBe("戦闘・挑戦");
		expect(cat("新恒常イベント 「心影に映る華」")).toBe("恒常イベント");
		expect(cat("イベント「勝者は誰だ！？」で戦況を予測しよう！")).toBe("Web・アンケート");
		expect(cat("「七聖召喚」鋳境の研鑽：巧みな攻勢", ["本イベントには4つのステージがあります"])).toBe("七聖召喚");
		expect(cat("「神に愛されぬ凍土」：期間中に探索任務をクリアすると、追加で原石×400を獲得可能")).toBe("任務連動ボーナス");
		expect(cat("イベント「銀翎月を遡りて、玄鳥煌めきを結ぶ」：イベント限定武器「片手剣・銀灯」を獲得可能", ["第一段階", "第二段階", "第三段階"])).toBe(
			"大型イベント",
		);
		expect(cat("「月が照らす道」 イベント概要", ["期間中にチャージすると報酬を受け取れます"])).toBe("課金報酬");
		expect(cat("イベント「澄み渡る雪原の鋭気」：通常祈願「奔走世間」の★5キャラクターを招待可能")).toBe("キャラ招待");
		expect(cat("留まる影収集イベント 「過ぎし夢の契り」")).toBe("収集");
		expect(cat("ミニイベント 「勇者ダンダン大乱闘」", ["星声*1200、「開演タイム」*1"])).toBe("大型イベント");
		expect(cat("ミニイベント 「無音イレイサー」", ["星声*400、特級チュナ*100"])).toBe("ミニゲーム");
		expect(cat("エリア探索イベント 「匣の中の夢」", ["- イベント全体は4つの段階に分かれ、順次解放されます。"])).toBe("大型イベント");
		expect(estimateEvent("「謎の催し」")).toEqual({ category: "その他", minutes: 90 });
	});

	it("attaches a suggested estimate to imported notices", () => {
		const ww = parseWuwaNotices(load("wuwa-gamenotice.json"), { excludeKeywords: [], utcOffset: 8 }, now);
		const e = ww.find((x) => x.sourceId === "kuro-notice:50603")!;
		expect(e.suggestedEstimate).toBe(60);
		expect(e.estimateBasis).toContain("戦闘・挑戦");
	});
});
