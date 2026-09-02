/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { HeadingSecondary } from "@components/Heading";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { isNonNullish } from "@utils/guards";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Channel, Message, RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, GuildMemberStore, GuildRoleStore, Menu, Modal, NavigationRouter, openModal, showToast, TextArea, Toasts, useEffect, UserStore, useState } from "@webpack/common";

import { DEFAULT_RULES, PublishFlag, ReviewUsage, Violation, WatchedMessage } from "./prompt";

const cl = classNameFactory("vc-claude-modwatch-");
const logger = new Logger("ClaudeModWatch");

const Native = VencordNative.pluginHelpers.ClaudeModWatch as PluginNative<typeof import("./native")>;

/** Hard ceiling on one request, matching the native side. */
const MAX_BATCH = 100;

/** If a review is slow and chat is fast, the oldest waiting messages are dropped rather than piling up forever. */
const MAX_BUFFERED = 300;

/** Kept in memory only, so other people's messages never land in settings.json. */
const MAX_FLAGGED = 200;

const ERROR_TOAST_INTERVAL_MS = 60_000;

const SETTINGS_KEYS: ("watchedChannels" | "rules")[] = ["watchedChannels", "rules"];

/** Watched out of the box, in guild 1147089171723321454. Toggle it off like any other. */
const DEFAULT_WATCHED_CHANNEL = "1479203981489082532";

interface MessageCreatePayload {
    channelId: string;
    message: Message;
    optimistic?: boolean;
}

interface FlaggedMessage {
    key: string;
    channelId: string;
    messageId: string;
    author: string;
    content: string;
    rule: string;
    severity: number;
    reason: string;
    quote: string;
    at: number;
}

const buffers = new Map<string, WatchedMessage[]>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reviewing = new Set<string>();
const flagged: FlaggedMessage[] = [];
const listeners = new Set<() => void>();

const usage: ReviewUsage & { calls: number; } = { calls: 0, input: 0, output: 0 };
let lastErrorToast = 0;

/** The missing-key complaint is worth making once a session, not every batch. */
let warnedAboutSetup = false;

const settings = definePluginSettings({
    ollamaUrl: {
        type: OptionType.STRING,
        description: "Where Ollama is listening. Nothing you watch leaves this machine to be read.",
        default: "http://127.0.0.1:11434"
    },
    model: {
        type: OptionType.STRING,
        description: "The local model that reads the chat. It has to be one `ollama list` shows.",
        default: "hauhau-8k:latest"
    },
    contextTokens: {
        type: OptionType.SLIDER,
        description: "Context size the model is given. Too small and the front of a batch is silently dropped; too large and it spills out of VRAM and crawls.",
        markers: [2048, 4096, 8192, 16384, 32768],
        default: 8192,
        stickToMarkers: true
    },
    rulesEditor: {
        type: OptionType.COMPONENT,
        description: "The rules the model checks against.",
        component: RulesEditor
    },
    allowedTerms: {
        type: OptionType.STRING,
        description: "Words your server permits, comma separated. Enforced here rather than asked of the model, because every model tested flagged them anyway. Matched from the start of a word, so \"fuck\" also covers \"fucking\".",
        default: "fuck, shit, bitch, ass, arse, dick, piss, crap, damn, hell, bastard, prick, wanker, bollocks, twat, nigga, retard"
    },
    bannedTerms: {
        type: OptionType.STRING,
        description: "Words your server bans, comma separated. These outrank the permitted list, so a message swearing AND using one of these is still reported.",
        default: "faggot, nigger, kys, kill yourself, kill urself, kill himself, kill herself"
    },
    batchSize: {
        type: OptionType.SLIDER,
        description: "How many messages pile up in a channel before they are sent off to be read. Smaller batches give the model less to hold at once, which it judges more accurately, at the cost of running more often.",
        markers: [5, 10, 15, 20, 30, 50],
        default: 15,
        stickToMarkers: true
    },
    idleMinutes: {
        type: OptionType.SLIDER,
        description: "Read a part-full batch anyway after this many quiet minutes, so a slow channel does not sit unchecked. Zero waits for a full batch.",
        markers: [0, 1, 3, 5, 10, 30],
        default: 3,
        stickToMarkers: true
    },
    minSeverity: {
        type: OptionType.SLIDER,
        description: "The lowest severity worth telling you about. 1 shows every borderline call, 3 only plain rule breaks.",
        markers: [1, 2, 3, 4, 5],
        default: 2,
        stickToMarkers: true
    },
    notifyStyle: {
        type: OptionType.SELECT,
        description: "How you hear about a flagged message.",
        options: [
            { label: "Notification", value: "notification", default: true },
            { label: "Toast", value: "toast" },
            { label: "Nothing, just collect them in the panel", value: "silent" }
        ]
    },
    panelUrl: {
        type: OptionType.STRING,
        description: "Mirrors flagged messages to your xocat.host panel so you can read them in a browser. Clear it to keep everything inside Discord.",
        default: "https://xocat.host"
    },
    panelToken: {
        type: OptionType.STRING,
        description: "The MODWATCH_INGEST_TOKEN you set on the xocat.host Pages project. Nothing is published without it.",
        default: "",
        placeholder: "paste the ingest token"
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Skip messages from bots and webhooks.",
        default: true
    },
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Skip your own messages.",
        default: true
    },
    exemptRoles: {
        type: OptionType.STRING,
        description: "Comma separated role names that are never checked. Staff enforce the rules rather than being measured against them.",
        default: "WEAO Trial Mod, WEAO Mod, WEAO Administration, WEAO Management"
    },
    watched: {
        type: OptionType.COMPONENT,
        description: "Channels being watched.",
        component: WatchedChannels
    },
    review: {
        type: OptionType.COMPONENT,
        description: "Flagged messages and what this has cost so far.",
        component: ReviewSummary
    }
}).withPrivateSettings<{ watchedChannels?: string[]; rules?: string; }>();

