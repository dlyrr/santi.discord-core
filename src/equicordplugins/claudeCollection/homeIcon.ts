/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LOGO_MASK } from "./logo";
import { settings } from "./settings";

const STYLE_ID = "claude-home-icon-style";
/** Tagged onto whichever element turns out to hold the rail's home glyph. */
const HOME_CLASS = "cl-claude-home";

let style: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let pendingSync = false;
let warned = false;

/*
 * Why this is code and not a few lines of theme CSS: the Friends button in the
 * DM sidebar has the same href as the rail's home button, so any selector broad
 * enough to survive Discord's class churn also hits the wrong element. CSS can
 * only state one guess at a time; here the candidates are tried in order and the
 * search is confined to the rail before it starts.
 */

function findRail(): HTMLElement | null {
    return document.querySelector<HTMLElement>('nav[class*="guilds"]')
        ?? document.querySelector<HTMLElement>('[class*="guildsWrapper_"]')
        ?? document.querySelector<HTMLElement>('[class*="guilds_"]');
}

/** The clickable home button within the rail, by descending order of confidence. */
function findHomeButton(rail: HTMLElement): HTMLElement | null {
    return rail.querySelector<HTMLElement>('[data-list-item-id="guildsnav___home"]')
        ?? rail.querySelector<HTMLElement>('[data-list-item-id*="home"]')
        ?? rail.querySelector<HTMLElement>('a[href="/channels/@me"]')
        ?? rail.querySelector<HTMLElement>('a[href^="/channels/@me"]');
}

/**
 * What actually gets the mark. Tagging the svg's *parent* rather than the button
 * matters: across builds the anchor is sometimes a bare inline box while the
 * element wrapping the glyph carries the 48x48 icon size, and `inset: 0` on the
 * wrong one paints the mark into a sliver.
 */
function findMarkTarget(): HTMLElement | null {
    const rail = findRail();
    if (!rail) return null;

    const button = findHomeButton(rail);
    if (!button) return null;

    const svg = button.querySelector("svg");
    return (svg?.parentElement as HTMLElement | null) ?? button;
}

function sync() {
    pendingSync = false;

    const wanted = findMarkTarget();

    if (!wanted && !warned && findRail()) {
        warned = true;
        console.warn("[ClaudeCollection] found the server rail but no home button inside it — the selectors need updating for this Discord build.");
    }

    // Discord re-renders the rail on navigation, so the tag is re-applied every
    // pass and cleared off anything stale.
    for (const tagged of document.querySelectorAll<HTMLElement>(`.${HOME_CLASS}`)) {
        if (tagged !== wanted) tagged.classList.remove(HOME_CLASS);
    }

    wanted?.classList.add(HOME_CLASS);
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
    // --cl-accent comes from the Claude theme; the literal is the same value, so
    // this still looks right on stock Discord.
    style.textContent = `
.${HOME_CLASS} {
    position: relative;
}

/* Hidden with visibility rather than display: on some builds that svg is what
   gives the button its box. */
.${HOME_CLASS} svg {
    visibility: hidden;
}

/* A mask rather than a coloured background image, so one copy of the shape
   tracks the accent in both light and dark. */
.${HOME_CLASS}::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    background-color: var(--cl-accent, #d97757);
    -webkit-mask: ${LOGO_MASK} center / ${settings.store.homeIconSize}% no-repeat;
    mask: ${LOGO_MASK} center / ${settings.store.homeIconSize}% no-repeat;
}
`;
    document.head.appendChild(style);
}

export function start() {
    restyle();

    observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    scheduleSync();
}

export function stop() {
    observer?.disconnect();
    observer = null;

    style?.remove();
    style = null;

    for (const tagged of document.querySelectorAll<HTMLElement>(`.${HOME_CLASS}`)) {
        tagged.classList.remove(HOME_CLASS);
    }
}
