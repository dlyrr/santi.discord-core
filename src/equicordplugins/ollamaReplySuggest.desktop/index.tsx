/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { RobotIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { getUniqueUsername, insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { isNonNullish } from "@utils/guards";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, DraftStore, FluxDispatcher, GuildMemberStore, IconUtils, Menu, MessageActions, MessageStore, PendingReplyStore, SelectedChannelStore, showToast, Toasts, useCallback, useEffect, useLayoutEffect, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";

import { conversationScope, forget, forgetEverything, loadMemory, MemoryEntry, personScope, recall, remember, rememberedScopes } from "./memory";

const cl = classNameFactory("vc-ollama-suggest-");
const logger = new Logger("OllamaReplySuggest");

const Native = VencordNative.pluginHelpers.OllamaReplySuggest as PluginNative<typeof import("./native")>;

const SETTINGS_KEYS: ("enabledChannels" | "autoSuggestOnReply")[] = ["enabledChannels", "autoSuggestOnReply"];

/** Shown on the button while a draft is generating. Local only, nothing is sent. */
const THINKING_EMOJI_ID = "1530864662940356759";

/** Posted to the channel while drafting, but only when announceDrafting is turned on. */
const THINKING_EMOJI = `<a:claudethinking:${THINKING_EMOJI_ID}>`;

interface HistoryMessage {
    role: "user" | "assistant";
    content: string;
    images: string[];
    files: { name: string; url: string; }[];
}

interface MessageCreatePayload {
    channelId: string;
    message: Message;
    optimistic?: boolean;
}

const settings = definePluginSettings({
    model: {
        type: OptionType.STRING,
        description: "The Ollama model tag to draft suggestions with.",
        default: "hauhau-8k:latest"
    },
    visionModel: {
        type: OptionType.STRING,
        description: "A model that can see, used to describe pictures for the model that writes. Empty it if the writing model can already see for itself.",
        default: "qwen2.5vl:7b"
    },
    contextMessages: {
        type: OptionType.SLIDER,
        description: "How many recent messages to read when you are not replying to anyone.",
        markers: [3, 5, 10, 15, 20, 30],
        default: 10,
        stickToMarkers: true
    },
    memoryMessages: {
        type: OptionType.SLIDER,
        description: "How many older messages per conversation to keep remembered across restarts. Zero turns memory off.",
        markers: [0, 20, 40, 60, 100, 150],
        default: 60,
        stickToMarkers: true
    },
    autoSuggest: {
        type: OptionType.BOOLEAN,
        description: "Draft something on its own when someone talks to you, in any conversation you turned on, even one you are not looking at.",
        default: true
    },
    replyInDms: {
        type: OptionType.BOOLEAN,
        description: "Treat every message in a direct or group message as one aimed at you, since it is.",
        default: true
    },
    replyToRoleMentions: {
        type: OptionType.BOOLEAN,
        description: "Count a ping of a role you have as a ping of you.",
        default: true
    },
    replyToEveryone: {
        type: OptionType.BOOLEAN,
        description: "Count everyone and here pings too. Announcements will get answered, so this one is off.",
        default: false
    },
    replyToApps: {
        type: OptionType.BOOLEAN,
        description: "Answer apps, bots and webhooks as well as people. Two of these pointed at each other will keep each other talking, so watch it in a busy channel.",
        default: true
    },
    triggerWords: {
        type: OptionType.STRING,
        description: "Extra words that count as someone talking to you, separated by commas. Names work well here.",
        default: ""
    },
    autoSuggestOnReply: {
        type: OptionType.BOOLEAN,
        description: "Draft something as soon as you hit reply on a message, before you type anything.",
        default: true
    },
    autoReply: {
        type: OptionType.BOOLEAN,
        description: "Send the draft by itself, with no press from you, whenever one was started for you. It goes out as a reply to whatever set it off. Discord treats a normal account sending messages on its own as self botting, so the risk is yours.",
        default: true
    },
    autoReplyDelay: {
        type: OptionType.SLIDER,
        description: "Seconds an automatic reply waits before it sends, so you have a moment to read it and dismiss it.",
        markers: [0, 3, 5, 10, 20, 30],
        default: 5,
        stickToMarkers: true
    },
    announceDrafting: {
        type: OptionType.BOOLEAN,
        description: "Post the thinking emoji to the channel while a draft is generating. This sends a real message on its own, which Discord treats as self botting, so leave it off unless you want that.",
        default: false
    },
    enabledConversations: {
        type: OptionType.COMPONENT,
        description: "Conversations where the suggest button appears.",
        component: EnabledConversations
    },
    memory: {
        type: OptionType.COMPONENT,
        description: "What has been remembered so far.",
        component: MemoryControls
    }
}).withPrivateSettings<{ enabledChannels?: string[]; }>();

function readField(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
}

function isEnabled(channelId: string) {
    return settings.store.enabledChannels?.includes(channelId) === true;
}

function toggleChannel(channelId: string) {
    const enabled = settings.store.enabledChannels ?? [];
    settings.store.enabledChannels = enabled.includes(channelId)
        ? enabled.filter(id => id !== channelId)
        : [...enabled, channelId];
}

function canSuggestIn(channel: Channel) {
    return !channel.isCategory() && !channel.isDirectory() && !channel.isGuildVocal() && !channel.isForumLikeChannel();
}

function describeChannel(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return `Conversation ${channelId}`;

    if (channel.isDM()) {
        const user = UserStore.getUser(channel.recipients[0]);
        return user ? `@${getUniqueUsername(user)}` : `Direct message ${channelId}`;
    }

    if (channel.isGroupDM()) return channel.name || "Group message";

    return `#${channel.name}`;
}

function isImage(attachment: Message["attachments"][number]) {
    return attachment.content_type?.startsWith("image/") === true;
}

function imageUrls(message: Message): string[] {
    return message.attachments.filter(isImage).map(a => a.url);
}

/** Everything that is not a picture. The main process decides what it can actually open. */
function fileAttachments(message: Message) {
    return message.attachments
        .filter(a => !isImage(a))
        .map(a => ({ name: a.filename, url: a.url }));
}

function isMine(message: Message) {
    return message.author.id === UserStore.getCurrentUser().id;
}

/**
 * A gateway payload spells this global_name, a message out of the store spells it
 * globalName, and either can be missing, so the username is the last word.
 */
function authorName(message: Message) {
    const globalName = message.author.globalName ?? readField(message.author, "global_name");
    return typeof globalName === "string" && globalName.length > 0 ? globalName : message.author.username;
}

function toHistoryMessage(message: Message): HistoryMessage {
    return {
        role: isMine(message) ? "assistant" : "user",
        content: message.content,
        images: imageUrls(message),
        files: fileAttachments(message)
    };
}

function parentMessageId(message: Message) {
    const reference = message.messageReference ?? readField(message, "message_reference");
    const id = readField(reference, "message_id");
    return typeof id === "string" ? id : undefined;
}

function parentAuthorId(channelId: string, message: Message) {
    const id = parentMessageId(message);
    if (id === undefined) return undefined;

    const cached = MessageStore.getMessage(channelId, id);
    if (cached) return cached.author.id;

    const author = readField(readField(message, "referenced_message"), "author");
    const authorId = readField(author, "id");
    return typeof authorId === "string" ? authorId : undefined;
}

function mentionsCurrentUser(message: Message) {
    const currentUserId = UserStore.getCurrentUser().id;
    const { mentions } = message;
    if (!Array.isArray(mentions)) return false;

    return mentions.some(mention => mention === currentUserId || readField(mention, "id") === currentUserId);
}

function mentionsMyRole(channelId: string, message: Message) {
    const mentioned = message.mentionRoles ?? readField(message, "mention_roles");
    if (!Array.isArray(mentioned) || mentioned.length === 0) return false;

    const guildId = ChannelStore.getChannel(channelId)?.guild_id;
    if (!guildId) return false;

    const mine = GuildMemberStore.getSelfMember(guildId)?.roles;
    if (!Array.isArray(mine)) return false;

    return mentioned.some(role => typeof role === "string" && mine.includes(role));
}

function mentionsEveryone(message: Message) {
    return (message.mentionEveryone ?? readField(message, "mention_everyone")) === true;
}

function matchesTriggerWord(message: Message) {
    const words = settings.store.triggerWords
        .split(",")
        .map(word => word.trim().toLowerCase())
        .filter(word => word.length > 0);

    const content = message.content.toLowerCase();
    return words.some(word => content.includes(word));
}

/**
 * What counts as being talked to. A direct mention and a reply to something you wrote
 * always count, the rest are yours to turn on.
 */
function isTalkingToMe(channelId: string, message: Message) {
    if (mentionsCurrentUser(message)) return true;
    if (parentAuthorId(channelId, message) === UserStore.getCurrentUser().id) return true;

    const channel = ChannelStore.getChannel(channelId);
    if (settings.store.replyInDms && channel && (channel.isDM() || channel.isGroupDM())) return true;

    if (settings.store.replyToRoleMentions && mentionsMyRole(channelId, message)) return true;
    if (settings.store.replyToEveryone && mentionsEveryone(message)) return true;

    return matchesTriggerWord(message);
}

function hasSomethingToRead(message: Message) {
    return !message.deleted && (message.content.length > 0 || message.attachments.length > 0);
}

function recentMessages(channelId: string): Message[] {
    const messages: Message[] = MessageStore.getMessages(channelId)?._array ?? [];
    return messages.filter(hasSomethingToRead).slice(-settings.store.contextMessages);
}

function replyChainMessages(channelId: string, message: Message): Message[] {
    const parentId = parentMessageId(message);
    const parent = parentId === undefined ? undefined : MessageStore.getMessage(channelId, parentId);

    return [parent, message].filter(isNonNullish).filter(hasSomethingToRead);
}

/**
 * Files a message away so a later draft can lean on it once Discord has dropped it from its
 * own cache. It goes under the conversation it was said in and under the person it concerns:
 * their own messages under them, and your replies under whoever you were replying to, so
 * each person's memory reads as the two of you talking.
 */
function rememberMessage(channelId: string, message: Message) {
    if (!hasSomethingToRead(message)) return;

    const mine = isMine(message);
    const about = mine ? parentAuthorId(channelId, message) : message.author.id;
    const scopes = [conversationScope(channelId)];

    if (about !== undefined && about !== UserStore.getCurrentUser().id) scopes.push(personScope(about));

    const attachments = message.attachments.map(a => isImage(a) ? "a picture" : a.filename);
    const note = attachments.length > 0 ? `[sent ${attachments.join(", ")}]` : "";

    remember(scopes, {
        id: message.id,
        name: mine ? "you" : authorName(message),
        content: [message.content, note].filter(part => part.length > 0).join(" ")
    }, settings.store.memoryMessages);
}

function memoryLines(scope: string, skip: Set<string>) {
    const entries = recall(scope, settings.store.memoryMessages).filter(entry => !skip.has(entry.id));
    for (const entry of entries) skip.add(entry.id);

    return entries;
}

function asTranscript(header: string, entries: MemoryEntry[]) {
    return entries.length === 0 ? "" : `${header}\n${entries.map(e => `${e.name}: ${e.content}`).join("\n")}`;
}

/**
 * What the model gets told it already knows: the person being answered first, since that is
 * who the reply is for, then the rest of the conversation. Anything already in the request
 * is left out, and so is anything the person block already covered.
 */
function recallText(channelId: string, target: Message | undefined, alreadySent: Set<string>) {
    const person = target && !isMine(target)
        ? asTranscript(
            `Between you and ${authorName(target)} before now, wherever you ran into them:`,
            memoryLines(personScope(target.author.id), alreadySent)
        )
        : "";

    const conversation = asTranscript(
        `Earlier in ${describeChannel(channelId)}:`,
        memoryLines(conversationScope(channelId), alreadySent)
    );

    return [person, conversation].filter(block => block.length > 0).join("\n\n");
}

/**
 * Posts the thinking emoji as a real message. This is the one place the plugin
 * sends anything without you pressing send, which is why it is opt in and off by
 * default. Failures stay quiet: a draft is still coming either way.
 */
function announceDrafting(channelId: string) {
    void sendMessage(channelId, { content: THINKING_EMOJI }).catch(e => {
        logger.warn("Could not post the drafting message", e);
    });
}

/**
 * Sends a draft as a reply to whatever it was written for: a reply you selected yourself
 * if there is one, otherwise the ping or the reply that set the draft off. Either way it
 * threads the way it would have if you had hit reply and typed it.
 *
 * A stored copy of the target is preferred over the payload it arrived in, but the payload
 * works on its own when the store has not caught up.
 */
async function sendDraft(entry: Draft, automatic: boolean) {
    const { key, channelId, target, content } = entry;
    if (content === null) return;

    dropDraft(key);

    const reply = PendingReplyStore.getPendingReply(channelId);
    const channel = ChannelStore.getChannel(channelId);

    const options = reply
        ? MessageActions.getSendMessageOptionsForReply(reply)
        : target && channel
            ? MessageActions.getSendMessageOptionsForReply({
                channel,
                message: MessageStore.getMessage(channelId, target.id) ?? target,
                shouldMention: true,
                showMentionToggle: false
            })
            : {};

    try {
        await sendMessage(channelId, { content }, true, options);

        if (reply) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
        if (automatic) showToast(`Replied on its own in ${describeChannel(channelId)}.`, Toasts.Type.MESSAGE);
    } catch (e) {
        logger.error("Could not send the draft", e);

        if (automatic) {
            showToast(`An automatic reply in ${describeChannel(channelId)} did not go through.`, Toasts.Type.FAILURE);
            return;
        }

        showToast("Could not send that. It is still in the box if you want to retry.", Toasts.Type.FAILURE);
        insertTextIntoChatInputBox(content);
    }
}

async function fetchSuggestion(channelId: string, messages: Message[], target: Message | undefined, quiet: boolean) {
    if (messages.length === 0) {
        if (!quiet) showToast("There is nothing here to reply to yet.", Toasts.Type.FAILURE);
        return null;
    }

    const history = messages.map(toHistoryMessage);
    const memory = recallText(channelId, target ?? messages[messages.length - 1], new Set(messages.map(m => m.id)));

    try {
        const result = await Native.requestSuggestion(settings.store.model, history, memory, settings.store.visionModel);

        if (!result.ok) {
            logger.warn("Suggestion failed:", result.error);
            if (!quiet) showToast(result.error, Toasts.Type.FAILURE);
            return null;
        }

        return result.content;
    } catch (e) {
        logger.error("Could not reach the Ollama helper", e);
        if (!quiet) showToast("Something went wrong talking to Ollama.", Toasts.Type.FAILURE);
        return null;
    }
}

/**
 * Drafts live here rather than in the chat bar button so a ping in a conversation you are
 * not looking at still gets one waiting for you when you open it. They are keyed by the
 * message being answered, so several can be in the air at once: someone pinging you while
 * an earlier reply is still being written gets their own draft rather than being dropped.
 * The button subscribes and renders whatever belongs to the channel it is mounted in.
 */
interface Draft {
    key: string;
    channelId: string;
    target?: Message;
    content: string | null;
}

/** A ceiling on drafts in flight, so a busy channel cannot pile requests onto Ollama. */
const MAX_DRAFTS_AT_ONCE = 4;

/** Message ids already drafted for, so one message never gets answered twice. */
const ANSWERED_LIMIT = 500;

const drafts = new Map<string, Draft>();
const answered = new Set<string>();
const autoReplyTimers = new Map<string, number>();
const listeners = new Set<() => void>();

function draftsChanged() {
    for (const listener of listeners) listener();
}

function draftsIn(channelId: string) {
    return [...drafts.values()].filter(entry => entry.channelId === channelId);
}

/** The line under a bubble. With several of them open it says which one answers who. */
function describeDraft(entry: Draft, newest: boolean) {
    if (autoReplyTimers.has(entry.key)) return "sending on its own, dismiss to stop";
    if (entry.target === undefined) return newest ? "enter to send" : "for the chat";

    return newest
        ? `enter to send, replying to ${authorName(entry.target)}`
        : `replying to ${authorName(entry.target)}`;
}

function cancelAutoReply(key: string) {
    const timer = autoReplyTimers.get(key);
    if (timer === undefined) return;

    clearTimeout(timer);
    autoReplyTimers.delete(key);
}

function dropDraft(key: string) {
    cancelAutoReply(key);
    drafts.delete(key);
    draftsChanged();
}

function markAnswered(messageId: string) {
    answered.add(messageId);
    if (answered.size <= ANSWERED_LIMIT) return;

    const oldest = answered.values().next();
    if (!oldest.done) answered.delete(oldest.value);
}

/**
 * The wait is the supervision window: dismissing the bubble or typing anything of your
 * own in that channel calls the send off and hands the reply back to you.
 */
function scheduleAutoReply(entry: Draft) {
    const timer = window.setTimeout(() => {
        autoReplyTimers.delete(entry.key);

        if (drafts.get(entry.key) !== entry) return;
        if (DraftStore.getDraft(entry.channelId, 0).length > 0) return;

        void sendDraft(entry, true);
    }, settings.store.autoReplyDelay * 1000);

    autoReplyTimers.set(entry.key, timer);
}

/**
 * `target` is the message being answered. Passing one means the draft was started for you
 * rather than by you, so it can send itself, the same message never gets answered twice,
 * and a failure stays silent instead of throwing a toast at you out of nowhere.
 */
function startDraft(channelId: string, messages: Message[], target?: Message) {
    const key = target ? target.id : `manual:${channelId}`;
    if (drafts.has(key)) return;

    if (target) {
        if (answered.has(target.id)) return;
        markAnswered(target.id);
    }

    if (drafts.size >= MAX_DRAFTS_AT_ONCE) {
        logger.warn(`Already writing ${drafts.size} drafts, skipping one in ${channelId}`);
        return;
    }

    const entry: Draft = { key, channelId, target, content: null };
    drafts.set(key, entry);
    draftsChanged();

    if (settings.store.announceDrafting) announceDrafting(channelId);

    void fetchSuggestion(channelId, messages, target, target !== undefined).then(content => {
        // Gone means you dismissed it while it was being written, so it is not yours anymore.
        if (drafts.get(key) !== entry) return;

        if (content === null) {
            // Nothing came back, usually Ollama being down, so let this one be tried again.
            if (target) answered.delete(target.id);
            dropDraft(key);
            return;
        }

        entry.content = content;
        draftsChanged();

        if (target === undefined) return;

        if (settings.store.autoReply) scheduleAutoReply(entry);
        else if (SelectedChannelStore.getChannelId() !== channelId)
            showToast(`A reply is waiting in ${describeChannel(channelId)}.`, Toasts.Type.MESSAGE);
    });
}

const SuggestButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const { enabledChannels, autoSuggestOnReply } = settings.use(SETTINGS_KEYS);
    const [, rerender] = useState(0);
    const [anchorRect, setAnchorRect] = useState<{ right: number; top: number; } | null>(null);
    const anchor = useRef<HTMLDivElement>(null);

    const replyTargetId = useStateFromStores(
        [PendingReplyStore],
        () => PendingReplyStore.getPendingReply(channel.id)?.message.id,
        [channel.id]
    );

    const enabled = isMainChat && enabledChannels?.includes(channel.id) === true;
    const mine = draftsIn(channel.id);
    const ready = mine.filter(entry => entry.content !== null);
    const loading = mine.some(entry => entry.content === null);

    // Enter and Escape act on the newest bubble, the one sitting closest to the box.
    const newest = ready[ready.length - 1];

    useEffect(() => {
        const listener = () => rerender(n => n + 1);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, []);

    // Enter accepts the draft, but only while the message box is empty. If you have
    // started typing, Enter belongs to what you wrote and is left alone.
    useEffect(() => {
        if (newest === undefined) return;

        const onKeydown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                dropDraft(newest.key);
                return;
            }

            if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey) return;
            if (DraftStore.getDraft(channel.id, 0).length > 0) return;

            event.preventDefault();
            event.stopPropagation();
            void sendDraft(newest, false);
        };

        document.addEventListener("keydown", onKeydown, true);
        return () => document.removeEventListener("keydown", onKeydown, true);
    }, [newest, channel.id]);

    useLayoutEffect(() => {
        if (ready.length === 0) {
            setAnchorRect(null);
            return;
        }

        function measure() {
            const bounds = anchor.current?.getBoundingClientRect();
            if (bounds) setAnchorRect({ right: bounds.right, top: bounds.top });
        }

        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, [ready.length]);

    // Hitting reply on someone is enough of a signal on its own, so a draft starts before
    // you type. Your own messages are skipped, since replying to yourself is a correction.
    useEffect(() => {
        if (!enabled || !autoSuggestOnReply || replyTargetId === undefined) return;

        const target = MessageStore.getMessage(channel.id, replyTargetId);
        if (!target || isMine(target)) return;

        startDraft(channel.id, replyChainMessages(channel.id, target), target);
    }, [enabled, autoSuggestOnReply, replyTargetId, channel.id]);

    const suggestNow = useCallback(() => {
        const reply = PendingReplyStore.getPendingReply(channel.id);
        startDraft(channel.id, reply
            ? replyChainMessages(channel.id, reply.message)
            : recentMessages(channel.id));
    }, [channel.id]);

    if (!enabled) return null;

    return (
        <div className={cl("wrapper")} ref={anchor}>
            {ready.length === 0 || anchorRect === null ? null : (
                <div className={cl("stack")} style={{ left: anchorRect.right, top: anchorRect.top - 10 }}>
                    {ready.map(entry => (
                        <div key={entry.key} className={cl("bubble")}>
                            <Paragraph className={cl("bubble-text")}>{entry.content}</Paragraph>
                            <div className={cl("bubble-actions")}>
                                <span className={cl("hint")}>{describeDraft(entry, entry === newest)}</span>
                                <Button variant="primary" size="xs" onClick={() => void sendDraft(entry, false)}>
                                    Send
                                </Button>
                                <Button
                                    variant="secondary"
                                    size="xs"
                                    onClick={() => {
                                        if (entry.content !== null) insertTextIntoChatInputBox(entry.content);
                                        dropDraft(entry.key);
                                    }}
                                >
                                    Edit
                                </Button>
                                <Button variant="secondary" size="xs" onClick={() => dropDraft(entry.key)}>Dismiss</Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            <ChatBarButton
                tooltip={loading
                    ? "Drafting a suggestion"
                    : replyTargetId === undefined ? "Suggest a reply" : "Suggest a reply to that message"}
                onClick={suggestNow}
            >
                {loading
                    ? <img
                        className={cl("drafting")}
                        src={IconUtils.getEmojiURL({ id: THINKING_EMOJI_ID, animated: true, size: 44 })}
                        alt=""
                        width={20}
                        height={20} />
                    : <RobotIcon width={20} height={20} className={cl("icon")} />}
            </ChatBarButton>
        </div>
    );
};

function EnabledConversations() {
    const { enabledChannels } = settings.use(SETTINGS_KEYS);

    if (!enabledChannels?.length)
        return <Paragraph>Right click a channel or DM and pick "Reply suggestions" to turn it on there. It is off everywhere until you do.</Paragraph>;

    return (
        <div className={cl("list")}>
            {enabledChannels.map(id => (
                <div key={id} className={cl("row")}>
                    <Paragraph>{describeChannel(id)}</Paragraph>
                    <Button variant="dangerSecondary" size="small" onClick={() => toggleChannel(id)}>Remove</Button>
                </div>
            ))}
        </div>
    );
}

function describeScope(scope: string) {
    const [kind, id] = [scope.slice(0, scope.indexOf(":")), scope.slice(scope.indexOf(":") + 1)];
    if (kind !== "user") return describeChannel(id);

    const user = UserStore.getUser(id);
    return user ? getUniqueUsername(user) : `Person ${id}`;
}

function MemoryControls() {
    const [, rerender] = useState(0);
    const remembered = rememberedScopes();

    if (remembered.length === 0)
        return <Paragraph>Nothing is remembered yet. Messages in the conversations above start piling up here as they arrive, one pile per person and one per conversation.</Paragraph>;

    return (
        <div className={cl("list")}>
            {remembered.map(({ scope, count }) => (
                <div key={scope} className={cl("row")}>
                    <Paragraph>{describeScope(scope)}, {count} messages</Paragraph>
                    <Button
                        variant="dangerSecondary"
                        size="small"
                        onClick={() => {
                            forget(scope);
                            rerender(n => n + 1);
                        }}
                    >
                        Forget
                    </Button>
                </div>
            ))}
            <Button
                variant="dangerSecondary"
                size="small"
                onClick={() => {
                    forgetEverything();
                    rerender(n => n + 1);
                }}
            >
                Forget everything
            </Button>
        </div>
    );
}

function AboutPlugin() {
    return (
        <Paragraph className={cl("about")}>
            Suggestions come from Ollama running on this machine, so Ollama needs to be running for any of this to do
            anything. Press the robot in the message box and a draft appears in a bubble above it. With no reply
            selected it reads the recent messages so you can join in, and with a reply selected it reads that message
            plus whatever it was replying to. A draft also starts on its own the moment someone talks to you in a
            conversation you turned on: a mention, a ping of a role you have, a reply to something you wrote, anything
            at all in a direct message, any word you listed as a trigger, and apps as well as people. It starts one
            when you hit reply on a message too. Several can be in the air at once, so someone pinging you while an
            earlier reply is still being written gets their own bubble instead of being dropped, and each bubble says
            who it answers. Enter and Escape act on the newest one. On top of the messages still on screen it keeps a
            rolling memory that survives restarts, kept twice over: one pile per conversation, and one pile per person,
            which is everything they have said to you and everything you said back wherever you ran into them. A draft
            gets the person's pile first, so someone who follows you from server to server is still the same person to
            it and old grudges carry. Both piles are listed in the settings and can be forgotten one at a time.
            Pictures get looked at, and a text file or a bit of code someone attached gets opened and read, up to two
            attachments per draft. Anything it cannot open, an archive or a video, it at least knows the name of. Set a
            vision model if the writing model cannot see: pictures get handed to it first, and what it says they are
            goes to the writer as text. Without one the pictures go straight to the writing model, which only helps if
            that model can see them itself.
            Two settings send messages on their own, which Discord treats as self botting from a normal account, so
            the risk there is yours. Auto reply, which is on, sends the draft itself with nothing from you every time
            one was started for you, as a reply to whatever set it off. It waits a few seconds first and a toast goes
            up each time it sends, and dismissing the bubble or typing anything of your own in that channel calls it
            off. Announce drafting, which is off, posts the thinking emoji to the channel while a draft is generating.
            Turn auto reply off and nothing is ever sent for you: you pick Send, or you edit it first and send it
            yourself. Drafts are written in your own casual lowercase Discord voice, which lives in prompt.ts
            if you want to tweak it. The model this ships with is an uncensored one, so read what it wrote.
        </Paragraph>
    );
}

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!channel || !canSuggestIn(channel)) return;

    children.push(
        <Menu.MenuSeparator key="vc-ollama-suggest-separator" />,
        <Menu.MenuCheckboxItem
            id="vc-ollama-suggest-toggle"
            key="vc-ollama-suggest-toggle"
            label="Reply suggestions"
            checked={isEnabled(channel.id)}
            action={() => toggleChannel(channel.id)}
        />
    );
};

export default definePlugin({
    name: "OllamaReplySuggest",
    description: "Drafts a reply with a local Ollama model, on its own when you are pinged or replied to, and shows it in a bubble above the message box for you to edit and send.",
    authors: [{ name: "xocat", id: 1525464078783615083n }],
    settings,
    settingsAboutComponent: AboutPlugin,

    async start() {
        await loadMemory();
    },

    stop() {
        for (const key of [...autoReplyTimers.keys()]) cancelAutoReply(key);

        drafts.clear();
        answered.clear();
        listeners.clear();
    },

    // Global rather than per channel: this is what lets a ping somewhere you are not
    // looking get a draft, and what keeps memory filling up while you read elsewhere.
    flux: {
        MESSAGE_CREATE({ channelId, message, optimistic }: MessageCreatePayload) {
            if (optimistic || !isEnabled(channelId)) return;

            rememberMessage(channelId, message);

            if (!settings.store.autoSuggest) return;
            if (isMine(message) || !hasSomethingToRead(message)) return;
            if (message.author.bot && !settings.store.replyToApps) return;
            if (!isTalkingToMe(channelId, message)) return;

            startDraft(channelId, replyChainMessages(channelId, message), message);
        }
    },

    chatBarButton: {
        icon: RobotIcon,
        render: SuggestButton
    },

    contextMenus: {
        "channel-context": channelContextPatch,
        "gdm-context": channelContextPatch,
        "thread-context": channelContextPatch
    }
});
