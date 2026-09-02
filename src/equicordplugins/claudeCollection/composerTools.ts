/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { currentLevel, currentName, EFFORT_LEVELS, isUltra, setLevel } from "./effort";
import { settings } from "./settings";

const STYLE_ID = "claude-composer-tools-style";
const PILL_ID = "claude-composer-tools-pill";
const MENU_ID = "claude-composer-tools-menu";
const EFFORT_ID = "claude-effort-popover";
/** Put on the original buttons we've taken over. */
const HIDDEN_CLASS = "cl-tool-hidden";

let style: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let pendingSync = false;
let menuOpen = false;
let moreOpen = false;
let warned = false;

/*
 * The originals are never removed or unmounted — each row forwards a click to
 * the real button. Driving Discord's own controls means the pickers, the file
 * dialog and the slash-command list all keep working without this plugin
 * knowing anything about how they're opened.
 *
 * They're hidden with opacity + pointer-events rather than `display: none`
 * because Discord anchors each popout to its button's bounding rect. A
 * display-hidden button has a zero rect, and the picker would open in the corner
 * of the window instead of above the composer.
 */

interface Tool {
    key: string;
    /** Matched against aria-label / title, in the order listed below. */
    match: RegExp;
    /** Structural fallback for buttons whose label doesn't match — see attach. */
    selector?: string;
    label: string;
    detail?: string;
    /** Rows in the "More" section rather than at the top level. */
    more?: boolean;
}

const TOOLS: Tool[] = [
    {
        key: "attach",
        match: /upload|attach/i,
        // The + button's label varies by build and is sometimes absent entirely,
        // which is why it went missing from the menu; the class is steadier.
        selector: '[class*="attachButton"], [class*="attachWrapper"] button, [class*="attachWrapper"] div[role="button"]',
        label: "Upload a File",
        detail: "Images, videos and documents",
    },
    { key: "gif", match: /\bgif\b/i, label: "GIFs", detail: "Search Tenor" },
    { key: "sticker", match: /sticker/i, label: "Stickers", more: true },
    { key: "emoji", match: /emoji/i, label: "Emoji", more: true },
    { key: "apps", match: /\bapps?\b|command/i, label: "Apps & Commands", more: true },
    { key: "gift", match: /gift|nitro/i, label: "Send a Gift", more: true },
];

function findComposer(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[class*="channelTextArea_"]');
}

function isOurs(el: Element): boolean {
    return Boolean(el.closest(`#${PILL_ID}, #${MENU_ID}, #${EFFORT_ID}`));
}

/**
 * Maps each tool to its real button. Anything that doesn't match is deliberately
 * left alone — the composer also holds the send button and whatever other
 * plugins have added there, and hiding those would be destructive.
 */
