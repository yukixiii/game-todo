// Minimal stand-in for the "obsidian" module so plugin code can run under vitest.

type FM = Record<string, unknown>;

function parseScalar(v: string): unknown {
	const s = v.trim();
	if (s === "" || s === "null" || s === "~") return null;
	if (s === "[]") return [];
	if (s === "true" || s === "false") return s === "true";
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
	if (s.startsWith('"')) return JSON.parse(s);
	return s;
}

/** Parses the YAML subset produced by buildTaskNote and the template command. */
export function parseFrontmatter(content: string): FM | undefined {
	const m = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!m) return undefined;
	const fm: FM = {};
	let listKey: string | null = null;
	for (const line of m[1].split("\n")) {
		if (/^\s*#/.test(line) || !line.trim()) continue;
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && listKey) {
			((fm[listKey] ??= []) as unknown[]).push(parseScalar(item[1]));
			continue;
		}
		const kv = /^([\w-]+):\s?(.*)$/.exec(line);
		if (!kv) continue;
		const [, k, v] = kv;
		fm[k] = parseScalar(v);
		listKey = v.trim() === "" ? k : null;
	}
	return fm;
}

function dumpFrontmatter(fm: FM): string {
	const lines = ["---"];
	for (const [k, v] of Object.entries(fm)) {
		if (Array.isArray(v)) {
			if (!v.length) lines.push(`${k}: []`);
			else lines.push(`${k}:`, ...v.map((x) => `  - ${JSON.stringify(x)}`));
		} else if (v == null) lines.push(`${k}:`);
		else lines.push(`${k}: ${typeof v === "string" && /[:#\[\]"]/.test(v) ? JSON.stringify(v) : String(v)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

export class TAbstractFile {
	constructor(public path: string) {}
	get name(): string {
		return this.path.split("/").pop()!;
	}
}
export class TFile extends TAbstractFile {
	get basename(): string {
		return this.name.replace(/\.md$/, "");
	}
	get extension(): string {
		return "md";
	}
}
export class TFolder extends TAbstractFile {}

export class FakeApp {
	files = new Map<string, { file: TFile; content: string }>();
	folders = new Set<string>();
	trashed: string[] = [];

	vault = {
		getMarkdownFiles: () => [...this.files.values()].map((f) => f.file),
		getAbstractFileByPath: (p: string) => this.files.get(p)?.file ?? (this.folders.has(p) ? new TFolder(p) : null),
		createFolder: async (p: string) => {
			this.folders.add(p);
		},
		create: async (p: string, content: string) => {
			if (this.files.has(p)) throw new Error(`exists: ${p}`);
			const file = new TFile(p);
			this.files.set(p, { file, content });
			return file;
		},
		process: async (f: TFile, fn: (content: string) => string) => {
			const e = this.files.get(f.path)!;
			e.content = fn(e.content);
			return e.content;
		},
		on: () => ({}),
	};

	metadataCache = {
		getFileCache: (f: TFile) => {
			const e = this.files.get(f.path);
			return e ? { frontmatter: parseFrontmatter(e.content) } : null;
		},
		getFirstLinkpathDest: (link: string) =>
			[...this.files.values()].map((e) => e.file).find((f) => f.basename === link || f.path === `${link}.md`) ?? null,
		on: () => ({}),
		offref: () => {},
	};

	fileManager = {
		processFrontMatter: async (f: TFile, fn: (fm: FM) => void) => {
			const e = this.files.get(f.path)!;
			const fm = parseFrontmatter(e.content) ?? {};
			fn(fm);
			e.content = e.content.replace(/^---\n[\s\S]*?\n---/, dumpFrontmatter(fm));
		},
		trashFile: async (f: TAbstractFile) => {
			this.files.delete(f.path);
			this.trashed.push(f.path);
		},
	};

	workspace = {
		onLayoutReady: () => {},
		getLeavesOfType: () => [],
	};

	write(path: string, content: string): void {
		this.files.set(path, { file: new TFile(path), content });
	}
}

export const notices: string[] = [];
export class Notice {
	constructor(msg: string) {
		notices.push(msg);
	}
	hide(): void {}
}

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export function debounce<T extends (...a: never[]) => unknown>(fn: T): T {
	return fn;
}

export async function requestUrl(): Promise<never> {
	throw new Error("network disabled in tests");
}

export function setIcon(): void {}

export class Plugin {
	constructor(
		public app: FakeApp,
		public manifest: unknown = {},
	) {}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(): Promise<void> {}
}
export class Component {}
export class ItemView {}
export class Modal {
	constructor(public app: unknown) {}
	open(): void {}
	close(): void {}
}
export class PluginSettingTab {}
export class Setting {}
export class WorkspaceLeaf {}
