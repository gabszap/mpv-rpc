import { describe, expect, it, vi } from "vitest";

const { setActivityMock } = vi.hoisted(() => ({ setActivityMock: vi.fn() }));

vi.mock("@xhayper/discord-rpc", () => {
    class Client {
        user = { username: "tester", setActivity: setActivityMock, clearActivity: vi.fn() };
        private handlers: Record<string, () => void> = {};
        on(event: string, cb: () => void): void {
            this.handlers[event] = cb;
        }
        async login(): Promise<void> {
            this.handlers.ready?.();
        }
        async destroy(): Promise<void> {}
    }
    return { Client };
});

import { config } from "../src/core/config";
import { buildActivityContent, connect, setActivity } from "../src/integrations/discord";
import type { MpvData } from "../src/integrations/mpv";

const MPV_ICON = "https://i.imgur.com/gGwczqt.png";

const base: MpvData = {
    media_title: "Frieren - S01E05",
    series_title: "Frieren",
    season: 1,
    episode: 5,
    episode_title: "Ep Title",
    filename: "f.mkv",
    pause: false,
    percent_pos: 42,
    time_pos: 10,
    duration: 100,
    artist: "N/A",
    cover_image: "cover-url",
    mal_id: null,
    total_episodes: null,
    adjusted_episode: null,
    playlistPos: 0,
    playlistCount: 0,
};

type Scenario = { data: Partial<MpvData>; presence: boolean; cover: boolean };

// Payloads recorded from setActivity before the content builder was extracted.
const cases: Record<string, Scenario> = {
    "series with episode title, presence on, cover": { data: {}, presence: true, cover: true },
    "series without episode title, presence on": { data: { episode_title: null }, presence: true, cover: true },
    "series presence off, cover": { data: {}, presence: false, cover: true },
    "series presence off, no episode title": { data: { episode_title: null }, presence: false, cover: true },
    "episode only, presence on": { data: { season: null }, presence: true, cover: true },
    "episode only, presence off, with title": { data: { season: null }, presence: false, cover: true },
    "episode only, presence off, no title": {
        data: { season: null, episode_title: null },
        presence: false,
        cover: true,
    },
    "no episode, only episode title, presence on": {
        data: { season: null, episode: null },
        presence: true,
        cover: true,
    },
    "no episode, only episode title, presence off": {
        data: { season: null, episode: null },
        presence: false,
        cover: true,
    },
    "no episode, no title, presence on": {
        data: { season: null, episode: null, episode_title: null },
        presence: true,
        cover: true,
    },
    "no episode, no title, playing": {
        data: { season: null, episode: null, episode_title: null },
        presence: false,
        cover: true,
    },
    "no episode, no title, paused": {
        data: { season: null, episode: null, episode_title: null, pause: true },
        presence: false,
        cover: true,
    },
    "no episode, no title, artist": {
        data: { season: null, episode: null, episode_title: null, artist: "Some Band" },
        presence: false,
        cover: true,
    },
    "without cover image": { data: { cover_image: null }, presence: false, cover: true },
    "showCover off": { data: {}, presence: false, cover: false },
    "overflow adjusted episode": { data: { episode: 30, adjusted_episode: 2 }, presence: false, cover: true },
    "overflow adjusted episode, presence on, no title": {
        data: { episode: 30, adjusted_episode: 2, episode_title: null },
        presence: true,
        cover: true,
    },
    "season suffix in title": { data: { series_title: "Frieren - Season 2" }, presence: true, cover: true },
};

const golden: Record<string, unknown> = {
    "series with episode title, presence on, cover": {
        name: "Frieren",
        details: "Ep Title",
        state: "on MPV",
        largeImageKey: "cover-url",
        largeImageText: "Season 1, Episode 5",
    },
    "series without episode title, presence on": {
        name: "Frieren",
        details: "Episode 5",
        state: "on MPV",
        largeImageKey: "cover-url",
        largeImageText: "Season 1, Episode 5",
    },
    "series presence off, cover": {
        details: "Frieren",
        state: "Ep Title",
        largeImageKey: "cover-url",
        largeImageText: "Season 1, Episode 5",
    },
    "series presence off, no episode title": {
        details: "Frieren",
        largeImageKey: "cover-url",
        largeImageText: "Season 1, Episode 5",
    },
    "episode only, presence on": {
        name: "Frieren",
        details: "Episode 5 - Ep Title",
        state: "on MPV",
        largeImageKey: "cover-url",
        largeImageText: "MPV Media Player",
    },
    "episode only, presence off, with title": {
        details: "Frieren",
        state: "Episode 5 - Ep Title",
        largeImageKey: "cover-url",
        largeImageText: "MPV Media Player",
    },
    "episode only, presence off, no title": {
        details: "Frieren",
        state: "Episode 5",
        largeImageKey: "cover-url",
        largeImageText: "MPV Media Player",
    },
    "no episode, only episode title, presence on": {
        name: "Frieren",
        details: "Ep Title",
        state: "on MPV",
        largeImageKey: "cover-url",
        largeImageText: "MPV Media Player",
    },
    "no episode, only episode title, presence off": {
        details: "Frieren",
        state: "Ep Title",
        largeImageKey: "cover-url",
        largeImageText: "MPV Media Player",
    },
    "no episode, no title, presence on": {
        name: "Frieren",
        details: "on MPV",
        largeImageKey: "cover-url",
        largeImageText: "MPV Media Player",
    },
    "no episode, no title, playing": {
        details: "Frieren",
        state: "Playing - 42.0%",
        largeImageKey: "cover-url",
        largeImageText: "MPV Media Player",
    },
    "no episode, no title, paused": {
        details: "Frieren",
        state: "Paused",
        largeImageKey: "cover-url",
        largeImageText: "MPV Media Player",
    },
    "no episode, no title, artist": {
        details: "Frieren",
        state: "by Some Band",
        largeImageKey: "cover-url",
        largeImageText: "MPV Media Player",
    },
    "without cover image": {
        details: "Frieren",
        state: "Ep Title",
        largeImageKey: "https://i.imgur.com/gGwczqt.png",
        largeImageText: "MPV Media Player",
    },
    "showCover off": {
        details: "Frieren",
        state: "Ep Title",
        largeImageKey: "https://i.imgur.com/gGwczqt.png",
        largeImageText: "MPV Media Player",
    },
    "overflow adjusted episode": {
        details: "Frieren",
        state: "Ep Title",
        largeImageKey: "cover-url",
        largeImageText: "Season 1, Episode 2",
    },
    "overflow adjusted episode, presence on, no title": {
        name: "Frieren",
        details: "Episode 2",
        state: "on MPV",
        largeImageKey: "cover-url",
        largeImageText: "Season 1, Episode 2",
    },
    "season suffix in title": {
        name: "Frieren",
        details: "Ep Title",
        state: "on MPV",
        largeImageKey: "cover-url",
        largeImageText: "Season 1, Episode 5",
    },
};

