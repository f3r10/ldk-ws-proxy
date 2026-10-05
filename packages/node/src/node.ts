import * as ldk from "lightningdevkit";
import { ChainClient, ChainSync, to_hex } from "./chain.js";
import { KvPersist } from "./persist.js";
import type { KvStore } from "./kv.js";

export const MANAGER_KEY = "manager";

export interface FullNodeOptions {
	/** 32 bytes identifying this node. Regtest only; this is not a backup scheme. */
	seed: Uint8Array;
	chain: ChainClient;
	kv: KvStore;
	/** Defaults to regtest. Nothing here is safe on anything else. */
	network?: ldk.Network;
	/** Our own trace. */
	log?: (line: string) => void;
	/** LDK's trace, which is verbose. */
	ldk_log?: (line: string) => void;
	/** Called for every LDK event after the node has handled it. */
	on_event?: (name: string, detail: string) => void;
	chain_poll_ms?: number;
}

/** A node with channels: everything M2's `minimal_peer_manager` deliberately left out. */
export interface FullNode {
	node_id: Uint8Array;
	keys_manager: ldk.KeysManager;
	logger: ldk.Logger;
	chain_monitor: ldk.ChainMonitor;
	channel_manager: ldk.ChannelManager;
	peer_manager: ldk.PeerManager;
	network_graph: ldk.NetworkGraph;
	persist: KvPersist;
	chain_sync: ChainSync;
	chain: ChainClient;
	/** Run the event queues now. Called on a timer, and after anything that makes events. */
	process_events(): void;
	/** Serialise the ChannelManager. Monitors persist themselves; this does not. */
	persist_manager(): Promise<void>;
	open_channel(peer_node_id: Uint8Array, amount_sat: number, push_msat?: number): ldk.ChannelId;
	create_invoice(amount_msat: bigint | undefined, description: string): string;
	/** Pay a BOLT-11 invoice. Resolves when LDK accepts it, not when it settles. */
	pay_invoice(invoice: string): void;
	stop(): void;
	/** Everything that must stay reachable so the bindings do not free it. */
	_roots: unknown[];
}

/**
 * Builds the full object graph, in the order LDK requires: things with no dependencies
 * first, the ChainMonitor before the ChannelManager (which needs it as a `Watch`), and the
 * PeerManager last, because it needs the ChannelManager as its channel message handler.
 */