function notifyListeners() {
    for (const listener of listeners) listener();
}

/** Re-renders a component whenever the flagged list or the usage totals move. */
function useReviewState() {
    const [, bump] = useState(0);

    useEffect(() => {
        const listener = () => bump(n => n + 1);
        listeners.add(listener);
        return () => void listeners.delete(listener);
    }, []);
}

function isWatched(channelId: string) {
    return settings.store.watchedChannels?.includes(channelId) === true;
}

function toggleChannel(channelId: string) {
    const watched = settings.store.watchedChannels ?? [];

    if (watched.includes(channelId)) {
        settings.store.watchedChannels = watched.filter(id => id !== channelId);
        stopWatching(channelId);
    } else {
        settings.store.watchedChannels = [...watched, channelId];
    }
}

/**
 * Server channels only. Rules belong to a server, and a DM is not something a server's
 * rules govern, so there is nothing sensible to check a DM against.
 */
function canWatch(channel: Channel) {
    return Boolean(channel.guild_id)
        && !channel.isCategory()
        && !channel.isDirectory()
        && !channel.isForumLikeChannel();
}

function describeChannel(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    return channel?.name ? `#${channel.name}` : `channel ${channelId}`;
}

function stopWatching(channelId: string) {
    clearIdleTimer(channelId);
    buffers.delete(channelId);
}

function clearIdleTimer(channelId: string) {
    const timer = idleTimers.get(channelId);
    if (timer === undefined) return;

    clearTimeout(timer);
    idleTimers.delete(channelId);
}

function scheduleIdleFlush(channelId: string) {
    clearIdleTimer(channelId);

    const minutes = settings.store.idleMinutes;
    if (!minutes) return;

    idleTimers.set(channelId, setTimeout(() => {
        idleTimers.delete(channelId);
        void flush(channelId);
    }, minutes * 60_000));
}

function splitTerms(value: string | undefined) {
    return (value ?? "")
        .split(/[,\n]/)
        .map(term => term.trim().toLowerCase())
        .filter(Boolean);
}

function exemptRoleNames() {
    return new Set(
        (settings.store.exemptRoles ?? "")
            .split(/[,\n]/)
            .map(name => name.trim().toLowerCase())
            .filter(Boolean)
    );
}

/**
 * Staff are exempt by role name rather than by id, so the list stays readable and
 * survives a role being recreated. It does mean renaming a role silently un-exempts it.
 *
 * Roles come from the member store first and the message payload second: the store is
 * authoritative but only knows members Discord has actually sent us, and in a large
 * server a staff member who has not been loaded yet would otherwise be checked.
 */
