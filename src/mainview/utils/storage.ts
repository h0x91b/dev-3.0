export function storageIsWritable(storage: Storage, probeKey: string): boolean {
	try {
		storage.setItem(probeKey, "1");
		const stored = storage.getItem(probeKey) === "1";
		storage.removeItem(probeKey);
		return stored;
	} catch {
		return false;
	}
}
