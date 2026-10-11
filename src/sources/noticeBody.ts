import { HOUR } from "../time";

/**
 * Parser for in-game announcement bodies (HoYoverse getAnnContent / Kuro gamenotice).
 * Both are HTML whose sections are headed by "〓見出し〓" (Genshin) or "✦見出し✦" (Wuthering Waves),
 * sometimes written inline as "イベント期間：…".
 */

const PERIOD_KEYS = ["イベント期間", "開催期間", "任務開放時間"];
const CONDITION_KEYS = ["参加条件", "開放条件", "解放条件", "招待条件"];
/** Headings like "魔神任務開放条件" / "任務開放条件" / "招待条件" also hold conditions. */
const CONDITION_HEADING = /(参加|開放|解放|招待|受注)条件$/;
const REWARD_KEYS = ["イベント報酬", "報酬内容", "受取可能な報酬内容"];

export interface NoticeInfo {
	start?: number;
	end?: number;
	/** "常時開放" etc.: the content stays after the notice disappears. */
	permanent: boolean;
	/** Participation conditions, one per line. */
	conditions: string[];
	/** Quest names quoted in the conditions (「…」), for linking to existing notes. */
	conditionQuests: string[];
	/** Reward summary lines (text only; images are dropped). */
	rewards: string[];
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(s: string): string {
	return s.replace(/&(lt|gt|amp|quot|apos|nbsp|#39);/g, (_, e: string) => ENTITIES[e]);
}

/** HTML -> trimmed non-empty text lines. Escaped tags (Genshin's &lt;t&gt; time tags) are removed too. */
export function htmlToLines(html: string): string[] {
	const text = html
		.replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, "\n")
		.replace(/<\/td>/gi, " ")
		.replace(/<[^>]*>/g, "");
	return decodeEntities(text)
		.replace(/<[^>]*>/g, "")
		.replace(/[\u200b-\u200d\ufeff]/g, "")
		.split("\n")
		.map((l) => l.replace(/[\s ]+/g, " ").trim())
		.filter(Boolean);
}

/** Groups lines under their heading. Inline "見出し：本文" lines are added to that heading. */
export function extractSections(lines: string[]): Map<string, string[]> {
	const sections = new Map<string, string[]>();
	const known = [...PERIOD_KEYS, ...CONDITION_KEYS, ...REWARD_KEYS];
	const inline = new RegExp(`^(${known.join("|")})[：:]\\s*(.+)$`);
	const add = (key: string, line: string) => {
		const list = sections.get(key) ?? [];
		list.push(line);
		sections.set(key, list);
	};
	let current: string | null = null;
	for (const line of lines) {
		const heading = /^[〓✦]\s*(.+?)\s*[〓✦]$/.exec(line);
		if (heading) {
			current = heading[1];
			if (!sections.has(current)) sections.set(current, []);
			continue;
		}
		const m = inline.exec(line);
		if (m) add(m[1], m[2]);
		else if (current) add(current, line);
	}
	return sections;
}

function pick(sections: Map<string, string[]>, keys: string[], heading?: RegExp): string[] {
	const names = [...sections.keys()].filter((k) => keys.includes(k) || (heading?.test(k) ?? false));
	return names.flatMap((k) => sections.get(k) ?? []);
}

const DATE_RE = /(\d{4})[/年-](\d{1,2})[/月-](\d{1,2})日?\s*(\d{1,2}):(\d{2})/g;

/**
 * Finds date-times in a period text. Times are in `defaultOffset` unless the text says 日本標準時/JST.
 * Two or more dates form a range (earliest..latest); a single date is a start when followed by
 * "から/より/以降" and an end when preceded by "~" or followed by "まで".
 */
export function parsePeriod(text: string, defaultOffset: number): { start?: number; end?: number; permanent: boolean } {
	const offset = /日本標準時|JST|UTC\+9/.test(text) ? 9 : defaultOffset;
	const found: { at: number; index: number; length: number }[] = [];
	for (const m of text.matchAll(DATE_RE)) {
		const [, y, mo, d, h, mi] = m;
		const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) - offset * HOUR;
		found.push({ at, index: m.index ?? 0, length: m[0].length });
	}
	// "常時開放" / "7.1バージョンアップ後より開放" (permanent world quests): open-ended unless an end date is given.
	const permanent = /常時開放|恒常|常設|(より|から|以降)(開放|常設)/.test(text);
	if (found.length >= 2) {
		const times = found.map((f) => f.at);
		return { start: Math.min(...times), end: Math.max(...times), permanent };
	}
	if (found.length === 1) {
		const f = found[0];
		const before = text.slice(0, f.index);
		const after = text.slice(f.index + f.length).replace(/^\s*[（(][^）)]*[）)]/, "");
		if (/^\s*(から|より|以降)/.test(after)) return { start: f.at, permanent };
		if (/[~～〜\-–—]\s*$/.test(before) || /^\s*まで/.test(after)) return { end: f.at, permanent };
	}
	return { permanent };
}

function cleanListItem(line: string): string {
	return line.replace(/^[-・•※]\s*/, "").trim();
}

/** Like cleanListItem, but keeps a leading "※" so stored conditions still tell notes from requirements. */
function cleanConditionItem(line: string): string {
	return line.replace(/^[-・•]\s*/, "").trim();
}

/**
 * Quest names quoted (「…」) in condition lines, for prerequisite links. "※…" notes (alternative routes,
 * epilogues) and recommendations ("…をクリア後にプレイすると、より良い体験を…") are not requirements.
 */
export function linkableQuestNames(conditions: string[]): string[] {
	return [
		...new Set(
			conditions
				.filter((c) => !/^\s*※/.test(c) && !/体験|お楽しみ|おすすめ|推奨/.test(c))
				.flatMap((c) => [...c.matchAll(/「([^」]+)」/g)].map((m) => m[1].trim())),
		),
	].filter(Boolean);
}

export function parseNoticeBody(html: string, defaultOffset: number): NoticeInfo {
	const sections = extractSections(htmlToLines(html));
	const period = parsePeriod(pick(sections, PERIOD_KEYS).join("\n"), defaultOffset);
	const conditions = pick(sections, CONDITION_KEYS, CONDITION_HEADING).map(cleanConditionItem).filter(Boolean);
	const conditionQuests = linkableQuestNames(conditions);
	const rewards = pick(sections, REWARD_KEYS).map(cleanListItem).filter(Boolean).slice(0, 5);
	return { ...period, conditions, conditionQuests, rewards };
}

const FULL_TEXT_MAX_LINES = 300;

/**
 * The whole announcement as a collapsed callout, so the original text stays readable from the note
 * (in-game notices have no public web page of their own).
 */
export function noticeFullTextMarkdown(html: string, heading = "元のお知らせ（ゲーム内）"): string {
	const lines = htmlToLines(html);
	if (!lines.length) return "";
	const shown = lines.slice(0, FULL_TEXT_MAX_LINES);
	if (lines.length > shown.length) shown.push(`…（以下 ${lines.length - shown.length} 行省略）`);
	return [`> [!quote]- ${heading}`, ...shown.map((l) => `> ${l}`), ""].join("\n");
}

/** Markdown body section listing conditions and rewards for an imported note. */
export function noticeBodyMarkdown(info: Pick<NoticeInfo, "conditions" | "rewards">): string {
	const parts: string[] = [];
	if (info.conditions.length) parts.push("## 参加条件", ...info.conditions.map((c) => `- ${c}`), "");
	if (info.rewards.length) parts.push("## 報酬", ...info.rewards.map((r) => `- ${r}`), "");
	return parts.join("\n");
}
