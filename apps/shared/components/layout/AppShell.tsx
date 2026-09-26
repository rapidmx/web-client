///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "../../styles/app.css";
import React, { PropsWithChildren, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { IconType } from "react-icons";
import {
    HiOutlineCalendarDays,
    HiOutlineClipboardDocumentList,
    HiOutlineEnvelope,
    HiOutlinePuzzlePiece,
    HiOutlineUsers,
} from "react-icons/hi2";
import { useRouter } from "@rapidrest/react/client";
import { useRedirectIfUnauthenticated } from "@rapidmx/react-shared/auth/session.js";
import { getSetupStatus } from "@rapidmx/react-shared/admin/setupApi.js";
import { stopImpersonating } from "@rapidmx/react-shared/mail/mailApi.js";
import useBranding from "@rapidmx/react-shared/branding/useBranding.js";
import { useIdleKeyTimeout } from "@rapidmx/react-shared/crypto/useIdleKeyTimeout.js";
import ComposeProvider from "../mail/compose/ComposeContext.js";
import { flushComposeDrafts, markSigningOut } from "../mail/compose/composeFlushRegistry.js";
import BottomTabBar, { NavItem } from "@rapidmx/react-shared/components/navigation/BottomTabBar.js";
import { FrameBrandingFooter, FrameBrandingHeader, useBrandingHtml } from "./BrandingChrome.js";
import RailIcon from "./RailIcon.js";
import AppearanceProvider from "../../appearance/AppearanceProvider.js";
import { clearAppearanceCache } from "../../appearance/appearanceCache.js";
import type { Branding } from "@rapidmx/react-shared/branding/brandingApi.js";
import UserMenu from "./UserMenu.js";
import { UnlockPromptProvider } from "./UnlockPromptProvider.js";
import { SIGN_OUT_CHANNEL, destroyAllLocalIndexes } from "../../search/localIndexRpcClient.js";
import { authApiFetch, setApiUnauthorizedObserver } from "@rapidmx/react-shared/util/api.js";
import { destroyUnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { clearPinnedSignerCache } from "../mail/pinnedSigners.js";
import { mergePluginNavItems, PluginNav, PluginNavProps } from "../../plugins/pluginNav.js";
import { useInAppFrame } from "../../navigation/frameContext.js";
import { APP_HREFS } from "../../navigation/appHrefs.js";
import { useNavigate } from "../../navigation/index.js";
import { GlobalShortcuts } from "../../keyboard/GlobalShortcuts.js";
import { ShortcutProvider } from "../../keyboard/ShortcutProvider.js";
import ShortcutsDialog from "../../keyboard/ShortcutsDialog.js";
import { inboxUnreadTotal } from "../../mail/folderCounts.js";
import { MailConnectionContext, useMailConnection } from "../../mail/useMailConnection.js";
import { useUnreadTitle } from "../../mail/useUnreadTitle.js";
import UnlockBridge from "../../mail/outbox/UnlockBridge.js";
import NotificationCenter from "../../notifications/NotificationCenter.js";
import { useHeaderHeightRef } from "../../notifications/headerOffset.js";
import NotificationHistoryDialog from "../../notifications/NotificationHistoryDialog.js";
import { notifySessionExpired, setSignInUrl } from "../../notifications/apiErrors.js";
import { useUnseenErrorCount } from "../../notifications/useNotifications.js";
import { useSigningEnrollmentWatcher } from "../../signing/useSigningEnrollmentWatcher.js";
import { useCalendarReminders } from "../../calendar/useCalendarReminders.js";

/** How long sign-out waits for auth-server's logout before navigating anyway. */
export const LOGOUT_TIMEOUT_MS = 3_000;

/**
 * Calls auth-server's logout (`POST /api/auth/logout`, cross-origin with credentials), which clears the auth
 * cookie and invalidates the session's refresh token. Bounded by `LOGOUT_TIMEOUT_MS` and never rejects - a
 * failure (unreachable server, CORS) must not keep the user from leaving.
 */
async function logOutOfAuthServer(authServerUrl: string | undefined): Promise<void> {
    if (!authServerUrl) {
        return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGOUT_TIMEOUT_MS);
    try {
        await authApiFetch(authServerUrl, "/auth/logout", { method: "POST", signal: controller.signal });
    } catch {
        // Navigate anyway - see this function's doc comment.
    } finally {
        clearTimeout(timer);
    }
}

export type AppShellApp = "mail" | "calendar" | "contacts" | "tasks";

/** `"settings"` is a valid `active` value but deliberately has no entry in `APPS` below — Settings is
 * reached via a `UserMenu` item, not a 5th rail icon (see `SettingsShell.tsx`), so it highlights no
 * rail/tab icon at all; only the header title needs to account for it. Any other string is a plugin's
 * `appRail` item id (see `PluginNav`). */
export type AppShellActive = AppShellApp | "settings" | (string & {});

export interface AppShellProps extends PluginNavProps {
    /** Which icon in the rail is highlighted as the current app — `"settings"` highlights none, and a plugin
     * app page passes its own `appRail` item id. */
    active: AppShellActive;
    /** Populated automatically by the framework from an authenticated request (e.g. a valid `jwt` cookie). */
    userUid?: string;
    /** auth-server's base URL, injected via the route's `fetchProps`. */
    authServerUrl?: string;
    /**
     * `true` when this session is an admin "log in as user" impersonation (a `jwt_impersonator` cookie is
     * present) — see `MailShell`'s original doc comment, unchanged now that this lives here. Drives the
     * "you are viewing as this user — stop impersonating" banner below.
     */
    impersonating?: boolean;
    /** Where `mailApi.ts`'s `stopImpersonating()` should call — see `MailShell`'s original doc comment. */
    impersonationBaseUrl?: string;
    /** `true` when the caller's JWT carries a trusted role — shows an "Admin Console" item in the user menu below. A token
     * only carries one once elevated, so a real administrator with an ordinary session is `false` here; the user menu
     * asks auth-server about them separately (see `UserMenu`'s `detectAdmin`). */
    trusted?: boolean;
    /** The role names the server treats as trusted (its `trusted_roles` config, injected via the route's `fetchProps`) -
     * what that lookup looks for. Absent means the server's own default, `["admin"]`. */
    trustedRoles?: string[];
    /** The deployment's branding as the server rendered the page (its `branding` prop). Used until the frame's own fetch answers, so a custom header is there from the first paint - and the frame knows to drop its own title bar - instead of appearing (and moving everything) once the request returns. */
    branding?: Branding;
    /** The signed-in user's stored appearance preferences as the server rendered the page (its `appearance` prop), so the first paint already wears the theme and background - see `AppearanceProvider`. */
    appearance?: unknown;
}

export interface AppDef {
    id: AppShellApp;
    href: string;
    label: string;
    icon: IconType;
}

export const APPS: AppDef[] = [
    { id: "mail", href: APP_HREFS.mail, label: "Mail", icon: HiOutlineEnvelope },
    { id: "calendar", href: APP_HREFS.calendar, label: "Calendar", icon: HiOutlineCalendarDays },
    { id: "contacts", href: APP_HREFS.contacts, label: "Contacts", icon: HiOutlineUsers },
    { id: "tasks", href: APP_HREFS.tasks, label: "Tasks", icon: HiOutlineClipboardDocumentList },
];

/** Ids plugin `appRail` items can't take besides `APPS`' own - `"settings"` has no rail icon but is still a
 * core `active` value. */
const RESERVED_APP_IDS = ["settings"];

/** `APPS` followed by the plugins' `appRail` items (generic icon), core ids winning - see `mergePluginNavItems`. */
export function appRailItems(pluginNav?: PluginNav): NavItem[] {
    return mergePluginNavItems<NavItem>(
        APPS,
        pluginNav?.appRail,
        ({ id, href, label }) => ({ id, href, label, icon: HiOutlinePuzzlePiece }),
        RESERVED_APP_IDS,
    );
}

/** What only the persistent frame (`apps/www/_shell.tsx`) passes to the chrome it keeps mounted. */
export interface AppChromeProps extends AppShellProps {
    /** The router is loading the next page - the content is `aria-busy`. */
    busy?: boolean;
    /** A screen that takes over the window (`FrameTakeover`) is showing: the rail, header, banner and footer are hidden - not
     * unmounted, so what is inside them (and the page in the content region) keeps its state. */
    hideChrome?: boolean;
}

/**
 * The persistent chrome shared by every webmail app (Mail, Calendar, Contacts, Tasks): a left icon rail for
 * switching apps, a header with the current app's name and `UserMenu`, and the impersonation banner.
 * Each app's own shell (e.g. `MailShell`) renders its own contextual sidebar + content as `children`, inside
 * the area to the right of the icon rail and below the header.
 *
 * Rendered by the webmail's app shell (`apps/www/_shell.tsx`, the router's persistent client layout), once, for the life of the
 * page, so that moving between apps replaces only `children` - see `AppShell` below for what a page's own shell renders instead.
 */
export function AppChrome({
    active,
    userUid,
    authServerUrl,
    impersonating,
    impersonationBaseUrl,
    trusted,
    trustedRoles,
    branding: initialBranding,
    appearance,
    pluginNav,
    busy,
    hideChrome,
    children,
}: PropsWithChildren<AppChromeProps>) {
    const [stoppingImpersonation, setStoppingImpersonation] = useState(false);
    // The keyboard shortcuts dialog: opened by `?`/Ctrl+/ (`GlobalShortcuts`) and by the account menu's item.
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    // The pop-up history ("Recent notifications" in the account menu). The pop-ups themselves are drawn by `NotificationCenter`, below.
    const [historyOpen, setHistoryOpen] = useState(false);
    // Only the count is read, so the whole frame does not render again for every pop-up that comes and goes.
    const unseenErrors = useUnseenErrorCount();
    // The title bar's height for the pop-up stack, which sticks just below the header (a branding header publishes its own - `FrameBrandingHeader`).
    const headerRef = useHeaderHeightRef();
    const signingOutRef = useRef(false);
    const { branding: fetchedBranding, iconSrc: fetchedIconSrc } = useBranding();
    // The server's copy until the fetch answers, so the frame's shape (a custom header replaces the title bar) never changes after the first paint.
    const branding = fetchedBranding ?? initialBranding ?? null;
    const iconSrc = fetchedBranding ? fetchedIconSrc : initialBranding?.iconUrl || initialBranding?.logoUrl || fetchedIconSrc;
    // The custom header and footer, sanitized and with their `{USER_MENU}` / `{APP_TITLE}` placeholders (`undefined` until parsed, `null` when there is none).
    const header = useBrandingHtml(branding?.headerHtml);
    const footer = useBrandingHtml(branding?.footerHtml);
    // The mailboxes, their folders and the one push connection live here, in the frame that stays mounted as the router swaps pages - so
    // new-mail pop-ups, the folder counters and the tab title's unread count work in Calendar, Contacts, Tasks and Settings too, and moving
    // between apps never opens a second socket (the server allows ten per user). `MailShell` reads them from `MailConnectionContext`. Outside
    // the router (`AppShell` rendered as a page's own chrome: tests, plugin pages) it stays off, and a Mail shell owns its connection itself.
    const inFrame = useInAppFrame();
    const navigate = useNavigate();
    const { pathname } = useRouter();
    const mail = useMailConnection({ userUid, enabled: inFrame, open: navigate });
    // A signing certificate the user asked for is announced when it is issued (or fails), on whichever page they are - see the hook.
    useSigningEnrollmentWatcher({ userUid, mailboxes: mail.mailboxes, enabled: inFrame });
    // A meeting reminder pops up on whichever page they are - see the hook.
    useCalendarReminders({ userUid, enabled: inFrame });

    useRedirectIfUnauthenticated(userUid, authServerUrl);
    // Any request this app makes that the server answers with a 401 - the session ended - raises one "Your session expired" pop-up with a
    // Sign in action (see `notifySessionExpired()`), whichever request noticed first, a background refresh included.
    useEffect(() => {
        setSignInUrl(authServerUrl);
        if (!userUid) {
            return;
        }
        setApiUnauthorizedObserver(() => void notifySessionExpired());
        return () => setApiUnauthorizedObserver(undefined);
    }, [userUid, authServerUrl]);
    // Mounted here, not scoped to Mail/Settings (the only shells that actually read unlocked keys),
    // specifically so activity in *any* app resets the idle clock - see that hook's own doc comment.
    useIdleKeyTimeout();

    // An administrator on a server that hasn't finished first-run setup is sent to the setup wizard. The status
    // check is admin-only, so it's only made for a trusted caller - everyone else would just get a 403 on every
    // page load. Any failure is ignored.
    useEffect(() => {
        if (!userUid || impersonating || !trusted) {
            return;
        }
        getSetupStatus()
            .then((status) => {
                if (status.required) {
                    window.location.href = "/admin/setup";
                }
            })
            .catch(() => undefined);
    }, [userUid, impersonating, trusted]);

    // Another tab signing out (this app's `handleSignOut`, or the admin/escrow consoles' `signOutOfConsole()`)
    // ended this session too - its auth cookie is gone - so this tab destroys its own unlocked keys and every
    // local search index on the device, then leaves as well. The consoles have no local-index client of their
    // own, so this is what actually removes the indexes after a console sign-out (the console also records a
    // pending deletion, retried on the next mail load, in case no mail tab is open). `destroyAllLocalIndexes()`
    // announces the sign-out on this same channel, which this tab then hears itself, so the ref is set first:
    // each tab reacts once, and the tab that started the sign-out ignores its own announcement.
    useEffect(() => {
        if (!userUid || typeof BroadcastChannel === "undefined") {
            return;
        }
        const channel = new BroadcastChannel(SIGN_OUT_CHANNEL);
        channel.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
            if (event.data?.type !== "sign-out" || signingOutRef.current) {
                return;
            }
            signingOutRef.current = true;
            // Compose windows must not ask "Leave site?" - that would let this forced navigation be cancelled.
            markSigningOut();
            destroyUnlockedKeys();
            clearPinnedSignerCache();
            clearAppearanceCache();
            // Bounded by its own timeout and never rejects - awaited so navigating doesn't kill the Worker mid-delete.
            void destroyAllLocalIndexes().then(() => {
                window.location.href = authServerUrl ?? "/";
            });
        });
        return () => channel.close();
    }, [userUid, authServerUrl]);

    async function handleSignOut() {
        signingOutRef.current = true;
        // Before flushing and navigating: compose windows then skip their "Leave site?" prompt, which could
        // otherwise cancel the sign-out's own navigation.
        markSigningOut();
        // Unlocked private keys never outlive an explicit sign-out.
        destroyUnlockedKeys();
        // Trusted signer pins read from contacts don't outlive the session either.
        clearPinnedSignerCache();
        clearAppearanceCache();
        // Open compose windows save edits still waiting on their autosave debounce while the session is still
        // valid - logout invalidates it. Bounded the same way as logout itself, and never rejects.
        await flushComposeDrafts(LOGOUT_TIMEOUT_MS);
        // The Tier 2 local index MUST be destroyed on explicit logout, the same as unlocked keys themselves
        // (spec §11). Destroys every index on this device (not only mailboxes opened this page load) and is
        // awaited before navigating - a navigation tears down the Worker mid-delete otherwise.
        // destroyAllLocalIndexes() is bounded by its own timeout and never rejects, so sign-out can't hang.
        // In parallel, auth-server's logout clears the auth cookie and invalidates the session's refresh
        // token - without it, "Sign Out" would only navigate away from a still-valid session.
        await Promise.all([destroyAllLocalIndexes(), logOutOfAuthServer(authServerUrl)]);
        window.location.href = authServerUrl ?? "/";
    }

    async function handleStopImpersonating() {
        setStoppingImpersonation(true);
        try {
            await stopImpersonating(impersonationBaseUrl ?? "");
        } catch {
            // Navigate either way: a failed call leaves the impersonator cookie (and this banner) exactly as
            // they were, so there's nothing else useful to show — matching this app's other network-error
            // handling, which surfaces via a full reload rather than an inline retry affordance.
        } finally {
            window.location.href = "/admin";
        }
    }

    // The tab's title in the frame is each page's own (its `title` export: rendered by the server, set again by the router on every navigation),
    // but `useBranding()` above sets it to the branding's title once its fetch answers - a title for a page that has none. The page's is put back:
    // the layout effect reads it before that hook's effect runs, this one (declared after it) writes it back.
    const pageTitleRef = useRef("");
    useLayoutEffect(() => {
        pageTitleRef.current = document.title;
    }, [fetchedBranding?.title]);
    useEffect(() => {
        if (inFrame) {
            document.title = pageTitleRef.current;
        }
    }, [fetchedBranding?.title, inFrame]);
    // The router sets the document's title to the page's own whenever the page changes, which drops the unread count this puts in front
    // of it, so a new pathname is what puts the count back. (A folder change is shallow and keeps the title.)
    useUnreadTitle(inboxUnreadTotal(mail.mailboxFolders, mail.folderCounts.counts), { enabled: inFrame, resetKey: pathname });

    if (!userUid) {
        return <div className="min-h-screen" />;
    }

    const apps = appRailItems(pluginNav);
    // The header title: "settings" has no rail item, everything else is labelled by its own rail item.
    const activeLabel = active === "settings" ? "Settings" : apps.find((app) => app.id === active)?.label;
    // A custom header (`Branding.headerHtml`) replaces the app's own title bar and the icon at the top of the rail: it is the top of the app, and the
    // account menu moves into it. While it is still being parsed it already counts, so the frame's shape doesn't change under the user.
    const customHeader = header !== null;
    // Where the one account menu lives: the header's `{USER_MENU}`, else the footer's, else a small cell at the header's right end - never lost.
    const menuInHeader = !!header?.hasUserMenu;
    const menuInFooter = customHeader && !!header && !menuInHeader && !!footer?.hasUserMenu;
    const renderUserMenu = (placement: "down" | "up") => (
        <UserMenu
            userUid={userUid}
            authServerUrl={authServerUrl}
            onSignOut={handleSignOut}
            // An impersonating administrator acts as the impersonated user, so the console link is hidden then.
            showAdminLink={!!trusted && !impersonating}
            detectAdmin={!trusted && !impersonating}
            trustedRoles={trustedRoles}
            showSettingsLink
            showNotificationSettings
            onShowShortcuts={() => setShortcutsOpen(true)}
            onShowNotifications={() => setHistoryOpen(true)}
            unseenErrors={unseenErrors}
            placement={placement}
        />
    );

    return (
        // Mounted here, not scoped to Mail/Settings, for the same reason as useIdleKeyTimeout() above -
        // ComposeWindow's sign/encrypt toggles and MessageDetailPane's encrypted-message view (both Mail)
        // are today's only useUnlockPrompt() callers, but this needs to be available to any app shell.
        // Asks the server for the user's appearance only in the persistent frame (every core page); a page that renders its own chrome (a plugin's) uses the
        // `appearance` it was given and what this browser cached.
        <AppearanceProvider userUid={userUid} initial={appearance} lookUp={inFrame}>
        <ShortcutProvider>
        <MailConnectionContext.Provider value={inFrame ? mail : null}>
        <GlobalShortcuts authServerUrl={authServerUrl} onToggleHelp={() => setShortcutsOpen((open) => !open)} />
        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <UnlockPromptProvider>
            <UnlockBridge />
            {/* An impersonating admin acts with the impersonated user's access, so their own trusted role
                mustn't skip the per-mailbox checks. */}
            <ComposeProvider userUid={userUid} trusted={!!trusted && !impersonating}>
            <div className="rr-frame-bg min-h-screen flex flex-col">
                {!hideChrome && customHeader && (
                    <FrameBrandingHeader
                        parsed={header}
                        userMenu={menuInHeader ? renderUserMenu("down") : undefined}
                        fallbackMenu={header && !menuInHeader && !menuInFooter ? renderUserMenu("down") : undefined}
                        appTitle={activeLabel}
                    />
                )}
                {impersonating && !hideChrome && (
                    <div className="h-10 shrink-0 bg-warning text-warning-contrast flex items-center justify-center gap-3 text-sm font-medium px-4">
                        <span>
                            You are viewing as <strong>{userUid}</strong>.
                        </span>
                        <button
                            type="button"
                            onClick={handleStopImpersonating}
                            disabled={stoppingImpersonation}
                            className="underline hover:no-underline disabled:opacity-60"
                        >
                            {stoppingImpersonation ? "Returning to admin…" : "Return to admin"}
                        </button>
                    </div>
                )}
                <div className="flex-1 flex min-h-0">
                    {!hideChrome && (
                    <nav
                        aria-label="Apps"
                        className={[
                            "hidden md:flex w-16 shrink-0 bg-surface border-r border-border flex-col items-center gap-1",
                            // Under a custom header the rail starts with the app icons; without one its own icon is flush with the top of the window.
                            customHeader ? "py-3" : "pb-3",
                        ].join(" ")}
                    >
                        {!customHeader && (
                            <RailIcon src={iconSrc} />
                        )}
                        {apps.map(({ id, href, label, icon: Icon }) => (
                            <a
                                key={id}
                                href={href}
                                aria-label={label}
                                aria-current={id === active ? "page" : undefined}
                                title={label}
                                className={[
                                    "w-10 h-10 flex items-center justify-center rounded-sm",
                                    id === active
                                        ? "bg-primary/10 text-primary-dark"
                                        : "text-text-muted hover:bg-surface-alt hover:text-text",
                                ].join(" ")}
                            >
                                <Icon size={20} aria-hidden="true" />
                            </a>
                        ))}
                    </nav>
                    )}
                    {!hideChrome && <BottomTabBar apps={apps} active={active} />}
                    <div className="flex-1 flex flex-col min-w-0">
                        {!hideChrome && !customHeader && (
                        <header ref={headerRef} className="rr-solid sticky top-0 z-30 h-16 shrink-0 bg-surface border-b border-border flex items-center justify-between gap-4 px-6">
                            <span className="font-display font-bold text-lg uppercase tracking-wide">{activeLabel}</span>
                            {renderUserMenu("down")}
                        </header>
                        )}
                        {/* The one pop-up stack for the whole app: right under the header row, so it never covers the account menu. */}
                        <NotificationCenter />
                        <div
                            id="app-content"
                            tabIndex={-1}
                            aria-busy={busy || undefined}
                            className={["flex-1 flex min-h-0 outline-none", hideChrome ? "" : "pb-14 md:pb-0"].join(" ")}
                        >
                            {children}
                        </div>
                    </div>
                </div>
                {!hideChrome && <FrameBrandingFooter parsed={footer} userMenu={menuInFooter ? renderUserMenu("up") : undefined} appTitle={activeLabel} />}
            </div>
            </ComposeProvider>
        </UnlockPromptProvider>
        <NotificationHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
        </MailConnectionContext.Provider>
        </ShortcutProvider>
        </AppearanceProvider>
    );
}

/**
 * What a page's own shell (`MailShell`, `CalendarShell`, ...) renders around its content. Outside the client-side router it
 * is the whole `AppChrome`, as it always was. Inside it (the router's app shell, `apps/www/_shell.tsx`) the chrome is already mounted above the
 * page - and stays mounted as the page is replaced - so this is only its children; everything it would have been given comes from
 * the shell instead (the props are the same for every page, and `active` is the route's).
 */
export default function AppShell(props: PropsWithChildren<AppShellProps>) {
    const inFrame = useInAppFrame();
    return inFrame ? <>{props.children}</> : <AppChrome {...props} />;
}
