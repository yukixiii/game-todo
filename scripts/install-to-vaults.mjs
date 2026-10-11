// esbuild plugin: after each successful build, copy the plugin's runtime files into every
// vault on this machine that already has `.obsidian/plugins/<id>/`.
// To start using the plugin in a vault, create that folder once.
// Set OBSIDIAN_VAULTS (separated by ";" on Windows, ":" elsewhere) to override vault discovery.
import { existsSync, realpathSync } from "fs";
import { copyFile, readFile } from "fs/promises";
import os from "os";
import path from "path";

const FILES = ["main.js", "manifest.json", "styles.css"];

function obsidianConfigPath() {
	if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", "obsidian", "obsidian.json");
	if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/obsidian/obsidian.json");
	return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "obsidian", "obsidian.json");
}

async function vaultPaths() {
	if (process.env.OBSIDIAN_VAULTS) return process.env.OBSIDIAN_VAULTS.split(path.delimiter).filter(Boolean);
	try {
		const cfg = JSON.parse(await readFile(obsidianConfigPath(), "utf8"));
		return Object.values(cfg.vaults ?? {}).map((v) => v.path);
	} catch {
		return [];
	}
}

export const installToVaults = {
	name: "install-to-vaults",
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length) return;
			const { id } = JSON.parse(await readFile("manifest.json", "utf8"));
			for (const vault of await vaultPaths()) {
				const dest = path.join(vault, ".obsidian", "plugins", id);
				if (!existsSync(dest)) continue;
				// A junction/symlink back to this repo would make us copy files onto themselves.
				if (realpathSync(dest) === realpathSync(process.cwd())) continue;
				try {
					for (const f of FILES) await copyFile(f, path.join(dest, f));
					console.log(`installed to ${dest}`);
				} catch (e) {
					console.warn(`failed to install to ${dest}: ${e.message}`);
				}
			}
		});
	},
};
