import * as ldk from "lightningdevkit";

/** Talks to the `ldk-chain-proxy` endpoints. Swap this for an Esplora client on a real chain. */
export class ChainClient {
	constructor(public readonly base_url: string) {}

	private async get(path: string): Promise<any> {
		const res = await fetch(this.base_url + path);
		const body = await res.json();
		if (!res.ok) throw new Error(path + ": " + (body?.error ?? res.status));
		return body;
	}
	private async post(path: string, payload: unknown): Promise<any> {
		const res = await fetch(this.base_url + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		const body = await res.json();
		if (!res.ok) throw new Error(path + ": " + (body?.error ?? res.status));
		return body;
	}

	tip(): Promise<{ height: number; hash: string }> {
		return this.get("/chain/tip");
	}
	async block_hash(height: number): Promise<string> {
		return (await this.get("/chain/block-hash/" + height)).hash;
	}
	async block(hash: string): Promise<Uint8Array> {
		return from_hex((await this.get("/chain/block/" + hash)).hex);
	}
	async broadcast(tx: Uint8Array): Promise<string> {
		return (await this.post("/chain/broadcast", { hex: to_hex(tx) })).txid;
	}
	async confirmations(txid: string): Promise<number> {
		return (await this.get("/chain/tx/" + txid)).confirmations;
	}

	/** Dev only: build and sign a transaction paying `script`, standing in for a wallet. */
	async fund(script: Uint8Array, amount_sat: number): Promise<Uint8Array> {
		const res = await this.post("/dev/fund", { script_hex: to_hex(script), amount_sat });
		return from_hex(res.hex);
	}
	/** Dev only: mine blocks. */
	async mine(blocks: number): Promise<string[]> {
		return (await this.post("/dev/mine", { blocks })).hashes;
	}
}

export interface ChainSyncOptions {
	/** How often to look for a new tip. Default 2s - regtest moves when you tell it to. */
	poll_ms?: number;
	/**
	 * How far back to walk looking for a common block after a reorg. Default 100.
	 */
	max_reorg_depth?: number;
	log?: (line: string) => void;
}

/**
 * Feeds blocks to everything in the node that implements `Listen`.
 *
 * This hands LDK whole blocks rather than the filtered view a `Confirm`-based sync would use.
 * On regtest that is the simplest thing that is actually correct: blocks are small, there are
 * few of them, and there is no bookkeeping to get wrong about which transactions are relevant.
 * It would be hopeless on mainnet, which is what `lightning-transaction-sync` and an Esplora
 * backend are for - and which the TypeScript bindings do not currently expose.
 */
export class ChainSync {
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;
	private stopped = false;
	private readonly opts: Required<Omit<ChainSyncOptions, "log">> & { log: (line: string) => void };
	/** Hashes of blocks we have fed, by height, so a reorg can be spotted and walked back. */
	private readonly seen = new Map<number, string>();

	constructor(
		private readonly chain: ChainClient,
		private readonly listeners: ldk.Listen[],
		public height: number,
		public tip_hash: string,
		options: ChainSyncOptions = {},
	) {
		this.opts = {
			poll_ms: options.poll_ms ?? 2000,
			max_reorg_depth: options.max_reorg_depth ?? 100,
			log: options.log ?? (() => {}),
		};
		this.seen.set(height, tip_hash);
	}

	public start(): void {
		if (this.timer !== undefined) return;
		this.timer = setInterval(() => void this.poll(), this.opts.poll_ms);
		void this.poll();
	}

	public stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Catch up to the current tip. Safe to call directly; polls do the same thing. */
	public async poll(): Promise<void> {
		if (this.running || this.stopped) return;
		this.running = true;
		try {
			const tip = await this.chain.tip();
			while (!this.stopped && this.height < tip.height) {
				const next = this.height + 1;
				const hash = await this.chain.block_hash(next);
				const parent_hash = this.seen.get(this.height);
				if (parent_hash !== undefined && !(await this.connects_to(hash, parent_hash))) {
					await this.handle_reorg();
					continue;
				}
				const block = await this.chain.block(hash);
				for (const listener of this.listeners) listener.block_connected(block, next);
				this.height = next;
				this.tip_hash = hash;
				this.seen.set(next, hash);
				this.opts.log("connected block " + next + " " + hash.slice(0, 16) + "…");
			}
		} catch (err) {
			this.opts.log("sync error: " + (err instanceof Error ? err.message : String(err)));
		} finally {
			this.running = false;
		}
	}

	/** Does the block at `hash` build on the block we think is the tip? */
	private async connects_to(hash: string, parent_hash: string): Promise<boolean> {
		const block = await this.chain.block(hash);
		// The header's prev-block field: bytes 4..36, little-endian, so reversed as hex.
		const prev = to_hex(block.slice(4, 36).reverse());
		return prev === parent_hash;
	}

	/**
	 * Walk back to the highest block both views agree on, then tell LDK about it once.
	 *
	 * LDK 0.2 takes the fork point rather than each disconnected block: `blocks_disconnected`
	 * is called with the highest block still in both chains, not once per orphan.
	 */
	private async handle_reorg(): Promise<void> {
		this.opts.log("reorg detected at height " + this.height + "; walking back");
		for (let height = this.height; height > this.height - this.opts.max_reorg_depth; height--) {
			const ours = this.seen.get(height);
			const theirs = await this.chain.block_hash(height).catch(() => undefined);
			if (ours === undefined || theirs === undefined || ours !== theirs) continue;

			const fork_point = ldk.BestBlock.constructor_new(reverse(from_hex(ours)), height);
			for (const listener of this.listeners) listener.blocks_disconnected(fork_point);
			for (let above = height + 1; above <= this.height; above++) this.seen.delete(above);
			this.height = height;
			this.tip_hash = ours;
			this.opts.log("rewound to the fork point at height " + height);
			return;
		}
		throw new Error("reorg deeper than " + this.opts.max_reorg_depth + " blocks");
	}
}

export function to_hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function reverse(bytes: Uint8Array): Uint8Array {
	return bytes.slice().reverse();
}

export function from_hex(hex: string): Uint8Array {
	const clean = hex.trim();
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	return out;
}
