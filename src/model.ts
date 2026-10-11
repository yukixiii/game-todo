import { formatLocalIso, parseDate } from "./time";

export type Game = "genshin" | "wuwa";
export type Kind = "event" | "quest" | "daily" | "weekly" | "periodic" | "other";
export type Status = "todo" | "doing" | "done";

export const GAMES: Game[] = ["genshin", "wuwa"];
export const GAME_LABEL: Record<Game, string> = { genshin: "原神", wuwa: "鳴潮" };
export const KINDS: Kind[] = ["event", "quest", "daily", "weekly", "periodic", "other"];
export const KIND_LABEL: Record<Kind, string> = {
	event: "イベント",
	quest: "任務",
	daily: "日課",
	weekly: "週課",
	periodic: "定期",
	other: "その他",
};

export interface Task {
	path: string;
	title: string;
	game: Game;
	kind: Kind;
	start?: number;
	deadline?: number;
	/** Total estimated minutes. Undefined = not estimated yet (inbox). */
	estimate?: number;
	/** Remaining minutes, overrides estimate when set. */
	remaining?: number;
	/** Imported rough estimate, offered in the inbox; never used for scheduling. */
	suggestedEstimate?: number;
	/** Resolved paths of prerequisite tasks. */
	prereqs: string[];
	/** Prerequisite links that did not resolve to a task note. */
	missingPrereqs: string[];
	/** Unlock / participation conditions as written in the source (free text). */
	unlock: string[];
	status: Status;
	source?: string;
	/** Original article / data page of an imported task. */
	url?: string;
	recurrenceOf?: string;
}

export interface RecurringTemplate {
	path: string;
	title: string;
	game: Game;
	kind: Kind;
	estimate?: number;
	rule: string;
	/** Raw prerequisite links, copied verbatim to instances. */
	prereqLinks: string[];
	/** "preset:<id>" for templates created from a built-in preset. */
	source?: string;
	/** Reference page, copied to instances. */
	url?: string;
}

/** Resolves a link target (without brackets) to a note path, or null. */
export type LinkResolver = (linkText: string) => string | null;

/** "[[Note|alias]]" / "[[Note#h]]" / "Note" -> "Note" */
export function linkTarget(raw: string): string {
	let s = raw.trim();
	const m = /^\[\[([^\]]+)\]\]$/.exec(s);
	if (m) s = m[1];
	s = s.split("|")[0];
	s = s.split("#")[0];
	return s.trim();
}

function asList(value: unknown): string[] {
	if (value == null) return [];
	if (Array.isArray(value)) return value.filter((v) => v != null).map((v) => String(v)).filter((v) => v.trim());
	const s = String(value).trim();
	return s ? [s] : [];
}

