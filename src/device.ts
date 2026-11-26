/**
 * Settings that belong to this device rather than to the vault. They live in localStorage, so sync
 * plugins (Self-hosted LiveSync and the like) never copy them along with data.json.
 */
export interface DeviceSettings {
	/**
	 * Run housekeeping (create this period's recurring instances, trash expired ones) automatically.
	 * Turn off on devices that mostly view: they start with stale files until sync catches up, and
	 * their automatic creates/deletes then conflict with edits made on the main device.
	 */
	autoHousekeeping: boolean;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { autoHousekeeping: true };

function storage(): Storage | undefined {
	try {
		return globalThis.localStorage ?? undefined;
	} catch {
		return undefined;
	}
}

export function loadDeviceSettings(key: string): DeviceSettings {
	try {
		const raw = storage()?.getItem(key);
		return { ...DEFAULT_DEVICE_SETTINGS, ...(raw ? (JSON.parse(raw) as Partial<DeviceSettings>) : {}) };
	} catch {
		return { ...DEFAULT_DEVICE_SETTINGS };
	}
}

export function saveDeviceSettings(key: string, s: DeviceSettings): void {
	storage()?.setItem(key, JSON.stringify(s));
}
