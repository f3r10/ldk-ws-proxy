/**
 * Builds the URL for a `ldk-ws-proxy` (or Mutiny `ln-websocket-proxy`) endpoint:
 * `<base>/v1/<host>/<port>`.
 *
 * Nothing forces you through a proxy - a Core Lightning node started with
 * `bind-addr=ws:0.0.0.0:<port>` speaks the peer protocol over WebSocket directly, in which
 * case pass `ws://host:port` to `connect_peer` and skip this.
 */
export function proxy_url(base: string, host: string, port: number): string {
	const trimmed = base.replace(/\/+$/, "");
	return trimmed + "/v1/" + encodeURIComponent(host) + "/" + port;
}