function isExempt(channelId: string, message: Message) {
    const exempt = exemptRoleNames();
    if (!exempt.size) return false;

    const guildId = ChannelStore.getChannel(channelId)?.guild_id;
    if (!guildId) return false;

    const roles = GuildMemberStore.getMember(guildId, message.author.id)?.roles
        ?? (message as { member?: { roles?: string[]; }; }).member?.roles
        ?? [];

    return roles.some(roleId => {
        const name = GuildRoleStore.getRole(guildId, roleId)?.name;
        return name != null && exempt.has(name.trim().toLowerCase());
    });
}

function toWatched(message: Message): WatchedMessage | null {
    const content = message.content?.trim() ?? "";
    const attachments = (message.attachments ?? [])
        .map(attachment => attachment.filename)
        .filter(isNonNullish);

    // Nothing to read: a sticker, an embed-only post, a join notice.
    if (!content && !attachments.length) return null;

    return {
        id: message.id,
        author: message.author.username,
        content,
        attachments
    };
}

function collect(channelId: string, message: Message) {
    const watched = toWatched(message);
    if (!watched) return;

    const buffered = buffers.get(channelId) ?? [];
    buffered.push(watched);

    if (buffered.length > MAX_BUFFERED) buffered.splice(0, buffered.length - MAX_BUFFERED);
    buffers.set(channelId, buffered);

    if (buffered.length >= settings.store.batchSize) void flush(channelId);
    else scheduleIdleFlush(channelId);
}

function reportError(message: string) {
    logger.warn(message);

    const now = Date.now();
    if (now - lastErrorToast < ERROR_TOAST_INTERVAL_MS) return;

    lastErrorToast = now;
    showToast(`Claude mod watch: ${message}`, Toasts.Type.FAILURE);
}

async function flush(channelId: string) {
    clearIdleTimer(channelId);

    // One review per channel at a time, so a slow reply cannot double-bill the same chat.
    if (reviewing.has(channelId)) return;

    const buffered = buffers.get(channelId);
    if (!buffered?.length) return;

    const { ollamaUrl, model, rules, contextTokens } = settings.store;
    if (!rules?.trim()) {
        // Silently dropping these would look exactly like a channel where nobody breaks a rule,
        // so say it once rather than let the user wonder why nothing ever arrives.
        if (!warnedAboutSetup) {
            warnedAboutSetup = true;
            reportError("no rules are set, so nothing is being checked.");
        }

        buffers.delete(channelId);
        return;
    }

    const batch = buffered.splice(0, MAX_BATCH);
    if (!buffered.length) buffers.delete(channelId);

    reviewing.add(channelId);
    try {
        const result = await Native.review({
            baseUrl: ollamaUrl,
            model,
            rules,
            contextTokens,
            allowedTerms: splitTerms(settings.store.allowedTerms),
            bannedTerms: splitTerms(settings.store.bannedTerms),
            messages: batch
        });

        if (!result.ok) {
            // The batch is deliberately not put back. Retrying a batch that already failed
            // once mostly means paying for the same failure again.
            reportError(result.error);
            return;
        }

        usage.calls += 1;
        usage.input += result.usage.input;
        usage.output += result.usage.output;

        record(channelId, batch, result.violations);
    } catch (error) {
        reportError(error instanceof Error ? error.message : String(error));
    } finally {
        reviewing.delete(channelId);
        notifyListeners();
    }
}

function record(channelId: string, batch: WatchedMessage[], violations: Violation[]) {
    const { minSeverity } = settings.store;

    const entries = violations
        .filter(violation => violation.severity >= minSeverity)
        .map(violation => {
            const source = batch[violation.index];
            if (!source) return null;

            return {
                key: `${source.id}-${violation.rule}`,
                channelId,
                messageId: source.id,
                author: source.author,
                content: source.content,
                rule: violation.rule,
                severity: violation.severity,
                reason: violation.reason,
                quote: violation.quote,
                at: Date.now()
            } satisfies FlaggedMessage;
        })
        .filter(isNonNullish);

    if (!entries.length) return;

    flagged.unshift(...entries);
    if (flagged.length > MAX_FLAGGED) flagged.length = MAX_FLAGGED;

    announce(channelId, entries);
    void publishFlags(entries);
}

/**
 * Mirrors flags to the xocat.host panel. Deliberately fire-and-forget: the in-Discord
 * panel is the source of truth for the current session, and a site that is down should
 * not cost you a notification you would otherwise have seen.
 */
