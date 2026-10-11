import { Game } from "../model";

export interface ImportedEvent {
	/** Stable id used for de-duplication, e.g. "hoyoverse-ann:21946". */
	sourceId: string;
	game: Game;
	title: string;
	start?: number;
	end?: number;
	url?: string;
}

/** Minimal HTTP GET returning parsed JSON; injected so sources stay testable without Obsidian. */
export type FetchJson = (url: string) => Promise<unknown>;

export interface Source {
	id: string;
	label: string;
	game: Game;
	fetch(now: number): Promise<ImportedEvent[]>;
}
