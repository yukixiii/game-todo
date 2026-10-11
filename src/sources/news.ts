import { Game } from "../model";
import { FetchJson } from "./types";

/**
 * Web articles used as the "original" and "related" links of imported notes. The in-game notices have
 * no public page of their own, so the matching article is found by title:
 * - Genshin: HoYoLAB official news (お知らせ / イベント / 情報), which mirrors the in-game notices.
 * - Wuthering Waves: the official site's news list. Most events have no article of their own there, but
 *   the version's "コンテンツ紹介" article describes them, so the bodies of a few such articles are read too.
 */
export interface NewsArticle {
	title: string;
	url: string;
	/** Epoch ms, for ordering. */
	time: number;
	/** Plain text of the article, for articles whose body is searched for event names. */
	body?: string;
}

export interface NoteLink {
	label: string;
	url: string;
}

const HOYOLAB_NEWS_URL = (type: number) =>
	`https://bbs-api-os.hoyolab.com/community/post/wapi/getNewsList?gids=2&type=${type}&page_size=50`;
/** 1 = お知らせ, 2 = イベント, 3 = 情報 */
const HOYOLAB_NEWS_TYPES = [1, 2, 3];
/** Without this header HoYoLAB answers in English, and no title matches the Japanese notices. */
const HOYOLAB_HEADERS = { "x-rpc-language": "ja-jp" };
const KURO_BASE = "https://hw-media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/jp";
export const KURO_NEWS_URL = `${KURO_BASE}/ArticleMenu.json`;
const kuroArticleUrl = (id: string) => `${KURO_BASE}/article/${id}.json`;
/** Overview articles whose bodies list the version's events. */
const KURO_OVERVIEW = /コンテンツ紹介|イベント総まとめ/;
const KURO_OVERVIEW_COUNT = 3;

interface HoyolabResponse {
	retcode?: number;
	data?: { list?: { post?: { post_id?: string; subject?: string; created_at?: number } }[] };
}

export function parseHoyolabNews(json: unknown): NewsArticle[] {
	const res = json as HoyolabResponse;
	if (!res || res.retcode !== 0) return [];
	return (res.data?.list ?? [])
		.map((x) => x.post)
		.filter((p) => p?.post_id && p.subject)
		.map((p) => ({
			title: p!.subject!.trim(),
			url: `https://www.hoyolab.com/article/${p!.post_id}`,
			time: (p!.created_at ?? 0) * 1000,
		}));
}

interface KuroArticle {
	articleId?: number;
	articleTitle?: string;
	startTime?: string;
}

export function parseKuroNews(json: unknown): NewsArticle[] {
	if (!Array.isArray(json)) return [];
	return (json as KuroArticle[])
		.filter((a) => a.articleId != null && a.articleTitle)
		.map((a) => ({
			title: a.articleTitle!.trim(),
			url: `https://wutheringwaves.kurogames.com/jp/main/news/detail/${a.articleId}`,
			time: Date.parse((a.startTime ?? "").replace(" ", "T")) || 0,
		}));
}

/** Fetches the article list of a game. Failures give an empty list so imports still work. */
export async function fetchNews(fetchJson: FetchJson, game: Game): Promise<NewsArticle[]> {
	const safe = (p: Promise<unknown>) => p.catch(() => null);
	if (game === "genshin") {
		const lists = await Promise.all(HOYOLAB_NEWS_TYPES.map((t) => safe(fetchJson(HOYOLAB_NEWS_URL(t), HOYOLAB_HEADERS))));
		return lists.flatMap(parseHoyolabNews);
	}
	const list = parseKuroNews(await safe(fetchJson(KURO_NEWS_URL)));
	const overviews = list
		.filter((a) => KURO_OVERVIEW.test(a.title))
		.sort((a, b) => b.time - a.time)
		.slice(0, KURO_OVERVIEW_COUNT);
	await Promise.all(
		overviews.map(async (a) => {
			const id = a.url.split("/").pop()!;
			const json = (await safe(fetchJson(kuroArticleUrl(id)))) as { articleContent?: string } | null;
			if (json?.articleContent) a.body = json.articleContent.replace(/<[^>]*>/g, "");
		}),
	);
	return list;
}

/** Width/space-insensitive form for comparing titles. */
function normalize(s: string): string {
	return s
		.normalize("NFKC")
		.replace(/[\s　]+/g, "")
		.replace(/[!！?？]/g, "");
}

/** Names quoted in a title (「…」『…』), which identify the event or quest in article titles. */
export function keyNames(title: string): string[] {
	const names = [...title.matchAll(/[「『【＜]([^」』】＞]+)[」』】＞]/g)].map((m) => m[1].trim());
	return [...new Set(names)].filter((n) => n.length >= 2 && n !== "原神" && n !== "鳴潮");
}

/**
 * The article whose title equals the notice title, and other articles mentioning one of `names`
 * (newest first).
 */