async function publishFlags(entries: FlaggedMessage[]) {
    const { panelUrl, panelToken } = settings.store;
    if (!panelUrl?.trim() || !panelToken?.trim()) return;

    const flags: PublishFlag[] = entries.map(entry => {
        const channel = ChannelStore.getChannel(entry.channelId);

        return {
            id: entry.key,
            channelId: entry.channelId,
            channelName: channel?.name ?? null,
            guildId: channel?.guild_id ?? null,
            messageId: entry.messageId,
            author: entry.author,
            content: entry.content,
            rule: entry.rule,
            severity: entry.severity,
            reason: entry.reason,
            quote: entry.quote,
            flaggedAt: entry.at
        };
    });

    const result = await Native.publish({ baseUrl: panelUrl, token: panelToken, flags });
    if (!result.ok) reportError(`could not publish to the panel — ${result.error}`);
}

function announce(channelId: string, entries: FlaggedMessage[]) {
    const style = settings.store.notifyStyle;
    if (style === "silent") return;

    const where = describeChannel(channelId);

    if (style === "toast") {
        showToast(`${entries.length} flagged in ${where}`, Toasts.Type.MESSAGE);
        return;
    }

    if (entries.length > 3) {
        showNotification({
            title: `${entries.length} messages flagged in ${where}`,
            body: "Open the review panel to read them.",
            onClick: openReviewPanel
        });
        return;
    }

    for (const entry of entries) {
        showNotification({
            title: `${entry.author} in ${where}`,
            body: `${entry.rule} — ${entry.reason}`,
            onClick: () => jumpTo(entry)
        });
    }
}

function jumpTo(entry: FlaggedMessage) {
    const guildId = ChannelStore.getChannel(entry.channelId)?.guild_id ?? "@me";
    NavigationRouter.transitionTo(`/channels/${guildId}/${entry.channelId}/${entry.messageId}`);
}

function dismiss(key: string) {
    const index = flagged.findIndex(entry => entry.key === key);
    if (index === -1) return;

    flagged.splice(index, 1);
    notifyListeners();
}

// Kept in step with the labels on the xocat.host panel. "clear" read as an instruction
// rather than a rating, so severity 3 is "breach".
const SEVERITY_LABELS = ["", "borderline", "minor", "breach", "bad", "serious"];

function severityLabel(severity: number) {
    return SEVERITY_LABELS[severity] ?? String(severity);
}

function RulesEditor() {
    const { rules } = settings.use(SETTINGS_KEYS);

    return (
        <div className={cl("rules")}>
            <Paragraph>
                Paste your server's rules here, in whatever wording your members actually see. Claude judges against
                these and nothing else, so a rule you leave out is a rule it will not enforce.
            </Paragraph>
            <TextArea
                value={rules ?? ""}
                onChange={(value: string) => { settings.store.rules = value; }}
                placeholder={"1. No slurs or targeted harassment.\n2. Keep it civil during disagreements.\n3. No unsolicited DM advertising.\n4. Spoilers go behind tags."}
                rows={8}
            />
        </div>
    );
}

function WatchedChannels() {
    const { watchedChannels } = settings.use(SETTINGS_KEYS);

    if (!watchedChannels?.length)
        return <Paragraph>Nothing is being watched. Right click a server channel and pick "Watch with Claude" to turn it on there.</Paragraph>;

    return (
        <div className={cl("list")}>
            {watchedChannels.map(id => (
                <div key={id} className={cl("row")}>
                    <Paragraph>{describeChannel(id)}</Paragraph>
                    <Button variant="dangerSecondary" size="small" onClick={() => toggleChannel(id)}>Stop watching</Button>
                </div>
            ))}
        </div>
    );
}

function ReviewSummary() {
    useReviewState();

    return (
        <div className={cl("list")}>
            <div className={cl("row")}>
                <Paragraph>
                    {flagged.length === 0
                        ? "Nothing flagged so far."
                        : `${flagged.length} flagged message${flagged.length === 1 ? "" : "s"} waiting for you.`}
                </Paragraph>
                <Button size="small" onClick={openReviewPanel}>Open review panel</Button>
            </div>
            <Paragraph>
                This session: {usage.calls} check{usage.calls === 1 ? "" : "s"} run locally,
                {" "}{usage.input.toLocaleString()} tokens read and {usage.output.toLocaleString()} written.
            </Paragraph>
        </div>
    );
}

