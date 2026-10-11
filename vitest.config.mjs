import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

// Fixed zone so local-time expectations are deterministic (workers inherit env).
process.env.TZ = "Asia/Tokyo";

export default defineConfig({
	resolve: { alias: { obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)) } },
	test: { include: ["tests/**/*.test.ts"] },
});
