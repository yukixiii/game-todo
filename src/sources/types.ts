import { Game, Kind } from "../model";
import type { NoteLink } from "./news";

export interface ImportedEvent {
	/** Stable id used for de-duplication, e.g. "hoyoverse-ann:21946". */
	sourceId: string;
	game: Game;
	title: string;
	/** Defaults to "event". */
	kind?: Kind;
	/** Quest catalog entry: has no period, and only its suggested estimate is refreshed on re-import. */
	catalog?: boolean;
	start?: number;
	end?: number;
	/** Original article (or data page for quests); saved as `url` in the frontmatter. */
	url?: string;
	/** How `url` is labelled in the link section (default "元記事"). */
	urlLabel?: string;
	/** Related articles and searches, listed under "## リンク". */
	links?: NoteLink[];
	/** Participation / unlock conditions as plain text lines. */
	conditions?: string[];
	/**
	 * Quest names quoted in the title or conditions; linked as prerequisites when a task note with that
	 * name exists.
	 */
	conditionQuests?: string[];
	/** Source ids of prerequisite items (quest chains). */
	prereqSourceIds?: string[];
	/**
	 * Rough estimate in minutes, shown as a suggestion (never written to `estimate`). Sources give the
	 * raw prediction; the importer applies the user's pace and rounds it (see scaleEstimate).
	 */
	suggestedEstimate?: number;
	/** How the estimate was made, written to the note body. */
	estimateBasis?: string;
	/** Extra markdown appended to the note body. */
	body?: string;
}

/** Minimal HTTP GET returning parsed JSON; injected so sources stay testable without Obsidian. */
export type FetchJson = (url: string, headers?: Record<string, string>) => Promise<unknown>;

export interface Source {
	id: string;
	label: string;
	game: Game;
	fetch(now: number): Promise<ImportedEvent[]>;
}