function findTools(composer: HTMLElement): Map<string, HTMLElement> {
    const found = new Map<string, HTMLElement>();
    const claimed = new Set<HTMLElement>();

    const candidates = Array.from(
        composer.querySelectorAll<HTMLElement>('button, div[role="button"]')
    ).filter(el => !isOurs(el));

    for (const tool of TOOLS) {
        let hit: HTMLElement | null = null;

        for (const el of candidates) {
            if (claimed.has(el)) continue;

            const label = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`;
            if (!tool.match.test(label)) continue;

            hit = el;
            break;
        }

        // Fall back to structure when the label didn't identify it.
        if (!hit && tool.selector) {
            const bySelector = composer.querySelector<HTMLElement>(tool.selector);
            if (bySelector && !claimed.has(bySelector) && !isOurs(bySelector)) hit = bySelector;
        }

        if (!hit) continue;

        found.set(tool.key, hit);
        claimed.add(hit);
    }

    return found;
}

function activate(el: HTMLElement) {
    closeAll();
    // Real click on the real control; Discord's own handler does the rest.
    el.click();
}

/* ------------------------------------------------------------------ *
 * Icons
 * ------------------------------------------------------------------ */

const CHEVRON = "M8.6 4.6 15 11l-6.4 6.4-1.4-1.4L12.2 11 7.2 6 8.6 4.6z";
const CARET = "M4.5 7.5 10 13l5.5-5.5z";

function svgIcon(path: string, cls: string): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", cls);
    svg.setAttribute("aria-hidden", "true");

    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", path);
    p.setAttribute("fill", "currentColor");
    svg.appendChild(p);

    return svg;
}

/* ------------------------------------------------------------------ *
 * Effort popover
 *
 * Its own floating panel rather than a section inside the tools menu, so the
 * slider gets the full width of the popover and dragging it can't be mistaken
 * for picking a menu row.
 * ------------------------------------------------------------------ */

function buildEffortPanel(onPick: () => void): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "cl-effort";

    const head = document.createElement("div");
    head.className = "cl-effort-head";

    const title = document.createElement("span");
    title.className = "cl-effort-title";
    title.textContent = "Effort";
    head.appendChild(title);

    const value = document.createElement("span");
    value.className = "cl-effort-value";
    value.textContent = currentName();
    head.appendChild(value);

    const help = document.createElement("span");
    help.className = "cl-effort-help";
    help.textContent = "?";
    help.title = "Higher effort holds your message in a Thinking… state longer before it posts. Cosmetic only — the message itself is unchanged. You can keep sending while one is held; they queue and post in order.";
    head.appendChild(help);

    panel.appendChild(head);

    const axis = document.createElement("div");
    axis.className = "cl-effort-axis";
    for (const label of ["Faster", "Smarter"]) {
        const span = document.createElement("span");
        span.textContent = label;
        axis.appendChild(span);
    }
    panel.appendChild(axis);

    // A real <input type="range">, so dragging, clicking the rail and arrow keys
    // all behave the way a slider should.
    const slider = document.createElement("div");
    slider.className = "cl-effort-slider";

    // Notch markers, painted on the rail beneath the input. The input's own track
    // is transparent so these show through; only its thumb is drawn.
    const marks = document.createElement("div");
    marks.className = "cl-effort-marks";
    marks.setAttribute("aria-hidden", "true");
    for (const level of EFFORT_LEVELS) {
        const mark = document.createElement("span");
        mark.className = "cl-effort-mark";
        if (level.ultra) mark.classList.add("cl-effort-mark-ultra");
        marks.appendChild(mark);
    }
    slider.appendChild(marks);

    const input = document.createElement("input");
    input.className = "cl-effort-range";
    input.type = "range";
    input.min = "0";
    input.max = String(EFFORT_LEVELS.length - 1);
    // Continuous while dragging so the thumb tracks the cursor rather than
    // jumping between notches; it's snapped to a whole level on release.
    input.step = "any";
    input.value = String(currentLevel());
    input.setAttribute("aria-label", "Effort");

    /** Nearest whole level to wherever the thumb currently sits. */
    const nearest = () => Math.min(
        EFFORT_LEVELS.length - 1,
        Math.max(0, Math.round(Number(input.value)))
    );

    // Reads the thumb's live position, which mid-drag is between levels.
    const paint = () => {
        const level = EFFORT_LEVELS[nearest()];
        value.textContent = level.name;
        // Screen readers would otherwise announce the bare index.
        input.setAttribute("aria-valuetext", level.name);
        input.title = `${level.name} — holds for ${(level.delay / 1000).toFixed(1)}s`;
        panel.classList.toggle("cl-ultra", Boolean(level.ultra));
    };

    let raf: number | null = null;

    /** Eases the thumb onto a whole level, then commits it. */
    const snapTo = (target: number) => {
        if (raf !== null) cancelAnimationFrame(raf);

        const from = Number(input.value);

        const commit = () => {
            raf = null;
            input.value = String(target);
            setLevel(target);
            paint();
            onPick();
        };

        if (from === target) {
            commit();
            return;
        }

        const DURATION = 260;
        const startedAt = performance.now();
        // Slight overshoot, so the snap reads as physical rather than linear.
        const ease = (t: number) => {
            const c = 1.2;
            const d = c + 1;
            return 1 + d * (t - 1) ** 3 + c * (t - 1) ** 2;
        };

        const frame = (now: number) => {
            // The panel is rebuilt each time it opens; if this one was torn down
            // mid-tween, stop rather than animating a detached node.
            if (!input.isConnected) {
                raf = null;
                return;
            }

            const t = Math.min(1, (now - startedAt) / DURATION);
            input.value = String(from + (target - from) * ease(t));
            paint();

            if (t < 1) raf = requestAnimationFrame(frame);
            else commit();
        };

        raf = requestAnimationFrame(frame);
    };

    // Dragging: follow the cursor and update the label, but commit nothing yet.
    input.addEventListener("input", paint);
    // Release, and plain clicks on the rail: settle onto the nearest level.
    input.addEventListener("change", () => snapTo(nearest()));

    // step="any" would make the arrow keys crawl, so whole levels are moved here.
    input.addEventListener("keydown", e => {
        const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1
            : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1
                : 0;

        if (delta !== 0) {
            e.preventDefault();
            snapTo(Math.min(EFFORT_LEVELS.length - 1, Math.max(0, nearest() + delta)));
        } else if (e.key === "Home") {
            e.preventDefault();
            snapTo(0);
        } else if (e.key === "End") {
            e.preventDefault();
            snapTo(EFFORT_LEVELS.length - 1);
        }
    });

    slider.appendChild(input);
    panel.appendChild(slider);

    paint();

    return panel;
}

function openEffort() {
    const composer = findComposer();
    if (!composer) return;

    closeAll();

    const pop = document.createElement("div");
    pop.id = EFFORT_ID;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Effort");
    pop.appendChild(buildEffortPanel(updatePill));

    // A drag that leaves the panel shouldn't be read as a click outside it.
    pop.addEventListener("pointerdown", e => e.stopPropagation());
    pop.addEventListener("click", e => e.stopPropagation());

    composer.appendChild(pop);
    listenForDismiss();

    pop.querySelector<HTMLInputElement>(".cl-effort-range")?.focus();
}

/* ------------------------------------------------------------------ *
 * Tools menu
 * ------------------------------------------------------------------ */

function row(tool: Tool, target: HTMLElement, opts: { chevron?: boolean; } = {}): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "cl-tools-row";
    button.type = "button";

    const text = document.createElement("span");
    text.className = "cl-tools-text";

    const label = document.createElement("span");
    label.className = "cl-tools-label";
    label.textContent = tool.label;
    text.appendChild(label);

    if (tool.detail) {
        const detail = document.createElement("span");
        detail.className = "cl-tools-detail";
        detail.textContent = tool.detail;
        text.appendChild(detail);
    }

    button.appendChild(text);
    if (opts.chevron) button.appendChild(svgIcon(CHEVRON, "cl-tools-chevron"));

    button.addEventListener("click", e => {
        e.stopPropagation();
        activate(target);
    });

    return button;
}

function buildMenu(tools: Map<string, HTMLElement>): HTMLDivElement {
    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.setAttribute("role", "menu");

    const top = TOOLS.filter(t => !t.more && tools.has(t.key));
    const more = TOOLS.filter(t => t.more && tools.has(t.key));

    for (const tool of top) {
        menu.appendChild(row(tool, tools.get(tool.key)!, { chevron: tool.key !== "attach" }));
    }

    // Effort sits between the top-level actions and More, as on Claude's picker,
    // but opens its own panel rather than expanding in place.
    const effortRow = document.createElement("button");
    effortRow.className = "cl-tools-row";
    effortRow.type = "button";

    const effortText = document.createElement("span");
    effortText.className = "cl-tools-text";
    const effortLabel = document.createElement("span");
    effortLabel.className = "cl-tools-label";
    effortLabel.textContent = "Effort";
    effortText.appendChild(effortLabel);
    effortRow.appendChild(effortText);

    const effortValue = document.createElement("span");
    effortValue.className = "cl-tools-hint";
    effortValue.textContent = currentName();
    effortRow.appendChild(effortValue);
    effortRow.appendChild(svgIcon(CHEVRON, "cl-tools-chevron"));

    effortRow.addEventListener("click", e => {
        e.stopPropagation();
        openEffort();
    });

    menu.appendChild(effortRow);

    if (!more.length) return menu;

    const toggle = document.createElement("button");
    toggle.className = "cl-tools-row cl-tools-more";
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(moreOpen));

    const toggleText = document.createElement("span");
    toggleText.className = "cl-tools-text";
    const toggleLabel = document.createElement("span");
    toggleLabel.className = "cl-tools-label";
    toggleLabel.textContent = "More";
    toggleText.appendChild(toggleLabel);
    toggle.appendChild(toggleText);
    toggle.appendChild(svgIcon(CHEVRON, "cl-tools-chevron"));

    const submenu = document.createElement("div");
    submenu.className = "cl-tools-submenu";
    submenu.hidden = !moreOpen;

    for (const tool of more) submenu.appendChild(row(tool, tools.get(tool.key)!));

    toggle.addEventListener("click", e => {
        e.stopPropagation();
        moreOpen = !moreOpen;
        submenu.hidden = !moreOpen;
        toggle.setAttribute("aria-expanded", String(moreOpen));
    });

    menu.appendChild(toggle);
    menu.appendChild(submenu);

    return menu;
}

function openMenu(pill: HTMLElement) {
    const composer = findComposer();
    if (!composer) return;

    const tools = findTools(composer);
    if (!tools.size) return;

    closeAll();

    menuOpen = true;
    pill.setAttribute("aria-expanded", "true");
    composer.appendChild(buildMenu(tools));
    listenForDismiss();
}

/* ------------------------------------------------------------------ *
 * Dismissal, shared by both popovers
 * ------------------------------------------------------------------ */

function onDocumentPointerDown(e: Event) {
    const t = e.target as HTMLElement | null;
    if (t?.closest(`#${MENU_ID}, #${PILL_ID}, #${EFFORT_ID}`)) return;
    closeAll();
}

function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") closeAll();
}

function listenForDismiss() {
    // pointerdown rather than click, so a drag started outside dismisses at once.
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
}

function closeAll() {
    menuOpen = false;
    moreOpen = false;
    document.getElementById(MENU_ID)?.remove();
    document.getElementById(EFFORT_ID)?.remove();
    document.getElementById(PILL_ID)?.setAttribute("aria-expanded", "false");

    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
}

/* ------------------------------------------------------------------ *
 * Pill
 * ------------------------------------------------------------------ */

function buildPill(): HTMLButtonElement {
    const pill = document.createElement("button");
    pill.id = PILL_ID;
    pill.type = "button";
    pill.setAttribute("aria-haspopup", "menu");
    pill.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "cl-tools-pill-label";
    label.textContent = settings.store.composerPillLabel || "Opus 5";
    pill.appendChild(label);

    // Effort chip to the right of the model name, as on Claude's picker. Clicking
    // it goes straight to the effort panel rather than via the tools menu.
    const effort = document.createElement("span");
    effort.className = "cl-tools-pill-effort";
    effort.setAttribute("role", "button");
    effort.title = "Effort";
    effort.textContent = currentName();
    effort.addEventListener("click", e => {
        e.stopPropagation();
        if (document.getElementById(EFFORT_ID)) closeAll();
        else openEffort();
    });
    pill.appendChild(effort);

    pill.appendChild(svgIcon(CARET, "cl-tools-caret"));

    pill.addEventListener("click", e => {
        e.stopPropagation();
        if (menuOpen) closeAll();
        else openMenu(pill);
    });

    return pill;
}

/** Keeps the pill's effort chip in step after a change from the slider. */
function updatePill() {
    const effort = document.querySelector<HTMLElement>(`#${PILL_ID} .cl-tools-pill-effort`);
    if (!effort) return;

    effort.textContent = currentName();
    effort.classList.toggle("cl-ultra", isUltra());
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

function sync() {
    pendingSync = false;

    const composer = findComposer();
    if (!composer) return;

    const tools = findTools(composer);

    if (!tools.size) {
        if (!warned) {
            warned = true;
            console.warn("[ClaudeCollection] found the composer but matched none of its buttons — aria-labels differ on this build or Discord language.");
        }
        return;
    }

    for (const el of tools.values()) el.classList.add(HIDDEN_CLASS);

    // Right-hand button row by preference, so the pill sits at the end of the
    // composer rather than where the attach button was on the left. Falling back
    // to a right-side button's own row keeps the popouts anchored sensibly.
    const host = composer.querySelector<HTMLElement>('[class*="buttons_"]')
        ?? (tools.get("emoji") ?? tools.get("gif") ?? tools.get("apps") ?? tools.values().next().value as HTMLElement).parentElement
        ?? composer;

    let pill = document.getElementById(PILL_ID);

    if (!pill) {
        pill = buildPill();
        host.appendChild(pill);
    } else if (pill.parentElement !== host) {
        host.appendChild(pill);
    }

    updatePill();
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
    style.textContent = `
/* Kept in the layout with a real bounding rect so Discord's popouts still
   anchor correctly — see the note at the top of this module. */
.${HIDDEN_CLASS} {
    position: absolute !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

#${PILL_ID} {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
    height: 30px;
    /* Sized by its label rather than a fixed width, and never wrapped or
       clipped, so a longer name still fits on one line. */
    width: auto;
    min-width: max-content;
    max-width: none;
    padding: 0 8px 0 10px;
    margin: 0 4px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 8px);
    background: transparent;
    color: var(--cl-text-3, var(--text-default, #c2c0b6));
    font-family: var(--cl-sans, inherit);
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    overflow: visible;
    cursor: pointer;
    transition: background-color 110ms ease, color 110ms ease;
}

#${PILL_ID}:hover,
#${PILL_ID}[aria-expanded="true"] {
    background: var(--cl-mod-faint, rgba(255,255,255,.05));
    color: var(--cl-text-1, var(--header-primary, #faf9f5));
}

#${PILL_ID} .cl-tools-pill-label {
    white-space: nowrap;
}

#${PILL_ID} .cl-tools-pill-effort {
    padding: 3px 6px;
    border-radius: var(--radius-xs, 4px);
    background: var(--cl-mod-subtle, rgba(255,255,255,.07));
    color: var(--cl-text-2, var(--text-default, #e5e4df));
    font-size: 12px;
    white-space: nowrap;
    transition: background-color 140ms ease, color 140ms ease;
}

#${PILL_ID} .cl-tools-pill-effort:hover {
    background: var(--cl-mod-strong, rgba(255,255,255,.12));
}

/* Ultracode reaches the pill too, so the tier is visible without opening
   anything. */
#${PILL_ID} .cl-tools-pill-effort.cl-ultra {
    background: rgba(124, 108, 240, .22);
    color: #c4b5fd;
}

#${PILL_ID} .cl-tools-caret {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    opacity: .75;
}

/* ---- popovers ---- */

#${MENU_ID},
#${EFFORT_ID} {
    position: absolute;
    right: 8px;
    bottom: calc(100% + 8px);
    z-index: 200;
    padding: 6px;
    border: 1px solid var(--cl-border, var(--border-subtle, rgba(255,255,255,.08)));
    border-radius: var(--radius-lg, 12px);
    background: var(--cl-bg-float, var(--background-floating, #2f2f2c));
    box-shadow: var(--cl-shadow-high, 0 10px 32px rgba(0,0,0,.45));
    font-family: var(--cl-sans, inherit);
    animation: cl-pop-in 130ms cubic-bezier(.22,1,.36,1) both;
}

#${MENU_ID} { min-width: 268px; }
#${EFFORT_ID} { min-width: 252px; }

@keyframes cl-pop-in {
    from { opacity: 0; transform: translateY(4px) scale(.98); }
    to   { opacity: 1; transform: none; }
}

#${MENU_ID} .cl-tools-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: var(--radius-sm, 8px);
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background-color 100ms ease;
}

#${MENU_ID} .cl-tools-row:hover {
    background: var(--cl-mod-subtle, rgba(255,255,255,.07));
}

#${MENU_ID} .cl-tools-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

#${MENU_ID} .cl-tools-label {
    color: var(--cl-text-1, var(--header-primary, #faf9f5));
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -.005em;
}

#${MENU_ID} .cl-tools-detail {
    color: var(--cl-text-5, var(--text-muted, #85837c));
    font-size: 12px;
    font-weight: 400;
}

#${MENU_ID} .cl-tools-chevron {
    flex: 0 0 auto;
    width: 15px;
    height: 15px;
    color: var(--cl-text-5, var(--text-muted, #85837c));
}

#${MENU_ID} .cl-tools-more[aria-expanded="true"] .cl-tools-chevron {
    transform: rotate(90deg);
}

#${MENU_ID} .cl-tools-hint {
    margin-left: auto;
    color: var(--cl-text-5, var(--text-muted, #85837c));
    font-size: 13px;
}

#${MENU_ID} .cl-tools-submenu {
    margin-top: 2px;
    padding-top: 4px;
    border-top: 1px solid var(--cl-border, rgba(255,255,255,.08));
}

#${MENU_ID} .cl-tools-submenu .cl-tools-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--cl-text-3, var(--text-default, #c2c0b6));
}

/* ---- effort panel ----
   Selectors aren't scoped to a container id: the panel lives in its own popover
   now, and this keeps it reusable if it ever gets embedded elsewhere. */

.cl-effort {
    padding: 6px 10px 12px;
}

.cl-effort-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
}

.cl-effort-title {
    color: var(--cl-text-4, var(--text-secondary, #a3a099));
    font-size: 13px;
}

.cl-effort-value {
    color: var(--cl-text-1, var(--header-primary, #faf9f5));
    font-size: 13px;
    font-weight: 600;
}

.cl-effort-help {
    margin-left: auto;
    width: 16px;
    height: 16px;
    border: 1px solid var(--cl-border-strong, rgba(255,255,255,.16));
    border-radius: 50%;
    color: var(--cl-text-5, var(--text-muted, #85837c));
    font-size: 10px;
    line-height: 14px;
    text-align: center;
    cursor: help;
}

.cl-effort-axis {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
    color: var(--cl-text-4, var(--text-secondary, #a3a099));
    font-size: 12px;
}

/* The rail carries the visible background; the input's own track is transparent
   so the notch markers underneath show through and only the thumb is drawn. */
.cl-effort-slider {
    position: relative;
    height: 26px;
    border-radius: var(--radius-round, 999px);
    background: var(--cl-mod-subtle, rgba(255,255,255,.07));
    overflow: hidden;
}

.cl-effort-marks {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    pointer-events: none;
}

.cl-effort-mark {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--cl-text-5, var(--text-muted, #85837c));
    opacity: .55;
    transition: opacity 200ms ease;
}

/* The top tier is flagged on the rail even when it isn't selected. */
.cl-effort-mark-ultra {
    background: #7c6cf0;
    opacity: 1;
}

.cl-effort-range {
    -webkit-appearance: none;
    appearance: none;
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    height: 26px;
    margin: 0;
    background: transparent;
    cursor: grab;
}

.cl-effort-range:active {
    cursor: grabbing;
}

.cl-effort-range::-webkit-slider-runnable-track {
    height: 26px;
    background: transparent;
    border: none;
}

.cl-effort-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 26px;
    height: 22px;
    margin-top: 2px;
    border: none;
    border-radius: 7px;
    background: #d9d7ce;
    box-shadow: 0 1px 3px rgba(0,0,0,.35);
    transition: box-shadow 120ms ease;
}

.cl-effort-range:active::-webkit-slider-thumb {
    box-shadow: 0 2px 8px rgba(0,0,0,.45);
}

.cl-effort-range::-moz-range-track {
    height: 26px;
    background: transparent;
    border: none;
}

.cl-effort-range::-moz-range-thumb {
    width: 26px;
    height: 22px;
    border: none;
    border-radius: 7px;
    background: #d9d7ce;
    box-shadow: 0 1px 3px rgba(0,0,0,.35);
}

/* ---- Ultracode ----
   Dithered violet rail: a fine dot grid over a left-to-right violet ramp, which
   reads as pixel dither without needing an image asset. Two dot layers at
   different sizes drift at different rates, so the texture shimmers rather than
   sliding as one sheet. Both offsets are whole multiples of their tile, so each
   loop is seamless. */
.cl-effort.cl-ultra .cl-effort-slider {
    background-image:
        radial-gradient(circle at center, rgba(255,255,255,.42) .5px, transparent .5px),
        radial-gradient(circle at center, rgba(255,255,255,.2) .5px, transparent .5px),
        linear-gradient(90deg, #2f2350 0%, #4a3a7d 38%, #7d68c4 70%, #c3b3ee 100%);
    background-size: 3px 3px, 5px 5px, 100% 100%;
    animation: cl-ultra-drift 1.9s linear infinite;
}

@keyframes cl-ultra-drift {
    from { background-position: 0 0, 0 0, 0 0; }
    to   { background-position: 6px 0, -5px 0, 0 0; }
}

/* Light sweeping across the rail. Sits above the dither but below the thumb,
   which is lifted by its own z-index. */
.cl-effort.cl-ultra .cl-effort-slider::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(100deg, transparent 34%, rgba(255,255,255,.22) 50%, transparent 66%);
    animation: cl-ultra-sweep 2.9s ease-in-out infinite;
}

@keyframes cl-ultra-sweep {
    0%        { transform: translateX(-100%); }
    55%, 100% { transform: translateX(100%); }
}

/* The dither supplies its own texture; the plain notches would fight it. */
.cl-effort.cl-ultra .cl-effort-mark {
    opacity: 0;
}

.cl-effort.cl-ultra .cl-effort-range::-webkit-slider-thumb {
    background: #f4f2fb;
    box-shadow: 0 1px 4px rgba(60,40,120,.55);
}

.cl-effort.cl-ultra .cl-effort-range::-moz-range-thumb {
    background: #f4f2fb;
}

/* Violet shimmer on the label, gradient-clipped to the glyphs. */
.cl-effort.cl-ultra .cl-effort-value {
    background: linear-gradient(90deg, #a78bfa, #e9d5ff, #a78bfa);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    animation: cl-ultra-text 3.2s linear infinite;
}

@keyframes cl-ultra-text {
    to { background-position: 200% 0; }
}

@media (prefers-reduced-motion: reduce) {
    #${MENU_ID},
    #${EFFORT_ID},
    .cl-effort.cl-ultra .cl-effort-slider,
    .cl-effort.cl-ultra .cl-effort-slider::after,
    .cl-effort.cl-ultra .cl-effort-value {
        animation: none;
    }
}
`;
    document.head.appendChild(style);

    // Label may have changed; rebuild rather than patch.
    document.getElementById(PILL_ID)?.remove();
    scheduleSync();
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

    closeAll();
    document.getElementById(PILL_ID)?.remove();

    style?.remove();
    style = null;

    for (const el of document.querySelectorAll<HTMLElement>(`.${HIDDEN_CLASS}`)) {
        el.classList.remove(HIDDEN_CLASS);
    }
}
