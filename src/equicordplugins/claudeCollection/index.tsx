/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

import * as composerTools from "./composerTools";
import * as effort from "./effort";
import * as greeting from "./greeting";
import * as homeIcon from "./homeIcon";
import { hooks, settings } from "./settings";
import * as sidebarTabs from "./sidebarTabs";

interface Feature {
    name: string;
    /** Whether this feature's own toggle is on. */
    enabled: () => boolean;
    start: () => void | Promise<void>;
    stop: () => void;
    /** Re-applies styles/labels when a sub-setting changes, without a restart. */
    restyle?: () => void;
    /**
     * Only meaningful at client startup. Toggling such a feature on mid-session
     * shouldn't retroactively fire it.
     */
    startupOnly?: boolean;
}

const FEATURES: Feature[] = [
    {
        name: "greeting",
        enabled: () => settings.store.enableGreeting,
        start: greeting.start,
        stop: greeting.stop,
        startupOnly: true,
    },
    {
        name: "homeIcon",
        enabled: () => settings.store.enableHomeIcon,
        start: homeIcon.start,
        stop: homeIcon.stop,
        restyle: homeIcon.restyle,
    },
    {
        name: "sidebarTabs",
        enabled: () => settings.store.enableSidebarTabs,
        start: sidebarTabs.start,
        stop: sidebarTabs.stop,
        restyle: sidebarTabs.restyle,
    },
    {
        name: "composerTools",
        enabled: () => settings.store.enableComposerTools,
        start: composerTools.start,
        stop: composerTools.stop,
        restyle: composerTools.restyle,
    },
    {
        name: "effort",
        enabled: () => settings.store.enableEffortDelay,
        start: effort.start,
        stop: effort.stop,
    },
];

const running = new Set<string>();
let pluginActive = false;

/**
 * Brings every feature in line with its toggle. Called on plugin start and again
 * whenever a setting changes, so flipping a toggle takes effect immediately
 * rather than at the next restart.
 */
function apply(initial = false) {
    if (!pluginActive) return;

    for (const feature of FEATURES) {
        const want = feature.enabled();
        const is = running.has(feature.name);

        if (want && !is) {
            // A startup-only feature that's switched on later waits for the next
            // launch instead of firing in the middle of a session.
            if (feature.startupOnly && !initial) continue;

            running.add(feature.name);
            // start may be async (DataStore reads); nothing downstream awaits it.
            void feature.start();
        } else if (!want && is) {
            running.delete(feature.name);
            feature.stop();
        } else if (want && is) {
            feature.restyle?.();
        }
    }
}

export default definePlugin({
    name: "Claude Collection",
    description: "Makes Discord behave like Claude Desktop: a startup greeting, the Claude mark on the home button, Claude's Home / DMs sidebar tabs, and the composer's buttons collapsed into one Claude-style menu. Each part can be toggled below. Pairs with the Claude theme.",
    authors: [{ name: "xocat", id: 1525464078783615083n }],
    settings,

    start() {
        pluginActive = true;
        hooks.refresh = () => apply();
        apply(true);
    },

    stop() {
        pluginActive = false;
        hooks.refresh = undefined;

        for (const feature of FEATURES) {
            if (!running.delete(feature.name)) continue;
            feature.stop();
        }
    },
});
