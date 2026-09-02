/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { ChannelStore, FluxDispatcher, GuildStore, NavigationRouter, SelectedChannelStore, SelectedGuildStore } from "@webpack/common";

import { settings } from "./settings";

const BAR_ID = "claude-sidebar-tabs";
const STYLE_ID = "claude-sidebar-tabs-style";

/** Set on <body> while the DMs tab is active. */
const DMS_CLASS = "cl-tabs-dms";

const LAST_PLACE_KEY = "ClaudeSidebarTabs_lastPlace";
/** Pre-channel-memory key, read once so an existing cache isn't thrown away. */
const LEGACY_GUILD_KEY = "ClaudeSidebarTabs_lastGuildId";

let bar: HTMLDivElement | null = null;
let style: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let pendingSync = false;
let onChannelSelect: (() => void) | null = null;

interface Place {
    guildId: string;
    /** Absent when the guild was seen without a resolvable channel. */
    channelId?: string;
}

/**
 * Where you were last looking, so Home drops you back into the exact channel
 * rather than the guild's default. Mirrored into DataStore so it survives a
 * restart — otherwise Home does nothing useful on the first click of a session.
 */
let lastPlace: Place | null = null;

/* ------------------------------------------------------------------ *
 * Mode
 *
 * Derived from Discord's navigation state rather than stored: "DMs" just means
 * "currently in /channels/@me". A separate copy would be a second source of
 * truth that drifts the moment you navigate by any other means — a keybind, a
 * notification, a link — and the highlight would start lying about where you are.
 * ------------------------------------------------------------------ */

type Mode = "home" | "dms";

function currentMode(): Mode {
    return SelectedGuildStore?.getGuildId?.() ? "home" : "dms";
}

function remember(guildId: string, channelId: string | undefined) {
    if (lastPlace?.guildId === guildId && lastPlace.channelId === channelId) return;

    lastPlace = channelId ? { guildId, channelId } : { guildId };
    // Fire and forget; a failed cache write shouldn't break navigation.
    DataStore.set(LAST_PLACE_KEY, lastPlace).catch(() => void 0);
}

function forget() {
    lastPlace = null;
    DataStore.del(LAST_PLACE_KEY).catch(() => void 0);
}

function goHome() {
    if (currentMode() === "home") return;

    const place = lastPlace;

    // A cached location can outlive what it points at — guild left, kicked or
    // deleted; channel removed or now invisible to you — so both halves are
    // checked before use. transitionTo on a dead id lands you on a broken view.
    if (place && GuildStore?.getGuild?.(place.guildId)) {
        if (place.channelId && ChannelStore?.getChannel?.(place.channelId)) {
            NavigationRouter.transitionTo(`/channels/${place.guildId}/${place.channelId}`);
        } else {
            // Guild still there, channel isn't: fall back and let Discord choose.
            NavigationRouter.transitionToGuild(place.guildId);
        }
        return;
    }

    if (place) forget();

    // Nothing to return to: reveal the rail and let the user pick.
    document.body.classList.remove(DMS_CLASS);
}

function goDms() {
    if (currentMode() === "dms") return;
    NavigationRouter.transitionTo("/channels/@me");
}

/* ------------------------------------------------------------------ *
 * Bar
 * ------------------------------------------------------------------ */

const HOUSE = "M3.2 10.4 12 3.2l8.8 7.2v9.7a1.1 1.1 0 0 1-1.1 1.1h-4.8v-6.1H9.1v6.1H4.3a1.1 1.1 0 0 1-1.1-1.1z";
const BUBBLE = "M4.5 3.6h15a1.4 1.4 0 0 1 1.4 1.4v9.6a1.4 1.4 0 0 1-1.4 1.4H9.6l-6.5 4.4V5a1.4 1.4 0 0 1 1.4-1.4z";

function icon(path: string): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");

    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", path);
    p.setAttribute("fill", "currentColor");
    svg.appendChild(p);

    return svg;
}

function tab(mode: Mode, label: string, path: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "cl-tab";
    button.type = "button";
    button.dataset.mode = mode;
    button.setAttribute("role", "tab");

    button.appendChild(icon(path));

    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(text);

    button.addEventListener("click", onClick);
    return button;
}

function buildBar(): HTMLDivElement {
    const el = document.createElement("div");
    el.id = BAR_ID;
    el.className = "cl-tabs";
    el.setAttribute("role", "tablist");

    el.appendChild(tab("home", "Home", HOUSE, goHome));
    el.appendChild(tab("dms", settings.store.sidebarDmsLabel || "DMs", BUBBLE, goDms));

    return el;
}