export async function start_full_node(options: FullNodeOptions): Promise<FullNode> {
	const log = options.log ?? (() => {});
	const ldk_log = options.ldk_log;
	const on_event = options.on_event ?? (() => {});
	const network = options.network ?? ldk.Network.LDKNetwork_Regtest;
	if (options.seed.length != 32) throw new Error("seed must be 32 bytes");

	const logger = ldk.Logger.new_impl({
		log(record: ldk.Record): void {
			if (ldk_log) ldk_log(record.get_module_path() + ": " + record.get_args());
		},
	} as ldk.LoggerInterface);

	// Regtest has no fee market worth asking about: estimatesmartfee returns nothing useful
	// on a chain where blocks appear when you say so. These are static and plausible; a real
	// node would ask the chain backend, and must never return below 253 sat/kw.
	const fee_estimator = ldk.FeeEstimator.new_impl({
		get_est_sat_per_1000_weight(_target: ldk.ConfirmationTarget): number {
			return 2000;
		},
	} as ldk.FeeEstimatorInterface);

	const broadcaster = ldk.BroadcasterInterface.new_impl({
		broadcast_transactions(txs: Uint8Array[]): void {
			for (const tx of txs) {
				const hex = to_hex(tx);
				// Fire and forget: LDK has no way to hear about a failure here, and will
				// rebroadcast on its own.
				void options.chain.broadcast(tx).then(
					(txid) => log("broadcast " + txid),
					(err: Error) => log("broadcast failed: " + err.message + " (" + hex.slice(0, 32) + "…)"),
				);
			}
		},
	} as ldk.BroadcasterInterfaceInterface);

	const persist = new KvPersist(options.kv, log);
	const keys_manager = make_keys_manager(options.seed);
	const entropy_source = keys_manager.as_EntropySource();
	const node_signer = keys_manager.as_NodeSigner();
	const signer_provider = keys_manager.as_SignerProvider();

	const peer_storage_key = ldk.PeerStorageKey.constructor_new(derive_key(options.seed, 1));
	const chain_monitor = ldk.ChainMonitor.constructor_new(
		// No Filter: we feed whole blocks, so there is nothing to register interest in.
		ldk.Option_FilterZ.constructor_none(),
		broadcaster, logger, fee_estimator, persist.as_persist(), entropy_source, peer_storage_key,
	);

	const network_graph = ldk.NetworkGraph.constructor_new(network, logger);
	const scorer = ldk.ProbabilisticScorer.constructor_new(
		ldk.ProbabilisticScoringDecayParameters.constructor_default(), network_graph, logger);
	const score_params = ldk.ProbabilisticScoringFeeParameters.constructor_default();
	const lockable_score = ldk.MultiThreadedLockableScore.constructor_new(scorer.as_Score());
	const router = ldk.DefaultRouter.constructor_new(
		network_graph, logger, entropy_source, lockable_score.as_LockableScore(), score_params);
	const message_router = ldk.DefaultMessageRouter.constructor_new(network_graph, entropy_source);

	const tip = await options.chain.tip();
	log("starting at height " + tip.height + " (" + tip.hash.slice(0, 16) + "…)");
	const best_block = ldk.BestBlock.constructor_new(reverse(hex_bytes(tip.hash)), tip.height);
	const config = ldk.UserConfig.constructor_default();
	const channel_manager = ldk.ChannelManager.constructor_new(
		fee_estimator, chain_monitor.as_Watch(), broadcaster, router.as_Router(),
		message_router.as_MessageRouter(), logger, entropy_source, node_signer, signer_provider,
		config, ldk.ChainParameters.constructor_new(network, best_block),
		Math.floor(Date.now() / 1000),
	);

	const ignoring = ldk.IgnoringMessageHandler.constructor_new();
	const peer_manager = ldk.PeerManager.constructor_new(
		channel_manager.as_ChannelMessageHandler(),
		// No gossip: a node with one channel to one peer routes nothing, and syncing the
		// graph is both pointless here and the most expensive thing a browser could do.
		ignoring.as_RoutingMessageHandler(),
		ignoring.as_OnionMessageHandler(),
		ignoring.as_CustomMessageHandler(),
		ignoring.as_SendOnlyMessageHandler(),
		Math.floor(Date.now() / 1000), random_bytes(32), logger, node_signer,
	);

	const node_id_res = node_signer.get_node_id(ldk.Recipient.LDKRecipient_Node);
	if (!node_id_res.is_ok()) throw new Error("could not derive our node id");
	const node_id = (node_id_res as ldk.Result_PublicKeyNoneZ_OK).res;

	const chain_sync = new ChainSync(
		options.chain,
		[chain_monitor.as_Listen(), channel_manager.as_Listen()],
		tip.height, tip.hash,
		{ poll_ms: options.chain_poll_ms, log },
	);

	// --- events -----------------------------------------------------------------------------
	const handler = ldk.EventHandler.new_impl({
		handle_event: (event: ldk.Event) => {
			try {
				handle(event);
			} catch (err) {
				log("event handler threw: " + (err instanceof Error ? err.message : String(err)));
			}
			return ldk.Result_NoneReplayEventZ.constructor_ok();
		},
	} as ldk.EventHandlerInterface);

	function handle(event: ldk.Event): void {
		if (event instanceof ldk.Event_FundingGenerationReady) {
			// A browser has no on-chain wallet, so the chain proxy builds and signs this.
			// Everything else in this function is what a real node does; this one line is
			// the regtest shortcut.
			const temp_id = event.temporary_channel_id;
			const counterparty = event.counterparty_node_id;
			const value = Number(event.channel_value_satoshis);
			const script = event.output_script;
			on_event("FundingGenerationReady", value + " sat");
			void options.chain.fund(script, value).then(
				(tx) => {
					const res = channel_manager.funding_transaction_generated(temp_id, counterparty, tx);
					if (!res.is_ok()) {
						log("funding_transaction_generated rejected the transaction");
						on_event("FundingFailed", "LDK rejected the funding transaction");
						return;
					}
					log("funding transaction handed to LDK (" + tx.length + " bytes)");
					node.process_events();
				},
				(err: Error) => {
					log("could not fund the channel: " + err.message);
					on_event("FundingFailed", err.message);
				},
			);
		} else if (event instanceof ldk.Event_ChannelPending) {
			on_event("ChannelPending", "waiting for the funding transaction to confirm");
		} else if (event instanceof ldk.Event_ChannelReady) {
			on_event("ChannelReady", "channel is usable");
		} else if (event instanceof ldk.Event_ChannelClosed) {
			on_event("ChannelClosed", "channel closed");
		} else if (event instanceof ldk.Event_PaymentClaimable) {
			const amount = event.amount_msat;
			const purpose = event.purpose;
			const preimage = preimage_of(purpose);
			if (preimage === undefined) {
				log("payment claimable with no preimage; letting it expire");
				on_event("PaymentClaimable", "no preimage, cannot claim");
				return;
			}
			on_event("PaymentClaimable", amount + " msat");
			channel_manager.claim_funds(preimage);
			node.process_events();
		} else if (event instanceof ldk.Event_PaymentClaimed) {
			on_event("PaymentClaimed", event.amount_msat + " msat received");
		} else if (event instanceof ldk.Event_PaymentSent) {
			on_event("PaymentSent", "payment settled");
		} else if (event instanceof ldk.Event_PaymentFailed) {
			on_event("PaymentFailed", "payment failed");
		} else if (event instanceof ldk.Event_SpendableOutputs) {
			// A real node sweeps these to its wallet. Regtest: note them and move on.
			on_event("SpendableOutputs", "on-chain outputs are spendable (not swept)");
		} else {
			on_event(event.constructor.name.replace("Event_", ""), "");
		}
	}

	const node: FullNode = {
		node_id, keys_manager, logger, chain_monitor, channel_manager, peer_manager,
		network_graph, persist, chain_sync, chain: options.chain,

		process_events(): void {
			channel_manager.as_EventsProvider().process_pending_events(handler);
			chain_monitor.as_EventsProvider().process_pending_events(handler);
			peer_manager.process_events();
		},

		async persist_manager(): Promise<void> {
			await options.kv.put(MANAGER_KEY, channel_manager.write());
		},

		open_channel(peer_node_id: Uint8Array, amount_sat: number, push_msat = 0): ldk.ChannelId {
			const res = channel_manager.create_channel(
				peer_node_id, BigInt(amount_sat), BigInt(push_msat), BigInt(Date.now()), null, null);
			if (!res.is_ok()) throw new Error("create_channel was rejected by LDK");
			node.process_events();
			return (res as ldk.Result_ChannelIdAPIErrorZ_OK).res;
		},

		create_invoice(amount_msat: bigint | undefined, description: string): string {
			const res = channel_manager.create_bolt11_invoice(
				amount_msat === undefined
					? ldk.Option_u64Z.constructor_none()
					: ldk.Option_u64Z.constructor_some(amount_msat),
				ldk.Bolt11InvoiceDescription.constructor_direct(
					(ldk.Description.constructor_new(description) as ldk.Result_DescriptionCreationErrorZ_OK).res),
				ldk.Option_u32Z.constructor_some(3600),
				ldk.Option_u16Z.constructor_none(),
				ldk.Option_ThirtyTwoBytesZ.constructor_none(),
			);
			if (!res.is_ok()) throw new Error("could not create an invoice");
			return (res as ldk.Result_Bolt11InvoiceSignOrCreationErrorZ_OK).res.to_str();
		},

		pay_invoice(invoice: string): void {
			const parsed = ldk.Bolt11Invoice.constructor_from_str(invoice);
			if (!parsed.is_ok()) throw new Error("could not parse the invoice");
			const res = channel_manager.pay_for_bolt11_invoice(
				(parsed as ldk.Result_Bolt11InvoiceParseOrSemanticErrorZ_OK).res,
				random_bytes(32),
				ldk.Option_u64Z.constructor_none(),
				ldk.RouteParametersConfig.constructor_default(),
				ldk.Retry.constructor_attempts(3),
			);
			if (!res.is_ok()) throw new Error("LDK refused to send the payment");
			node.process_events();
		},

		stop(): void {
			chain_sync.stop();
			clearInterval(tick_timer);
			clearInterval(event_timer);
		},

		_roots: [ignoring, fee_estimator, broadcaster, entropy_source, node_signer, signer_provider,
			scorer, lockable_score, router, message_router, handler, peer_storage_key, config],
	};

	// LDK asks for timer_tick_occurred roughly once a minute on the ChannelManager, and
	// process_pending_htlc_forwards has to be driven by someone now that LDK no longer emits
	// a PendingHTLCsForwardable event to remind you.
	const tick_timer = setInterval(() => {
		channel_manager.timer_tick_occurred();
		node.process_events();
	}, 60_000);
	const event_timer = setInterval(() => {
		channel_manager.process_pending_htlc_forwards();
		node.process_events();
	}, 1_000);

	chain_sync.start();
	return node;
}

