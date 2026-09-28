import * as ldk from "lightningdevkit";

export interface MinimalNode {
	keys_manager: ldk.KeysManager;
	logger: ldk.Logger;
	peer_manager: ldk.PeerManager;
	/** Our own node id, 33 compressed bytes. */
	node_id: Uint8Array;
	/**
	 * Every object above, kept reachable. The bindings free the Rust-side memory when JS
	 * drops its last reference, so the handlers have to be rooted somewhere even though
	 * nothing reads them again.
	 */
	_roots: unknown[];
}

/**
 * The smallest object graph that can complete a BOLT-8 handshake and exchange `init`.
 *
 * There is deliberately no ChannelManager, ChainMonitor or NetworkGraph here: none of them
 * are on the path to a connected peer, and leaving them out keeps the milestone honest.
 * `ErroringMessageHandler` advertises the feature bits peers tend to require and rejects
 * any channel message with an error, which is exactly right for a transport spike.
 *
 * @param seed 32 bytes of entropy identifying this node. Regtest only.
 */
export function minimal_peer_manager(seed: Uint8Array, log?: (line: string) => void): MinimalNode {
	if (seed.length != 32) throw new Error("seed must be 32 bytes");

	const logger = ldk.Logger.new_impl({
		log(record: ldk.Record): void {
			if (log) log(record.get_module_path() + ": " + record.get_args());
		},
	} as ldk.LoggerInterface);

	const now_secs = BigInt(Math.floor(Date.now() / 1000));
	const now_nanos = (Date.now() % 1000) * 1000 * 1000;
	const keys_manager = ldk.KeysManager.constructor_new(seed, now_secs, now_nanos, true);
	const node_signer = keys_manager.as_NodeSigner();

	const ignoring = ldk.IgnoringMessageHandler.constructor_new();
	const erroring = ldk.ErroringMessageHandler.constructor_new();
	const chan_handler = erroring.as_ChannelMessageHandler();
	const route_handler = ignoring.as_RoutingMessageHandler();
	const onion_handler = ignoring.as_OnionMessageHandler();
	const custom_handler = ignoring.as_CustomMessageHandler();
	const send_only_handler = ignoring.as_SendOnlyMessageHandler();

	const ephemeral = new Uint8Array(32);
	crypto.getRandomValues(ephemeral);

	const peer_manager = ldk.PeerManager.constructor_new(
		chan_handler,
		route_handler,
		onion_handler,
		custom_handler,
		send_only_handler,
		Math.floor(Date.now() / 1000),
		ephemeral,
		logger,
		node_signer,
	);

	const node_id_res = node_signer.get_node_id(ldk.Recipient.LDKRecipient_Node);
	if (!node_id_res.is_ok()) throw new Error("could not derive our own node id");
	const node_id = (node_id_res as ldk.Result_PublicKeyNoneZ_OK).res;

	return {
		keys_manager,
		logger,
		peer_manager,
		node_id,
		_roots: [ignoring, erroring, chan_handler, route_handler, onion_handler, custom_handler, send_only_handler, node_signer],
	};
}