describe("buildActivityContent keeps the anime and series status unchanged", () => {
    it.each(Object.keys(cases))("%s", (name) => {
        const scenario = cases[name];

        const content = buildActivityContent(
            { ...base, ...scenario.data },
            { showTitleAsPresence: scenario.presence, showCover: scenario.cover, mpvIcon: MPV_ICON },
        );

        expect(content).toEqual(golden[name]);
    });
});

describe("setActivity", () => {
    it("sends the built content with timestamps and play icons", async () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        await connect();
        Object.assign(config.settings, {
            showTitleAsPresence: true,
            showCover: true,
            privacyMode: false,
            hideIdling: false,
        });
        setActivityMock.mockClear();

        await setActivity(base);

        const payload = setActivityMock.mock.calls[0][0];
        expect(payload).toMatchObject(golden["series with episode title, presence on, cover"] as object);
        expect(payload.smallImageText).toBe("Watching");
        expect(typeof payload.startTimestamp).toBe("number");
        expect(typeof payload.endTimestamp).toBe("number");
    });
});

describe("buildActivityContent for a movie", () => {
    const movie: MpvData = {
        ...base,
        media_title: "Inception",
        series_title: "Inception",
        season: null,
        episode: null,
        episode_title: null,
        cover_image: "poster-url",
        media_kind: "movie",
        year: 2010,
    };

    function build(data: Partial<MpvData>, presence: boolean, cover = true): ReturnType<typeof buildActivityContent> {
        return buildActivityContent(
            { ...movie, ...data },
            { showTitleAsPresence: presence, showCover: cover, mpvIcon: MPV_ICON },
        );
    }

    it('showTitleAsPresence on shows "Movie (2010)" and "on MPV"', () => {
        expect(build({}, true)).toMatchObject({ name: "Inception", details: "Movie (2010)", state: "on MPV" });
    });

    it('showTitleAsPresence on without a year shows "Movie"', () => {
        expect(build({ year: undefined }, true)).toMatchObject({ details: "Movie", state: "on MPV" });
    });

    it("showTitleAsPresence off shows the title and the year as state", () => {
        expect(build({}, false)).toMatchObject({ name: undefined, details: "Inception", state: "2010" });
    });

    it("showTitleAsPresence off without a year falls back to Paused / Playing", () => {
        expect(build({ year: undefined, pause: true }, false).state).toBe("Paused");
        expect(build({ year: undefined, pause: false }, false).state).toBe("Playing - 42.0%");
    });

    it('uses the poster with the text "Title (2010)" when showCover is on', () => {
        expect(build({}, false)).toMatchObject({ largeImageKey: "poster-url", largeImageText: "Inception (2010)" });
    });

    it("uses the plain title as image text when there is no year", () => {
        expect(build({ year: undefined }, false).largeImageText).toBe("Inception");
    });

    it("falls back to the MPV icon when the movie has no poster", () => {
        expect(build({ cover_image: null }, false)).toMatchObject({
            largeImageKey: MPV_ICON,
            largeImageText: "MPV Media Player",
        });
    });

    it("uses the MPV icon when showCover is off", () => {
        expect(build({}, false, false)).toMatchObject({ largeImageKey: MPV_ICON, largeImageText: "MPV Media Player" });
    });

    it("a series result is unchanged", () => {
        const series: MpvData = { ...base, media_kind: "series", year: 2008 };
        const options = { showTitleAsPresence: true, showCover: true, mpvIcon: MPV_ICON };

        expect(buildActivityContent(series, options)).toEqual(buildActivityContent(base, options));
    });
});
