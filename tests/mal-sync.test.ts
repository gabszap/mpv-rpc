import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as sync from '../src/mal-sync/sync';
import * as api from '../src/mal-sync/api';
import * as auth from '../src/mal-sync/auth';
import { config } from '../src/config';

// Mock dependencies
vi.mock('../src/mal-sync/api', () => ({
    updateWatchedEpisodes: vi.fn(),
    getWatchStatus: vi.fn(),
}));

vi.mock('../src/mal-sync/auth', () => ({
    isAuthenticated: vi.fn(),
}));

// Mock config
vi.mock('../src/config', () => ({
    config: {
        mal: {
            enabled: true,
            syncThreshold: 90,
        }
    }
}));

describe('MAL Sync Logic', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset internal state of sync module if possible, 
        // since Map objects are module-level constants we might need to be careful
        // or just accept that tests might be slightly dependent if we don't reload.
        // For these tests, we can use different malIds to avoid conflict.
    });

    it('should sync a new episode successfully', async () => {
        const malId = 123;
        const episode = 1;

        vi.mocked(auth.isAuthenticated).mockReturnValue(true);
        vi.mocked(api.getWatchStatus).mockResolvedValue(0);
        vi.mocked(api.updateWatchedEpisodes).mockResolvedValue(true);

        const result = await sync.syncEpisode(malId, episode, 95);

        expect(result).toBe(true);
        expect(api.updateWatchedEpisodes).toHaveBeenCalledWith(malId, episode, undefined);
    });

    it('should NOT sync again if episode hasn\'t changed (prevention of spam)', async () => {
        const malId = 456;
        const episode = 2;

        vi.mocked(auth.isAuthenticated).mockReturnValue(true);
        vi.mocked(api.getWatchStatus).mockResolvedValue(0);
        vi.mocked(api.updateWatchedEpisodes).mockResolvedValue(true);

        // First sync
        await sync.syncEpisode(malId, episode, 95);
        expect(api.updateWatchedEpisodes).toHaveBeenCalledTimes(1);

        // Second sync attempt (same episode)
        const result = await sync.syncEpisode(malId, episode, 95);

        expect(result).toBe(false); // Refused by shouldSync
        expect(api.updateWatchedEpisodes).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should sync immediately if episode increases', async () => {
        const malId = 789;

        vi.mocked(auth.isAuthenticated).mockReturnValue(true);
        vi.mocked(api.getWatchStatus).mockResolvedValue(0);
        vi.mocked(api.updateWatchedEpisodes).mockResolvedValue(true);

        // Sync EP 1
        await sync.syncEpisode(malId, 1, 95);

        // Sync EP 2
        const result = await sync.syncEpisode(malId, 2, 95);

        expect(result).toBe(true);
        expect(api.updateWatchedEpisodes).toHaveBeenCalledTimes(2);
    });

    it('should NOT sync if percentage is below threshold', async () => {
        const result = await sync.syncEpisode(999, 1, 50);
        expect(result).toBe(false);
        expect(api.updateWatchedEpisodes).not.toHaveBeenCalled();
    });

    it('should handle API errors gracefully without entering loops', async () => {
        const malId = 111;
        const episode = 1;

        vi.mocked(auth.isAuthenticated).mockReturnValue(true);
        vi.mocked(api.getWatchStatus).mockResolvedValue(0);
        // Simulate failure
        vi.mocked(api.updateWatchedEpisodes).mockResolvedValue(false);

        // First attempt fails
        const result1 = await sync.syncEpisode(malId, episode, 95);
        expect(result1).toBe(false);

        // Second attempt shortly after should be blocked by cooldown even if previous failed
        // This prevents spamming error logs too
        const result2 = await sync.syncEpisode(malId, episode, 95);
        expect(result2).toBe(false);
        expect(api.updateWatchedEpisodes).toHaveBeenCalledTimes(1);
    });

    it('should avoid syncing if MAL already has the same or higher progress', async () => {
        const malId = 222;
        const episode = 5;

        vi.mocked(auth.isAuthenticated).mockReturnValue(true);
        // MAL already at 5
        vi.mocked(api.getWatchStatus).mockResolvedValue(5);

        const result = await sync.syncEpisode(malId, episode, 95);

        expect(result).toBe(true); // Technically success as we are already there
        expect(api.updateWatchedEpisodes).not.toHaveBeenCalled();
    });

    it('should return already_synced in detailed mode when MAL progress is up to date', async () => {
        const malId = 333;
        const episode = 2;

        vi.mocked(auth.isAuthenticated).mockReturnValue(true);
        vi.mocked(api.getWatchStatus).mockResolvedValue(2);

        const result = await sync.syncEpisodeDetailed(malId, episode, 95);

        expect(result).toBe('already_synced');
        expect(api.updateWatchedEpisodes).not.toHaveBeenCalled();
    });
});
