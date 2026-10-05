/**
 * The smallest key/value interface a Lightning node needs, with the two implementations this
 * project uses: IndexedDB in a browser, memory in tests.
 *
 * Everything here is async, which is the whole problem - see persist.ts.
 */
export interface KvStore {
	get(key: string): Promise<Uint8Array | undefined>;
	put(key: string, value: Uint8Array): Promise<void>;
	remove(key: string): Promise<void>;
	list(prefix: string): Promise<string[]>;
}

export class MemoryKv implements KvStore {
	private readonly map = new Map<string, Uint8Array>();

	async get(key: string): Promise<Uint8Array | undefined> {
		return this.map.get(key);
	}
	async put(key: string, value: Uint8Array): Promise<void> {
		this.map.set(key, value.slice());
	}
	async remove(key: string): Promise<void> {
		this.map.delete(key);
	}
	async list(prefix: string): Promise<string[]> {
		return Array.from(this.map.keys()).filter((k) => k.startsWith(prefix));
	}
	/** Test helper: how many bytes are being held, and under what. */
	get summary(): string {
		return Array.from(this.map.entries()).map(([k, v]) => k + "=" + v.length + "B").join(", ");
	}
}

/**
 * IndexedDB, which is the only durable storage a browser tab has that is big enough and not
 * synchronous.
 *
 * Channel state is consensus-critical: losing a ChannelMonitor loses money. localStorage is
 * the wrong tool (5-10 MB, string-only, and cleared by "clear site data" more eagerly), and
 * neither store is a substitute for a real backup on anything but regtest.
 */
export class IndexedDbKv implements KvStore {
	private db: IDBDatabase | undefined;

	constructor(private readonly db_name = "ldk-ws-node", private readonly store_name = "kv") {}

	private async open(): Promise<IDBDatabase> {
		if (this.db !== undefined) return this.db;
		this.db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(this.db_name, 1);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(this.store_name)) {
					req.result.createObjectStore(this.store_name);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error ?? new Error("could not open IndexedDB"));
		});
		return this.db;
	}

	private async tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
		const db = await this.open();
		return new Promise<T>((resolve, reject) => {
			const transaction = db.transaction(this.store_name, mode);
			const req = run(transaction.objectStore(this.store_name));
			req.onsuccess = () => resolve(req.result as T);
			req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
			// Resolving on the request is not enough for durability: the write is only really
			// done when the transaction commits.
			transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
		});
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		const value = await this.tx<ArrayBuffer | undefined>("readonly", (s) => s.get(key));
		return value === undefined ? undefined : new Uint8Array(value);
	}
	async put(key: string, value: Uint8Array): Promise<void> {
		// Store a copy: the caller's view may be backed by WASM memory that moves.
		const copy = value.slice();
		await this.tx("readwrite", (s) => s.put(copy.buffer, key));
	}
	async remove(key: string): Promise<void> {
		await this.tx("readwrite", (s) => s.delete(key));
	}
	async list(prefix: string): Promise<string[]> {
		const keys = await this.tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
		return keys.map(String).filter((k) => k.startsWith(prefix));
	}
}