function ReviewPanel({ modalProps }: { modalProps: RenderModalProps; }) {
    useReviewState();

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Flagged messages"
            subtitle="Claude's reading of the rules, not a decision. Nothing here has been acted on."
            actions={[
                {
                    text: "Clear all",
                    variant: "secondary",
                    disabled: flagged.length === 0,
                    onClick: () => {
                        flagged.length = 0;
                        notifyListeners();
                    }
                },
                { text: "Close", variant: "primary", onClick: modalProps.onClose }
            ]}
        >
            {flagged.length === 0
                ? <Paragraph>Nothing is flagged. Watched channels are read in batches, so give it a while.</Paragraph>
                : (
                    <div className={cl("flags")}>
                        {flagged.map(entry => (
                            <div key={entry.key} className={cl("flag")}>
                                <div className={cl("flag-head")}>
                                    <HeadingSecondary>{entry.author} in {describeChannel(entry.channelId)}</HeadingSecondary>
                                    <span className={cl("severity", `severity-${entry.severity}`)}>
                                        {severityLabel(entry.severity)}
                                    </span>
                                </div>
                                <Paragraph className={cl("rule")}>{entry.rule}</Paragraph>
                                <Paragraph>{entry.reason}</Paragraph>
                                <blockquote className={cl("quote")}>{entry.quote}</blockquote>
                                <div className={cl("flag-actions")}>
                                    <Button size="small" onClick={() => { jumpTo(entry); modalProps.onClose(); }}>Jump to it</Button>
                                    <Button size="small" variant="secondary" onClick={() => dismiss(entry.key)}>Dismiss</Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
        </Modal>
    );
}

function openReviewPanel() {
    openModal(modalProps => <ReviewPanel modalProps={modalProps} />);
}

function AboutPlugin() {
    return (
        <>
            <Paragraph>
                Watches the channels you pick and has a model on this machine read them in batches against your
                server's rules. When a message breaks one, you get told about it. Nothing is deleted, nobody is timed
                out, and no message is ever sent on your behalf: every action stays yours.
            </Paragraph>
            <Paragraph>
                Reading is done by Ollama on this machine, so watched chat is not sent anywhere to be judged and the
                checking costs nothing. A small local model is a blunter judge than a large hosted one, so expect it to
                miss things and to call the occasional harmless line a violation. The severity slider is the dial for
                that.
            </Paragraph>
            <Notice variant="warning">
                If you fill in a panel address and token, flagged messages, and only those, are also sent to that site
                and kept for 30 days so you can read them in a browser. Clear the panel address to keep everything on
                this machine.
            </Notice>
            <Paragraph>
                Flagged messages in the panel here are held in memory only, so they are gone after a restart.
            </Paragraph>
        </>
    );
}

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!channel || !canWatch(channel)) return;

    children.push(
        <Menu.MenuSeparator key="vc-claude-modwatch-separator" />,
        <Menu.MenuCheckboxItem
            id="vc-claude-modwatch-toggle"
            key="vc-claude-modwatch-toggle"
            label="Watch with Claude"
            checked={isWatched(channel.id)}
            action={() => toggleChannel(channel.id)}
        />
    );
};

export default definePlugin({
    name: "ClaudeModWatch",
    description: "Has Claude read the channels you pick against your server's rules and tell you when someone breaks one. It only reports; every moderation action stays yours.",
    authors: [{ name: "xocat", id: 1525464078783615083n }],
    settings,
    settingsAboutComponent: AboutPlugin,

    start() {
        settings.store.rules ??= DEFAULT_RULES;
        settings.store.watchedChannels ??= [DEFAULT_WATCHED_CHANNEL];
        warnedAboutSetup = false;
    },

    stop() {
        for (const channelId of [...idleTimers.keys()]) clearIdleTimer(channelId);

        buffers.clear();
        reviewing.clear();
        flagged.length = 0;
        listeners.clear();
    },

    flux: {
        MESSAGE_CREATE({ channelId, message, optimistic }: MessageCreatePayload) {
            if (optimistic || !isWatched(channelId)) return;
            if (settings.store.ignoreBots && (message.author.bot || message.webhookId)) return;
            if (settings.store.ignoreSelf && message.author.id === UserStore.getCurrentUser()?.id) return;
            if (isExempt(channelId, message)) return;

            collect(channelId, message);
        }
    },

    toolboxActions: {
        "Review flagged messages": openReviewPanel
    },

    contextMenus: {
        "channel-context": channelContextPatch,
        "thread-context": channelContextPatch
    }
});
