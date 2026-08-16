export function cachedModuleLoader<Module>(load: () => Promise<Module>): () => Promise<Module> {
	let pending: Promise<Module> | undefined;
	return () => {
		if (!pending) {
			pending = load().catch((error) => {
				pending = undefined;
				throw error;
			});
		}
		return pending;
	};
}

export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException(message, "AbortError");
}
