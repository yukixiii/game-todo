import { App, normalizePath, TFile } from "obsidian";
import { Game, GAME_LABEL, parseTask, parseTemplate, RecurringTemplate, safeFileName, Status, Task } from "./model";

/** Vault access for task and template notes. */
export class TaskRepo {
	constructor(
		private app: App,
		private root: () => string,
	) {}

	tasksFolder(game: Game): string {
		return normalizePath(`${this.root()}/Tasks/${GAME_LABEL[game]}`);
	}
	recurringFolder(): string {
		return normalizePath(`${this.root()}/Recurring`);
	}
	inboxFolder(): string {
		return normalizePath(`${this.root()}/Inbox`);
	}

	private frontmatter(file: TFile): Record<string, unknown> | undefined {
		return this.app.metadataCache.getFileCache(file)?.frontmatter;
	}

	loadTasks(): Task[] {
		const out: Task[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.frontmatter(file);
			if (fm?.gtodo !== "task") continue;
			const t = parseTask(file.path, file.basename, fm, (link) => {
				const dest = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
				return dest ? dest.path : null;
			});
			if (t) out.push(t);
		}
		// Prerequisites pointing at non-task notes are treated as missing.
		const paths = new Set(out.map((t) => t.path));
		for (const t of out) {
			const missing = t.prereqs.filter((p) => !paths.has(p));
			if (missing.length) {
				t.prereqs = t.prereqs.filter((p) => paths.has(p));
				t.missingPrereqs.push(...missing.map((p) => p.replace(/\.md$/, "")));
			}
		}
		return out;
	}

	loadTemplates(): RecurringTemplate[] {
		const out: RecurringTemplate[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const t = parseTemplate(file.path, file.basename, this.frontmatter(file));
			if (t) out.push(t);
		}
		return out;
	}

	file(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	exists(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(normalizePath(path)) != null;
	}

	async ensureFolder(folder: string): Promise<void> {
		const parts = normalizePath(folder).split("/");
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur);
		}
	}

	/** Creates `<folder>/<title>.md`, adding " 2", " 3"... if the name is taken. */
	async create(folder: string, title: string, content: string): Promise<TFile> {
		await this.ensureFolder(folder);
		const base = safeFileName(title);
		let path = normalizePath(`${folder}/${base}.md`);
		for (let i = 2; this.exists(path); i++) path = normalizePath(`${folder}/${base} ${i}.md`);
		return this.app.vault.create(path, content);
	}

	async update(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void> {
		const f = this.file(path);
		if (f) await this.app.fileManager.processFrontMatter(f, fn);
	}

	/** Rewrites the whole content of a note. */
	async processContent(path: string, fn: (content: string) => string): Promise<void> {
		const f = this.file(path);
		if (f) await this.app.vault.process(f, fn);
	}

	setStatus(path: string, status: Status): Promise<void> {
		return this.update(path, (fm) => {
			fm.status = status;
		});
	}

	async trash(path: string): Promise<void> {
		const f = this.file(path);
		if (f) await this.app.fileManager.trashFile(f);
	}
}