function paintSelection() {
    if (!bar) return;

    const mode = currentMode();
    document.body.classList.toggle(DMS_CLASS, mode === "dms" && settings.store.sidebarHideRail);

    for (const button of bar.querySelectorAll<HTMLButtonElement>(".cl-tab")) {
        button.setAttribute("aria-selected", String(button.dataset.mode === mode));
    }
}

/**
 * The channel/DM sidebar — the ~240px column, not the 72px rail. Scoped under
 * `content_` so it can't match the settings sidebar, which shares the prefix.
 */
function findSidebar(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[class*="content_"] > [class*="sidebar_"]')
        ?? document.querySelector<HTMLElement>('[class*="content_"] > nav[class*="guildSidebar"]');
}

function sync() {
    pendingSync = false;

    const sidebar = findSidebar();
    if (!sidebar) return;

    bar ??= buildBar();

    // Discord re-renders the sidebar wholesale on navigation, which detaches the
    // bar. Re-prepend whenever it's missing or left behind in a stale sidebar.
    if (bar.parentElement !== sidebar) sidebar.prepend(bar);

    paintSelection();
}

function scheduleSync() {
    if (pendingSync) return;
    pendingSync = true;
    requestAnimationFrame(sync);
}

export function restyle() {
    style?.remove();

    style = document.createElement("style");
    style.id = STYLE_ID;
    // Falls back to Discord's own tokens so this is legible without the theme.
    style.textContent = `
#${BAR_ID} {
    display: flex;
    gap: 4px;
    padding: 8px;
    flex: 0 0 auto;
    border-bottom: 1px solid var(--cl-border, var(--border-subtle, rgba(255,255,255,.08)));
}

#${BAR_ID} .cl-tab {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 8px);
    background: transparent;
    color: var(--cl-text-4, var(--text-secondary, #a3a099));
    font-family: var(--cl-sans, inherit);
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: background-color 110ms ease, color 110ms ease, border-color 110ms ease;
}

#${BAR_ID} .cl-tab svg {
    width: 15px;
    height: 15px;
    flex: 0 0 auto;
}

#${BAR_ID} .cl-tab:hover {
    background: var(--cl-mod-faint, rgba(255,255,255,.04));
    color: var(--cl-text-2, var(--text-default, #e5e4df));
}

#${BAR_ID} .cl-tab[aria-selected="true"] {
    background: var(--cl-mod-strong, rgba(255,255,255,.12));
    border-color: var(--cl-border, var(--border-subtle, rgba(255,255,255,.08)));
    color: var(--cl-text-1, var(--header-primary, #faf9f5));
}

/* DMs tab hides the server rail, so the sidebar reads as one purpose at a time
   the way Claude Desktop's does. */
body.${DMS_CLASS} nav[class*="guilds"],
body.${DMS_CLASS} [class*="guilds_"][class*="wrapper_"] {
    display: none !important;
}
`;
    document.head.appendChild(style);

    // Label may have changed; rebuild rather than patch.
    bar?.remove();
    bar = null;
    scheduleSync();
}

export async function start() {
    restyle();

    onChannelSelect = () => {
        const guildId = SelectedGuildStore?.getGuildId?.();
        // No guild means a DM, which the DMs tab already handles — only guild
        // channels are worth remembering for Home.
        if (guildId) remember(guildId, SelectedChannelStore?.getChannelId?.() ?? undefined);
        scheduleSync();
    };
    FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);

    observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    onChannelSelect();

    // Restore the cache last: if you're already in a guild, the live value is
    // the better answer and shouldn't be overwritten.
    if (!lastPlace) {
        const cached = await DataStore.get<Place>(LAST_PLACE_KEY);
        if (cached?.guildId) {
            lastPlace = cached;
        } else {
            // Upgrade a guild-only cache written before channels were saved.
            const legacy = await DataStore.get<string>(LEGACY_GUILD_KEY);
            if (legacy) {
                lastPlace = { guildId: legacy };
                DataStore.set(LAST_PLACE_KEY, lastPlace).catch(() => void 0);
            }
            DataStore.del(LEGACY_GUILD_KEY).catch(() => void 0);
        }
    }
}

export function stop() {
    observer?.disconnect();
    observer = null;

    if (onChannelSelect) {
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
        onChannelSelect = null;
    }

    bar?.remove();
    bar = null;
    style?.remove();
    style = null;

    document.body.classList.remove(DMS_CLASS);
}