function asMinutes(value: unknown): number | undefined {
	if (value == null || value === "") return undefined;
	const n = typeof value === "number" ? value : Number(String(value).trim());
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	const s = typeof value === "string" ? value.trim().toLowerCase() : "";
	return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

export function parseTask(
	path: string,
	title: string,
	fm: Record<string, unknown> | undefined,
	resolve: LinkResolver,
): Task | null {
	if (!fm || fm.gtodo !== "task") return null;
	const prereqs: string[] = [];
	const missingPrereqs: string[] = [];
	for (const raw of asList(fm.prereqs)) {
		const target = linkTarget(raw);
		const resolved = resolve(target);
		if (resolved && resolved !== path) prereqs.push(resolved);
		else if (!resolved) missingPrereqs.push(target);
	}
	return {
		path,
		title,
		game: asEnum(fm.game, ["genshin", "wuwa"] as const, "genshin"),
		kind: asEnum(fm.kind, KINDS, "other"),
		start: parseDate(fm.start),
		deadline: parseDate(fm.deadline),
		estimate: asMinutes(fm.estimate),
		remaining: asMinutes(fm.remaining),
		suggestedEstimate: asMinutes(fm.suggestedEstimate),
		prereqs: [...new Set(prereqs)],
		missingPrereqs,
		unlock: asList(fm.unlock),
		status: asEnum(fm.status, ["todo", "doing", "done"] as const, "todo"),
		source: typeof fm.source === "string" ? fm.source : undefined,
		url: asUrl(fm.url),
		recurrenceOf: typeof fm.recurrenceOf === "string" ? linkTarget(fm.recurrenceOf) : undefined,
	};
}

function asUrl(v: unknown): string | undefined {
	return typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined;
}

export function parseTemplate(
	path: string,
	title: string,
	fm: Record<string, unknown> | undefined,
): RecurringTemplate | null {
	if (!fm || fm.gtodo !== "recurring" || typeof fm.rule !== "string") return null;
	return {
		path,
		title,
		game: asEnum(fm.game, ["genshin", "wuwa"] as const, "genshin"),
		kind: asEnum(fm.kind, KINDS, "periodic"),
		estimate: asMinutes(fm.estimate),
		rule: fm.rule.trim(),
		prereqLinks: asList(fm.prereqs),
		source: typeof fm.source === "string" ? fm.source : undefined,
		url: asUrl(fm.url),
	};
}

export interface NewTemplateFields {
	game: Game;
	rule: string;
	estimate?: number;
	source?: string;
	url?: string;
}

/** Builds the markdown content of a recurring template note. */
export function buildTemplateNote(f: NewTemplateFields, body = ""): string {
	const lines = ["---", "gtodo: recurring", `game: ${f.game}`, "kind: periodic", `rule: ${yamlString(f.rule)}`];
	lines.push(f.estimate != null ? `estimate: ${f.estimate}` : "estimate:");
	lines.push("prereqs: []");
	if (f.source) lines.push(`source: ${yamlString(f.source)}`);
	if (f.url) lines.push(`url: ${yamlString(f.url)}`);
	lines.push("---", "");
	return lines.join("\n") + body;
}

/** Minutes left to do for an unfinished task (0 when not estimated). */
export function minutesLeft(t: Task): number {
	return t.remaining ?? t.estimate ?? 0;
}

export interface NewTaskFields {
	game: Game;
	kind: Kind;
	start?: number;
	deadline?: number;
	estimate?: number;
	suggestedEstimate?: number;
	prereqLinks?: string[];
	unlock?: string[];
	source?: string;
	url?: string;
	recurrenceOf?: string;
}

function yamlString(s: string): string {
	return JSON.stringify(s);
}

/** Builds the markdown content (frontmatter + body) of a new task note. */
export function buildTaskNote(f: NewTaskFields, body = ""): string {
	const lines = ["---", "gtodo: task", `game: ${f.game}`, `kind: ${f.kind}`];
	if (f.start != null) lines.push(`start: ${formatLocalIso(f.start)}`);
	if (f.deadline != null) lines.push(`deadline: ${formatLocalIso(f.deadline)}`);
	lines.push(f.estimate != null ? `estimate: ${f.estimate}` : "estimate:");
	if (f.suggestedEstimate != null) lines.push(`suggestedEstimate: ${f.suggestedEstimate}`);
	const links = f.prereqLinks ?? [];
	if (links.length) {
		lines.push("prereqs:");
		for (const l of links) lines.push(`  - ${yamlString(l)}`);
	} else {
		lines.push("prereqs: []");
	}
	if (f.unlock?.length) {
		lines.push("unlock:");
		for (const u of f.unlock) lines.push(`  - ${yamlString(u)}`);
	}
	lines.push("status: todo");
	if (f.source) lines.push(`source: ${yamlString(f.source)}`);
	if (f.url) lines.push(`url: ${yamlString(f.url)}`);
	if (f.recurrenceOf) lines.push(`recurrenceOf: ${yamlString(f.recurrenceOf)}`);
	lines.push("---", "");
	return lines.join("\n") + body;
}

/** Strips characters Obsidian does not allow in file names. */
export function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "untitled";
}