export function matchArticles(
	title: string,
	names: string[],
	articles: NewsArticle[],
	limit = 5,
): { original?: NewsArticle; related: NewsArticle[]; mentions: NewsArticle[] } {
	const key = normalize(title);
	const original = articles.find((a) => normalize(a.title) === key);
	const keys = names.map(normalize).filter(Boolean);
	const seen = new Set(original ? [original.url] : []);
	const related = articles
		.filter((a) => {
			if (seen.has(a.url)) return false;
			const t = normalize(a.title);
			if (!keys.some((k) => t.includes(k))) return false;
			seen.add(a.url);
			return true;
		})
		.sort((a, b) => b.time - a.time)
		.slice(0, limit);
	const mentions = articles
		.filter((a) => a.body && !seen.has(a.url) && keys.some((k) => normalize(a.body!).includes(k)))
		.sort((a, b) => b.time - a.time);
	return { original, related, mentions };
}

const WIKI: Record<Game, { label: string; base: string }> = {
	genshin: { label: "原神 攻略 wiki", base: "https://wikiwiki.jp/genshinwiki/" },
	wuwa: { label: "鳴潮 攻略 wiki", base: "https://wikiwiki.jp/w-w/" },
};

export function wikiSearchLink(game: Game, word: string): NoteLink {
	const w = WIKI[game];
	return { label: `${w.label}で「${word}」を検索`, url: `${w.base}::cmd/search?word=${encodeURIComponent(word)}` };
}

/** Among related articles, the one most likely to describe the event itself (announcements first). */
function bestRelated(related: NewsArticle[]): NewsArticle | undefined {
	const score = (a: NewsArticle) => (/イベント|開催|予告|紹介/.test(a.title) ? 0 : 1);
	return [...related].sort((a, b) => score(a) - score(b) || b.time - a.time)[0];
}

/**
 * Adds the original article and related articles / wiki search links to imported items.
 * Items without a url get the article with the same title, or failing that (Wuthering Waves notices
 * are rarely published under the same title) the best related article, or an overview article whose
 * body mentions the name, labelled as such.
 * `names` defaults to the names quoted in the title, or the title itself.
 */
export function attachArticles<T extends { game: Game; title: string; url?: string; links?: NoteLink[] }>(
	items: T[],
	articles: NewsArticle[],
	names: (item: T) => string[] = (i) => (keyNames(i.title).length ? keyNames(i.title) : [i.title]),
): (T & { url?: string; urlLabel?: string; links: NoteLink[] })[] {
	return items.map((item) => {
		const n = names(item);
		const { original, related, mentions } = matchArticles(item.title, n, articles);
		let url = item.url;
		let urlLabel: string | undefined;
		const links: NoteLink[] = [...(item.links ?? [])];
		if (original) {
			if (!url) url = original.url;
			else if (original.url !== url) links.unshift({ label: original.title, url: original.url });
		}
		let rest = related;
		if (!url) {
			const best = bestRelated(related);
			if (best) {
				url = best.url;
				urlLabel = `元記事（関連する公式記事「${best.title}」）`;
				rest = related.filter((a) => a !== best);
			} else if (mentions[0]) {
				url = mentions[0].url;
				urlLabel = `元記事（紹介のある公式記事「${mentions[0].title}」）`;
			}
		}
		links.push(...rest.map((a) => ({ label: a.title, url: a.url })));
		if (n[0]) links.push(wikiSearchLink(item.game, n[0]));
		return { ...item, url, ...(urlLabel ? { urlLabel } : {}), links };
	});
}

const LINKS_HEADING = "## リンク";

function originalLine(url: string, label = "元記事"): string {
	return `- ${label}: ${url}`;
}

/**
 * A link whose URL contains "::" (wikiwiki's `::cmd/search`) is written as an HTML anchor: in
 * `[label](url)` Dataview reads `(url-prefix:: rest)` as an inline field and renders it as one in live
 * preview. The wiki doesn't accept the colons percent-encoded.
 */
function linkMarkdown(l: NoteLink): string {
	if (l.url.includes("::")) {
		const html = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
		return `<a href="${html(l.url)}">${html(l.label)}</a>`;
	}
	return `[${l.label.replace(/[[\]]/g, (c) => `\\${c}`)}](${l.url})`;
}

/** Markdown section listing the links of a note. */
export function linksMarkdown(url: string | undefined, links: NoteLink[] = [], urlLabel?: string): string {
	if (!url && !links.length) return "";
	const lines = [LINKS_HEADING];
	if (url) lines.push(originalLine(url, urlLabel));
	for (const l of links) lines.push(`- ${linkMarkdown(l)}`);
	return lines.join("\n") + "\n";
}

/**
 * Adds the original article to an existing note: inserted at the top of its link section when there
 * is one (notes imported while the article lookup failed), otherwise a new section is appended.
 */
export function addLinksToContent(content: string, url: string, links: NoteLink[] = [], urlLabel?: string): string {
	// Only the body counts: `url` in the frontmatter alone does not show the link section.
	if (content.replace(/^---\n[\s\S]*?\n---/, "").includes(url)) return content;
	const lines = content.split("\n");
	const at = lines.indexOf(LINKS_HEADING);
	if (at >= 0) {
		lines.splice(at + 1, 0, originalLine(url, urlLabel));
		return lines.join("\n");
	}
	return `${content.replace(/\s*$/, "")}\n\n${linksMarkdown(url, links, urlLabel)}`;
}