function preimage_of(purpose: ldk.PaymentPurpose): Uint8Array | undefined {
	const option: ldk.Option_ThirtyTwoBytesZ | undefined =
		purpose instanceof ldk.PaymentPurpose_Bolt11InvoicePayment ? purpose.payment_preimage :
		purpose instanceof ldk.PaymentPurpose_Bolt12OfferPayment ? purpose.payment_preimage :
		purpose instanceof ldk.PaymentPurpose_Bolt12RefundPayment ? purpose.payment_preimage :
		purpose instanceof ldk.PaymentPurpose_SpontaneousPayment ? undefined : undefined;
	if (purpose instanceof ldk.PaymentPurpose_SpontaneousPayment) return purpose.spontaneous_payment;
	if (option instanceof ldk.Option_ThirtyTwoBytesZ_Some) return option.some;
	return undefined;
}

function make_keys_manager(seed: Uint8Array): ldk.KeysManager {
	const now = Date.now();
	return ldk.KeysManager.constructor_new(seed, BigInt(Math.floor(now / 1000)), (now % 1000) * 1e6, true);
}

function random_bytes(n: number): Uint8Array {
	const bytes = new Uint8Array(n);
	crypto.getRandomValues(bytes);
	return bytes;
}

/** A crude deterministic sub-key. Fine for regtest; a real node derives these properly. */
function derive_key(seed: Uint8Array, index: number): Uint8Array {
	const out = seed.slice();
	out[0] ^= index;
	return out;
}

function hex_bytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function reverse(bytes: Uint8Array): Uint8Array {
	return bytes.slice().reverse();
}
