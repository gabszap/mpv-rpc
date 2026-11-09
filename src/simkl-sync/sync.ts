import { config } from "../core/config";
import type { MpvData } from "../integrations/mpv";
import { sendScrobble } from "./api";
import { getAuthSession } from "./auth";
import { resolveSimklIdentity } from "./identity";
import { SimklApiError, type SimklEvent, type SimklPayload } from "./types";

export interface SimklSettings {
    enabled: boolean;
    clientId: string;
    sessionKey: string | null;
    threshold: number;
    dryRun: boolean;
}
interface Session {
    serial: number;
    file: string;
    payload: SimklPayload;
    settings: SimklSettings;
    progress: number;
    pause: boolean;
    time: number;
    observedAt: number;
    seekPending: boolean;
}
interface QueuedEvent {
    event: SimklEvent;
    serial: number;
    retries: number;
    due: number;
}

/** Playback observations are synchronous; all network writes use one serial worker. */
export class SimklScrobbler {
    private active: Session | null = null;
    private queue: QueuedEvent[] = [];
    private serial = 0;
    private busy = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private dryRun = false;
    private generation = 0;
    private retryNotBefore = 0;
    private blockedGrants = new Set<string>();
    private lastMissingFile: string | null = null;

    constructor(private readonly send: (event: SimklEvent) => Promise<void> = sendScrobble) {}

    configure(settings: SimklSettings): void {
        if (settings.dryRun !== this.dryRun) {
            // A simulated session must never consume or replay real account events.
            this.active = null;
            this.queue = [];
            this.dryRun = settings.dryRun;
            this.generation++;
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
        }
        if (
            this.active &&
            (!settings.enabled ||
                !settings.clientId ||
                (!settings.sessionKey && !settings.dryRun) ||
                this.active.settings.clientId !== settings.clientId ||
                this.active.settings.sessionKey !== settings.sessionKey)
        ) {
            this.stop();
        }
    }

    update(data: MpvData, settings: SimklSettings): void {
        this.configure(settings);
        if (!settings.enabled || !settings.clientId || (!settings.sessionKey && !settings.dryRun)) return;
        const file = JSON.stringify([data.path ?? data.filename, data.playlistPos]);
        const identity = resolveSimklIdentity(data);
        if (this.active && this.active.file !== file) {
            this.stop();
        }
        const progress = data.percent_pos;
        if (!Number.isFinite(progress) || progress < 0 || progress > 100) return;
        if (!this.active) {
            if (!identity) {
                if (file !== this.lastMissingFile)
                    console.log(`[Simkl] Skipped: no reliable identity for "${data.series_title}".`);
                this.lastMissingFile = file;
                return;
            }
            this.lastMissingFile = null;
            this.active = {
                serial: ++this.serial,
                file,
                payload: identity.payload,
                settings: { ...settings },
                progress,
                pause: data.pause,
                time: data.time_pos,
                observedAt: Date.now(),
                seekPending: false,
            };
            this.enqueue(this.active, data.pause ? "pause" : "start");
            return;
        }
        const session = this.active;
        const elapsed = (Date.now() - session.observedAt) / 1000;
        const expected = session.time + (session.pause ? 0 : elapsed);
        const jumped = Number.isFinite(data.time_pos) && Math.abs(data.time_pos - expected) > 15;
        session.progress = progress;
        session.time = data.time_pos;
        session.observedAt = Date.now();
        if (data.pause !== session.pause) {
            session.pause = data.pause;
            session.seekPending = false;
            this.enqueue(session, data.pause ? "pause" : "start");
        } else if (jumped) {
            session.seekPending = true;
        } else if (session.seekPending) {
            session.seekPending = false;
            this.enqueue(session, data.pause ? "pause" : "start");
        }
    }

    stop(): void {
        if (!this.active) return;
        this.enqueue(this.active, "stop");
        this.active = null;
    }

