/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { ReactNode } from "react";

/**
 * Lets a setting's onChange reach the feature runner in index.tsx without this
 * module importing it — the features import this module, so importing back would
 * be circular.
 */
export const hooks: { refresh?: () => void; } = {};

const refresh = () => hooks.refresh?.();

/**
 * Section heading. definePluginSettings renders entries in declaration order, so
 * a COMPONENT entry placed before a group acts as its header — without one, the
 * panel is a flat wall of fourteen switches with no indication of which sub-setting
 * belongs to which feature.
 */
function heading(title: string, blurb: string) {
    return {
        type: OptionType.COMPONENT as const,
        // Plain markup on Discord's own colour tokens rather than Vencord's Forms
        // components: those are deprecated aliases whose props have shifted, and a
        // static heading has no reason to depend on them.
        component: (): ReactNode => (
            <div style={{ marginTop: 22, marginBottom: 8 }}>
                <div style={{
                    marginBottom: 4,
                    color: "var(--header-primary)",
                    font: "600 15px/1.2 var(--font-display, var(--font-primary))",
                    letterSpacing: "-.01em",
                }}>
                    {title}
                </div>
                <div style={{
                    color: "var(--text-muted)",
                    font: "400 13px/1.45 var(--font-primary)",
                }}>
                    {blurb}
                </div>
            </div>
        ),
    };
}

export const settings = definePluginSettings({
    /* ================= startup greeting ================= */
    greetingHeader: heading(
        "Startup greeting",
        "A full-screen splash when Discord launches: the Claude mark and one of Claude's greetings, chosen for the time of day and day of week."
    ),
    enableGreeting: {
        type: OptionType.BOOLEAN,
        description: "Show the greeting on startup (takes effect next launch)",
        default: true,
    },
    greetingVariety: {
        type: OptionType.BOOLEAN,
        description: "Use the full set of lines, including day-specific and late-night ones. Off shows only the plain time-of-day greeting.",
        default: true,
    },
    greetingShowLogo: {
        type: OptionType.BOOLEAN,
        description: "Show the Claude mark above the text",
        default: true,
    },
    greetingDuration: {
        type: OptionType.SLIDER,
        description: "Seconds on screen once your name resolves",
        markers: [1.2, 1.8, 2.4, 3, 4, 5],
        default: 2.4,
        stickToMarkers: false,
    },
    greetingName: {
        type: OptionType.STRING,
        description: "Greet you by this name instead of your Discord display name",
        placeholder: "Leave blank to use your account",
        default: "",
    },

    /* ================= home icon ================= */
    homeIconHeader: heading(
        "Home button",
        "Swaps Discord's mark on the server rail's home button for the Claude mark, tinted to the theme's accent."
    ),
    enableHomeIcon: {
        type: OptionType.BOOLEAN,
        description: "Use the Claude mark on the home button",
        default: true,
        onChange: refresh,
    },
    homeIconSize: {
        type: OptionType.SLIDER,
        description: "How much of the button the mark fills (%)",
        markers: [40, 50, 56, 65, 75, 85],
        default: 56,
        stickToMarkers: false,
        onChange: refresh,
    },

    /* ================= sidebar tabs ================= */
    sidebarHeader: heading(
        "Sidebar tabs",
        "Claude Desktop's segmented Home / DMs control at the top of the sidebar. Home returns you to the exact channel you left, remembered across restarts."
    ),
    enableSidebarTabs: {
        type: OptionType.BOOLEAN,
        description: "Show the Home / DMs tabs",
        default: true,
        onChange: refresh,
    },
    sidebarHideRail: {
        type: OptionType.BOOLEAN,
        description: "Hide the server rail while DMs is active, so the sidebar shows one thing at a time",
        default: true,
        onChange: refresh,
    },
    sidebarDmsLabel: {
        type: OptionType.STRING,
        description: "Label for the second tab",
        placeholder: "DMs",
        default: "DMs",
        onChange: refresh,
    },

    /* ================= composer ================= */
    composerHeader: heading(
        "Composer menu",
        "Collapses the attach, GIF, sticker, emoji, apps and gift buttons into one Claude-style pill at the end of the composer."
    ),
    enableComposerTools: {
        type: OptionType.BOOLEAN,
        description: "Collapse the composer buttons into one menu",
        default: true,
        onChange: refresh,
    },
    composerPillLabel: {
        type: OptionType.STRING,
        description: "Model name shown on the pill",
        placeholder: "Opus 5",
        default: "Opus 5",
        onChange: refresh,
    },

    /* ================= effort ================= */
    effortHeader: heading(
        "Effort",
        "Holds each message in a \"Thinking…\" state before it posts — the higher the effort, the longer. Purely cosmetic: the message is unchanged. You can keep sending while one is held; they queue and post in order."
    ),
    enableEffortDelay: {
        type: OptionType.BOOLEAN,
        description: "Hold messages before sending",
        default: true,
        onChange: refresh,
    },
    effortLevel: {
        type: OptionType.SELECT,
        // A named list rather than a 0–5 slider: the index alone told you nothing,
        // and this is also settable from the pill in the composer.
        description: "Effort level — also settable from the composer pill",
        options: [
            { label: "Low — 0.8s", value: 0 },
            { label: "Medium — 2.0s", value: 1, default: true },
            { label: "High — 3.8s", value: 2 },
            { label: "Extra — 6.0s", value: 3 },
            { label: "Max — 9.0s", value: 4 },
            { label: "Ultracode — 14.0s", value: 5 },
        ],
        onChange: refresh,
    },
}, {
    // Sub-settings grey out when their feature is off, so the panel never offers a
    // knob that currently does nothing.
    greetingVariety: { disabled: () => !settings.store.enableGreeting },
    greetingShowLogo: { disabled: () => !settings.store.enableGreeting },
    greetingDuration: { disabled: () => !settings.store.enableGreeting },
    greetingName: { disabled: () => !settings.store.enableGreeting },

    homeIconSize: { disabled: () => !settings.store.enableHomeIcon },

    sidebarHideRail: { disabled: () => !settings.store.enableSidebarTabs },
    sidebarDmsLabel: { disabled: () => !settings.store.enableSidebarTabs },

    composerPillLabel: { disabled: () => !settings.store.enableComposerTools },

    effortLevel: { disabled: () => !settings.store.enableEffortDelay },
});
