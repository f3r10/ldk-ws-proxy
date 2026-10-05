import * as ldk from "lightningdevkit";
import type { KvStore } from "./kv.js";

export const MONITOR_PREFIX = "monitor/";

/**
 * Persistence for ChannelMonitors, which is the part of a Lightning node where bugs cost
 * money rather than time.
 *
 * The interesting problem is that `Persist` is synchronous - it returns a status - while
 * every durable store a browser has is asynchronous. The wrong fix is to return `Completed`
 * and write in the background: LDK would then act on state it believes is on disk, and a tab
 * closed in that window loses the update. A lost monitor update can mean losing the channel
 * balance, because the counterparty can broadcast an old state you can no longer punish.
 *
 * The right answer is the one LDK provides for exactly this case: return `InProgress`, which
 * tells LDK the channel is stalled until further notice, and report the update as completed
 * once the write has actually landed. In LDK 0.2 that reporting is a queue LDK drains itself,
 * through `get_and_clear_completed_updates` - not a call you make.
 *
 * Note that everything needed from the `monitor` and `update` arguments is read *inside* the
 * callback. Objects handed to a binding callback are not guaranteed to outlive it, so
 * capturing one for the async continuation would be a use-after-free.
 */
export class KvPersist {
	private completed: Array<{ channel_id: Uint8Array; update_id: bigint }> = [];
	private pending = 0;

	constructor(
		private readonly kv: KvStore,
		private readonly log: (line: string) => void = () => {},
	) {}

	/** Monitor writes still in flight. Zero means everything LDK believes is durable, is. */
	public get in_flight(): number {
		return this.pending;
	}

	public as_persist(): ldk.Persist {
		return ldk.Persist.new_impl({
			persist_new_channel: (monitor_name: ldk.MonitorName, monitor: ldk.ChannelMonitor) => {
				return this.write(monitor_name.to_str(), monitor.write(), monitor.channel_id().get_a(),
					monitor.get_latest_update_id(), "new monitor");
			},
			update_persisted_channel: (
				monitor_name: ldk.MonitorName,
				monitor_update: ldk.ChannelMonitorUpdate | null,
				monitor: ldk.ChannelMonitor,
			) => {
				// A null update means the monitor changed for a reason other than an update
				// (a chain event, say), in which case its own latest id is the one to report.
				const update_id = monitor_update === null
					? monitor.get_latest_update_id()
					: monitor_update.get_update_id();
				return this.write(monitor_name.to_str(), monitor.write(), monitor.channel_id().get_a(),
					update_id, "update " + update_id);
			},
			archive_persisted_channel: (monitor_name: ldk.MonitorName) => {
				const key = MONITOR_PREFIX + monitor_name.to_str();
				// Archiving is for monitors LDK no longer needs; losing one is not fatal, so
				// this does not need the InProgress dance.
				void this.kv.remove(key).catch((err: Error) => {
					this.log("could not archive " + key + ": " + err.message);
				});
			},
			get_and_clear_completed_updates: () => {
				const out = this.completed.map((c) =>
					ldk.TwoTuple_ChannelIdu64Z.constructor_new(
						ldk.ChannelId.constructor_new(c.channel_id), c.update_id));
				this.completed = [];
				return out;
			},
		} as ldk.PersistInterface);
	}

	private write(
		name: string,
		bytes: Uint8Array,
		channel_id: Uint8Array,
		update_id: bigint,
		what: string,
	): ldk.ChannelMonitorUpdateStatus {
		const key = MONITOR_PREFIX + name;
		this.pending += 1;
		this.log("persisting " + what + " for " + name.slice(0, 16) + "… (" + bytes.length + " bytes)");

		void this.kv.put(key, bytes).then(
			() => {
				this.pending -= 1;
				// LDK drains this on its next pass and unstalls the channel.
				this.completed.push({ channel_id, update_id });
			},
			(err: Error) => {
				this.pending -= 1;
				// Deliberately never reported complete: the channel stays stalled rather than
				// proceeding on state that is not on disk.
				this.log("PERSISTENCE FAILED for " + key + ": " + err.message +
					" - the channel stays stalled, which is the safe outcome");
			},
		);

		return ldk.ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress;
	}
}