    private enqueue(session: Session, action: SimklEvent["action"]): void {
        const event: SimklEvent = {
            action,
            payload: session.payload,
            progress: session.progress,
            threshold: session.settings.threshold,
            clientId: session.settings.clientId,
            sessionKey: session.settings.sessionKey ?? "dry-run",
        };
        if (session.settings.dryRun) {
            console.log(`[Simkl] Dry-run: ${action} at ${event.progress.toFixed(1)}%.`);
            return;
        }
        const grant = `${event.clientId}:${event.sessionKey}`;
        if (this.blockedGrants.has(grant)) return;
        this.queue = this.queue.filter((item) => item.serial !== session.serial || item.event.action === "stop");
        if (this.queue.length >= 128) {
            console.warn("[Simkl] Pending queue full; dropping oldest unsent event.");
            this.queue.shift();
        }
        this.queue.push({ event, serial: session.serial, retries: 0, due: 0 });
        this.wake();
    }

    private wake(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (!this.busy) void this.drain();
    }

    private async drain(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            while (this.queue.length) {
                const item = this.queue[0];
                const delay = Math.max(item.due, this.retryNotBefore) - Date.now();
                if (delay > 0) {
                    this.timer = setTimeout(() => {
                        this.timer = null;
                        void this.drain();
                    }, delay);
                    this.timer.unref?.();
                    return;
                }
                this.queue.shift();
                const grant = `${item.event.clientId}:${item.event.sessionKey}`;
                if (this.blockedGrants.has(grant)) continue;
                const generation = this.generation;
                try {
                    await this.send(item.event);
                    if (generation !== this.generation) continue;
                    if (item.event.action === "stop") {
                        const result = item.event.progress >= item.event.threshold ? "watched" : "partial progress";
                        console.log(`[Simkl] Saved ${result} (${item.event.progress.toFixed(1)}%).`);
                    }
                } catch (error) {
                    if (generation !== this.generation) continue;
                    if (error instanceof SimklApiError && error.kind === "transient" && item.retries < 3) {
                        item.retries++;
                        item.due = Date.now() + Math.max(20000 * item.retries, error.retryAfterMs);
                        this.retryNotBefore = item.due;
                        // A stop preserves the previous item's place ahead of the next start.
                        // Obsolete start/pause retries can be replaced by a newer observation.
                        if (item.event.action === "stop" || !this.queue.some((q) => q.serial === item.serial))
                            this.queue.unshift(item);
                        console.warn(
                            `[Simkl] API unavailable; retry in ${Math.ceil((item.due - Date.now()) / 1000)}s.`,
                        );
                    } else {
                        if (error instanceof SimklApiError && (error.kind === "auth" || error.kind === "scope")) {
                            this.blockedGrants.add(grant);
                            console.warn("[Simkl] Authorization unavailable. Run simkl-auth with write permission.");
                        } else console.warn("[Simkl] Event could not be saved; no further retries for this event.");
                    }
                }
            }
        } finally {
            this.busy = false;
        }
    }

    async flush(timeoutMs = 8000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while ((this.busy || this.queue.length) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
        }
        if (this.busy || this.queue.length)
            console.warn("[Simkl] Shutdown deadline reached; pending events could not be saved.");
    }
}

const scrobbler = new SimklScrobbler();

function currentSettings(): SimklSettings {
    const options = config.simkl;
    const session = options?.enabled && options.clientId && !config.syncDryRun ? getAuthSession() : null;
    return {
        enabled: options?.enabled ?? false,
        clientId: options?.clientId ?? "",
        sessionKey: session?.sessionKey ?? null,
        threshold: options?.syncThreshold ?? 80,
        dryRun: config.syncDryRun ?? false,
    };
}

export function updateSimklPlayback(data: MpvData): void {
    scrobbler.update(data, currentSettings());
}

export function reloadSimklPlayback(): void {
    scrobbler.configure(currentSettings());
}

export function stopSimklPlayback(): void {
    scrobbler.configure(currentSettings());
    scrobbler.stop();
}
export async function flushSimklPlayback(): Promise<void> {
    await scrobbler.flush();
}
