// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { ComponentType, useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppRouter, { NavigateFn, useLocation, useLocationSearch, useNavigate } from "../../../apps/shared/navigation/AppRouter.js";
import { FrameTakeover } from "../../../apps/shared/navigation/frameContext.js";
import type { RouteDefinition } from "../../../apps/shared/navigation/routes.js";

// The chrome itself (the rail, header, compose windows...) is AppShell's own test's business: here it is a stand-in that records
// how often it mounts and what it was given, so that "one chrome for the life of the page" can be asserted.
const chrome = vi.hoisted(() => ({ mounts: 0, props: [] as any[] }));
vi.mock("../../../apps/shared/components/layout/AppShell.js", async () => {
    const react = await import("react");
    return {
        AppChrome: (props: any) => {
            react.useEffect(() => {
                chrome.mounts++;
            }, []);
            chrome.props.push(props);
            return react.createElement(
                "div",
                { "data-testid": "chrome", "data-active": props.active, "data-hidden": String(!!props.hideChrome), "aria-busy": props.busy || undefined },
                props.children,
            );
        },
    };
});

const idle = vi.hoisted(() => ({ whenIdle: vi.fn(), shouldSaveData: vi.fn() }));
vi.mock("../../../apps/shared/navigation/idle.js", () => idle);

const lastChromeProps = () => chrome.props[chrome.props.length - 1];

/** A stand-in for what `routedPage()` returns: the module's default export, carrying the plain page as `.page`. */
function routed(Page: ComponentType<any>): { default: ComponentType<any> } {
    return { default: Object.assign(() => null, { page: Page }) };
}

const pageMounts: Record<string, number> = {};
let navigate: NavigateFn;

function Location() {
    const location = useLocation();
    return <output data-testid="location">{JSON.stringify(location)}</output>;
}

/** A page that counts its mounts, shows its params and location, hands the test the router's `navigate`, and links to everything. */
function makePage(name: string) {
    return function Page(props: any) {
        navigate = useNavigate();
        useEffect(() => {
            pageMounts[name] = (pageMounts[name] ?? 0) + 1;
        }, []);
        return (
            <div data-testid={`page-${name}`} data-params={JSON.stringify(props.params ?? {})} data-user={props.userUid}>
                <Location />
                <a href="/items/7">item</a>
                <a href="/other?x=1#h">other</a>
                <a href="/admin">admin</a>
                <a href="https://elsewhere.example.com/x">external</a>
                <a href="#section">hash</a>
                <a href="/other" target="_blank">blank</a>
                <a href="/other" target="_self">self</a>
                <a href="/other" download>download</a>
                <a href="/other" data-full-reload>reload</a>
                <a href="/broken">broken</a>
                <a href="/plain">plain</a>
                <a href="/">
                    <span>home child</span>
                </a>
            </div>
        );
    };
}

const otherLoad = vi.fn(() => Promise.resolve(routed(makePage("other"))));
const homeLoad = vi.fn(() => Promise.resolve(routed(makePage("home"))));
const itemLoad = vi.fn(() => Promise.resolve(routed(makePage("item"))));
const routes: RouteDefinition[] = [
    { path: "/", active: "mail", load: homeLoad, idlePrefetch: true },
    { path: "/items/:uid", active: "mail", load: itemLoad },
    { path: "/other", active: "calendar", load: otherLoad, idlePrefetch: true },
    { path: "/broken", active: "tasks", load: () => Promise.reject(new Error("chunk failed")) },
    { path: "/plain", active: "settings", load: () => Promise.resolve({ default: () => null }) },
];

const PROPS = { userUid: "u1", authServerUrl: "https://auth.example.com", impersonating: false, trusted: true, trustedRoles: ["admin"], pluginNav: undefined, params: {} };

function renderRouter(props: Record<string, any> = PROPS, initialPath = "/") {
    return render(<AppRouter routes={routes} initialPath={initialPath} initialPage={makePage(initialPath === "/" ? "home" : "item")} pageProps={props} />);
}

/**
 * Replaces `window.location` with one that reads the real (history-driven) address but records navigations instead of
 * performing them - jsdom cannot navigate.
 */
function spyLocation() {
    const real = window.location;
    const hrefs: string[] = [];
    const replace = vi.fn();
    const reload = vi.fn();
    const fake = {
        get href() {
            return real.href;
        },
        set href(value: string) {
            hrefs.push(String(value));
        },
        get origin() {
            return real.origin;
        },
        get pathname() {
            return real.pathname;
        },
        get search() {
            return real.search;
        },
        get hash() {
            return real.hash;
        },
        replace,
        reload,
    };
    Object.defineProperty(window, "location", { configurable: true, value: fake });
    return { hrefs, replace, reload, restore: () => Object.defineProperty(window, "location", { configurable: true, value: real }) };
}

let location: ReturnType<typeof spyLocation>;
/** What happened to the default action of each click that reached the window: `true` when the router took it over. */
let clickPrevented: boolean[];
const recordClick = (event: Event) => {
    clickPrevented.push(event.defaultPrevented);
    // Nothing must really navigate (jsdom would log "not implemented").
    event.preventDefault();
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    chrome.mounts = 0;
    chrome.props = [];
    for (const key of Object.keys(pageMounts)) {
        delete pageMounts[key];
    }
    clickPrevented = [];
    window.history.replaceState(null, "", "/");
    location = spyLocation();
    window.addEventListener("click", recordClick);
    idle.whenIdle.mockImplementation(() => () => undefined);
    idle.shouldSaveData.mockReturnValue(false);
});

afterEach(() => {
    window.removeEventListener("click", recordClick);
    location.restore();
    otherLoad.mockClear();
    homeLoad.mockClear();
    itemLoad.mockClear();
});

describe("AppRouter", () => {
    it("renders the page it was rendered for inside one chrome, with the props the server gave it", () => {
        renderRouter();
        expect(screen.getByTestId("chrome")).toContainElement(screen.getByTestId("page-home"));
        expect(screen.getByTestId("page-home")).toHaveAttribute("data-user", "u1");
        expect(lastChromeProps()).toMatchObject({
            active: "mail",
            userUid: "u1",
            authServerUrl: "https://auth.example.com",
            trusted: true,
            trustedRoles: ["admin"],
            routeKey: "initial",
            busy: false,
            hideChrome: false,
        });
    });

    it("takes the highlighted app from the route table, and falls back to mail for a route that isn't in it", () => {
        render(<AppRouter routes={routes} initialPath="/unlisted" initialPage={makePage("home")} pageProps={PROPS} />);
        expect(lastChromeProps().active).toBe("mail");
    });

    it("gives the page the params the server rendered it with", () => {
        renderRouter({ ...PROPS, params: { uid: "abc" } });
        expect(screen.getByTestId("page-home")).toHaveAttribute("data-params", JSON.stringify({ uid: "abc" }));
    });

    it("copes with a page rendered without params", () => {
        renderRouter({ userUid: "u1" });
        expect(screen.getByTestId("page-home")).toHaveAttribute("data-params", "{}");
    });

    it("reads the browser's location after the first render and offers it through useLocation", async () => {
        window.history.replaceState(null, "", "/?mailboxUid=m1#top");
        renderRouter();
        await waitFor(() =>
            expect(JSON.parse(screen.getByTestId("location").textContent)).toEqual({ pathname: "/", search: "?mailboxUid=m1", hash: "#top" }),
        );
    });

    describe("links", () => {
        it("takes over a click on a link to another page of the app: no page load, the URL changes, the page is swapped inside the same chrome", async () => {
            renderRouter();
            fireEvent.click(screen.getByText("other"));
            await screen.findByTestId("page-other");
            expect(clickPrevented).toEqual([true]);
            expect(window.location.pathname + window.location.search + window.location.hash).toBe("/other?x=1#h");
            expect(screen.queryByTestId("page-home")).not.toBeInTheDocument();
            expect(lastChromeProps()).toMatchObject({ active: "calendar", routeKey: "/other", busy: false });
            expect(chrome.mounts).toBe(1);
            expect(location.hrefs).toEqual([]);
            expect(JSON.parse(screen.getByTestId("location").textContent)).toEqual({ pathname: "/other", search: "?x=1", hash: "#h" });
        });

        it("finds the link when the click lands on something inside it", async () => {
            renderRouter();
            fireEvent.click(screen.getByText("item"));
            await screen.findByTestId("page-item");
            fireEvent.click(screen.getByText("home child").closest("a")!.querySelector("span")!);
            await screen.findByTestId("page-home");
            expect(window.location.pathname).toBe("/");
        });

        it("gives the page the params of a parameterized route", async () => {
            renderRouter();
            fireEvent.click(screen.getByText("item"));
            await screen.findByTestId("page-item");
            expect(screen.getByTestId("page-item")).toHaveAttribute("data-params", JSON.stringify({ uid: "7" }));
        });

        it("leaves alone every click the browser must handle itself", async () => {
            renderRouter();
            const others = screen.getAllByText("other");
            const untouched: [string, () => void][] = [
                ["a modified click (ctrl)", () => fireEvent.click(others[0], { ctrlKey: true })],
                ["a modified click (meta)", () => fireEvent.click(others[0], { metaKey: true })],
                ["a modified click (shift)", () => fireEvent.click(others[0], { shiftKey: true })],
                ["a modified click (alt)", () => fireEvent.click(others[0], { altKey: true })],
                ["a middle click", () => fireEvent.click(others[0], { button: 1 })],
                ["a link with a target", () => fireEvent.click(screen.getByText("blank"))],
                ["a download", () => fireEvent.click(screen.getByText("download"))],
                ["a link marked for a full reload", () => fireEvent.click(screen.getByText("reload"))],
                ["a link to another origin", () => fireEvent.click(screen.getByText("external"))],
                ["a link to a page that is not in the route table", () => fireEvent.click(screen.getByText("admin"))],
                ["a link within the page (#hash)", () => fireEvent.click(screen.getByText("hash"))],
                ["a click that is not on a link", () => fireEvent.click(screen.getByTestId("page-home"))],
            ];
            for (const [, click] of untouched) {
                click();
            }
            expect(clickPrevented).toEqual(untouched.map(() => false));
            expect(window.location.pathname).toBe("/");
            expect(screen.getByTestId("page-home")).toBeInTheDocument();
        });

        it("takes a link whose target is _self", async () => {
            renderRouter();
            fireEvent.click(screen.getByText("self"));
            await screen.findByTestId("page-other");
            expect(clickPrevented).toEqual([true]);
        });

        it("leaves a click that something else already handled (default prevented)", () => {
            renderRouter();
            const link = screen.getByText("item");
            link.addEventListener("click", (event) => event.preventDefault());
            fireEvent.click(link);
            expect(screen.getByTestId("page-home")).toBeInTheDocument();
            expect(window.location.pathname).toBe("/");
        });

        it("ignores a click on something that is not an element", () => {
            renderRouter();
            document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(screen.getByTestId("page-home")).toBeInTheDocument();
        });

        it("goes to a page that cannot be loaded, or is not a routed page, by a normal navigation", async () => {
            renderRouter();
            fireEvent.click(screen.getByText("broken"));
            await waitFor(() => expect(location.hrefs).toEqual(["http://localhost:3000/broken"]));
            expect(window.location.pathname).toBe("/");
            fireEvent.click(screen.getByText("plain"));
            await waitFor(() => expect(location.hrefs).toHaveLength(2));
            expect(location.hrefs[1]).toBe("http://localhost:3000/plain");
            expect(screen.getByTestId("page-home")).toBeInTheDocument();
        });
    });

    describe("navigate()", () => {
        it("changes only the query string without remounting the page (a folder change)", async () => {
            renderRouter();
            act(() => navigate("/?mailboxUid=m&folderUid=f"));
            await waitFor(() => expect(JSON.parse(screen.getByTestId("location").textContent).search).toBe("?mailboxUid=m&folderUid=f"));
            expect(window.location.search).toBe("?mailboxUid=m&folderUid=f");
            expect(pageMounts.home).toBe(1);
            expect(lastChromeProps().routeKey).toBe("initial");
        });

        it("remounts the page for another path, even of the same route, and keeps one chrome", async () => {
            renderRouter();
            act(() => navigate("/items/1"));
            await screen.findByTestId("page-item");
            act(() => navigate("/items/2"));
            await waitFor(() => expect(screen.getByTestId("page-item")).toHaveAttribute("data-params", JSON.stringify({ uid: "2" })));
            expect(pageMounts.item).toBe(2);
            expect(itemLoad).toHaveBeenCalledTimes(1);
            expect(chrome.mounts).toBe(1);
        });

        it("pushes a history entry by default and replaces the current one on request", async () => {
            renderRouter();
            const before = window.history.length;
            act(() => navigate("/other"));
            await screen.findByTestId("page-other");
            expect(window.history.length).toBe(before + 1);
            act(() => navigate("/items/3", { replace: true }));
            await screen.findByTestId("page-item");
            expect(window.history.length).toBe(before + 1);
            expect(window.location.pathname).toBe("/items/3");
        });

        it("does nothing for the address already showing", async () => {
            renderRouter();
            const before = window.history.length;
            act(() => navigate("/"));
            expect(window.history.length).toBe(before);
            expect(homeLoad).not.toHaveBeenCalled();
            expect(lastChromeProps().busy).toBe(false);
        });

        it("goes to another origin, or a page that is not in the route table, by a normal navigation", () => {
            renderRouter();
            navigate("https://elsewhere.example.com/x");
            navigate("/admin");
            expect(location.hrefs).toEqual(["https://elsewhere.example.com/x", "http://localhost:3000/admin"]);
            navigate("/admin", { replace: true });
            expect(location.replace).toHaveBeenCalledWith("http://localhost:3000/admin");
        });

        it("marks the frame busy while the next page's code loads, and keeps the current page until then", async () => {
            const pending = deferred<{ default: ComponentType<any> }>();
            const slow: RouteDefinition[] = [routes[0], { path: "/slow", active: "tasks", load: () => pending.promise }];
            render(<AppRouter routes={slow} initialPath="/" initialPage={makePage("home")} pageProps={PROPS} />);
            act(() => navigate("/slow"));
            await waitFor(() => expect(screen.getByTestId("chrome")).toHaveAttribute("aria-busy", "true"));
            expect(screen.getByTestId("page-home")).toBeInTheDocument();
            expect(window.location.pathname).toBe("/");
            await act(async () => pending.resolve(routed(makePage("slow"))));
            await screen.findByTestId("page-slow");
            expect(window.location.pathname).toBe("/slow");
            expect(screen.getByTestId("chrome")).not.toHaveAttribute("aria-busy");
        });

        it("lets a newer navigation overtake one that is still loading", async () => {
            const first = deferred<{ default: ComponentType<any> }>();
            const overtaken: RouteDefinition[] = [routes[0], { path: "/first", active: "tasks", load: () => first.promise }, routes[2]];
            render(<AppRouter routes={overtaken} initialPath="/" initialPage={makePage("home")} pageProps={PROPS} />);
            act(() => navigate("/first"));
            act(() => navigate("/other"));
            await screen.findByTestId("page-other");
            await act(async () => first.resolve(routed(makePage("first"))));
            expect(screen.queryByTestId("page-first")).not.toBeInTheDocument();
            expect(window.location.pathname).toBe("/other");
            expect(screen.getByTestId("chrome")).not.toHaveAttribute("aria-busy");
        });

        it("keeps the page it has and hands over to a normal navigation when the next page's code fails to load", async () => {
            renderRouter();
            act(() => navigate("/broken"));
            await waitFor(() => expect(location.hrefs).toEqual(["http://localhost:3000/broken"]));
            expect(screen.getByTestId("page-home")).toBeInTheDocument();
            await waitFor(() => expect(screen.getByTestId("chrome")).not.toHaveAttribute("aria-busy"));
        });
    });

    describe("back and forward", () => {
        it("shows the page of the entry the browser went back to, without a page load", async () => {
            renderRouter();
            act(() => navigate("/other"));
            await screen.findByTestId("page-other");
            act(() => {
                window.history.replaceState(null, "", "/");
                window.dispatchEvent(new PopStateEvent("popstate"));
            });
            await screen.findByTestId("page-home");
            expect(lastChromeProps().active).toBe("mail");
            expect(location.reload).not.toHaveBeenCalled();
        });

        it("updates only the location when the entry is another folder of the same page", async () => {
            renderRouter();
            act(() => navigate("/?folderUid=a"));
            await waitFor(() => expect(JSON.parse(screen.getByTestId("location").textContent).search).toBe("?folderUid=a"));
            act(() => {
                window.history.replaceState(null, "", "/?folderUid=b");
                window.dispatchEvent(new PopStateEvent("popstate"));
            });
            await waitFor(() => expect(JSON.parse(screen.getByTestId("location").textContent).search).toBe("?folderUid=b"));
            expect(pageMounts.home).toBe(1);
        });

        it("reloads when the entry is not a page the router knows", () => {
            renderRouter();
            act(() => {
                window.history.replaceState(null, "", "/nowhere");
                window.dispatchEvent(new PopStateEvent("popstate"));
            });
            expect(location.reload).toHaveBeenCalledTimes(1);
        });

        it("reloads when the entry's page cannot be loaded", async () => {
            renderRouter();
            act(() => {
                window.history.replaceState(null, "", "/broken");
                window.dispatchEvent(new PopStateEvent("popstate"));
            });
            await waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1));
        });

        it("lets a later back or forward overtake one still loading", async () => {
            const slow = deferred<{ default: ComponentType<any> }>();
            const list: RouteDefinition[] = [routes[0], { path: "/slow", active: "tasks", load: () => slow.promise }];
            render(<AppRouter routes={list} initialPath="/" initialPage={makePage("home")} pageProps={PROPS} />);
            act(() => {
                window.history.replaceState(null, "", "/slow");
                window.dispatchEvent(new PopStateEvent("popstate"));
            });
            act(() => {
                window.history.replaceState(null, "", "/");
                window.dispatchEvent(new PopStateEvent("popstate"));
            });
            await act(async () => slow.resolve(routed(makePage("slow"))));
            expect(screen.queryByTestId("page-slow")).not.toBeInTheDocument();
            expect(screen.getByTestId("page-home")).toBeInTheDocument();
        });
    });

    describe("prefetching", () => {
        it("loads a page's code when the pointer, the keyboard or a press reaches a link to it", () => {
            renderRouter();
            fireEvent.pointerOver(screen.getByText("other"));
            expect(otherLoad).toHaveBeenCalledTimes(1);
            fireEvent.focusIn(screen.getByText("item"));
            expect(itemLoad).toHaveBeenCalledTimes(1);
            fireEvent.pointerDown(screen.getByText("item"));
            // Loaded once: later touches find it.
            expect(itemLoad).toHaveBeenCalledTimes(1);
        });

        it("does not load anything for a link the router would not take, or for something that is not a link", () => {
            renderRouter();
            fireEvent.pointerOver(screen.getByText("admin"));
            fireEvent.pointerOver(screen.getByText("external"));
            fireEvent.pointerOver(screen.getByTestId("page-home"));
            expect(otherLoad).not.toHaveBeenCalled();
            expect(itemLoad).not.toHaveBeenCalled();
        });

        it("tries again to load a page whose code failed to load", async () => {
            const attempts = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(routed(makePage("flaky")));
            const flaky: RouteDefinition[] = [routes[0], { path: "/flaky", active: "tasks", load: attempts }];
            render(<AppRouter routes={flaky} initialPath="/" initialPage={makePage("home")} pageProps={PROPS} />);
            act(() => navigate("/flaky"));
            await waitFor(() => expect(location.hrefs).toEqual(["http://localhost:3000/flaky"]));
            act(() => navigate("/flaky"));
            await screen.findByTestId("page-flaky");
            expect(attempts).toHaveBeenCalledTimes(2);
        });

        it("ignores a page whose code fails to load", async () => {
            renderRouter();
            fireEvent.pointerOver(screen.getByText("broken"));
            await act(async () => undefined);
            expect(screen.getByTestId("page-home")).toBeInTheDocument();
        });

        it("loads the pages marked for it when the browser is idle", async () => {
            idle.whenIdle.mockImplementation((callback: () => void) => {
                callback();
                return () => undefined;
            });
            renderRouter();
            await waitFor(() => expect(otherLoad).toHaveBeenCalledTimes(1));
            // "/" is the page on screen, already loaded.
            expect(homeLoad).not.toHaveBeenCalled();
        });

        it("loads the idle pages that are not on screen even if one fails", async () => {
            idle.whenIdle.mockImplementation((callback: () => void) => {
                callback();
                return () => undefined;
            });
            const failing: RouteDefinition[] = [routes[0], { path: "/x", active: "tasks", load: () => Promise.reject(new Error("no")), idlePrefetch: true }];
            render(<AppRouter routes={failing} initialPath="/" initialPage={makePage("home")} pageProps={PROPS} />);
            await act(async () => undefined);
            expect(screen.getByTestId("page-home")).toBeInTheDocument();
        });

        it("does not speculate when the user asked to save data", () => {
            idle.shouldSaveData.mockReturnValue(true);
            renderRouter();
            expect(idle.whenIdle).not.toHaveBeenCalled();
        });

        it("cancels the idle work when the router goes away", () => {
            const cancel = vi.fn();
            idle.whenIdle.mockImplementation(() => cancel);
            const { unmount } = renderRouter();
            expect(idle.whenIdle).toHaveBeenCalled();
            unmount();
            expect(cancel).toHaveBeenCalled();
        });
    });

    describe("the frame", () => {
        it("hides the chrome while a screen that takes over the window is showing, and shows it again after", async () => {
            let setShown!: (shown: boolean) => void;
            function Takeover() {
                const [shown, set] = React.useState(false);
                setShown = set;
                return shown ? <FrameTakeover>takeover screen</FrameTakeover> : null;
            }
            render(
                <AppRouter routes={routes} initialPath="/" initialPage={() => <Takeover />} pageProps={PROPS} />,
            );
            expect(screen.getByTestId("chrome")).toHaveAttribute("data-hidden", "false");
            act(() => setShown(true));
            expect(screen.getByTestId("chrome")).toHaveAttribute("data-hidden", "true");
            act(() => setShown(false));
            expect(screen.getByTestId("chrome")).toHaveAttribute("data-hidden", "false");
        });
    });
});

describe("useLocation / useLocationSearch / useNavigate outside the router", () => {
    it("read the browser's location after mounting", async () => {
        window.history.replaceState(null, "", "/somewhere?x=1#y");
        function Probe() {
            const current = useLocation();
            const search = useLocationSearch();
            return (
                <p data-testid="probe">
                    {JSON.stringify(current)} {search}
                </p>
            );
        }
        render(<Probe />);
        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent(JSON.stringify({ pathname: "/somewhere", search: "?x=1", hash: "#y" }) + " ?x=1"));
    });

    it("navigates the way assigning window.location.href always did, and replaces on request", () => {
        function Probe() {
            const go = useNavigate();
            return (
                <>
                    <button onClick={() => go("/calendar")}>go</button>
                    <button onClick={() => go("/calendar", { replace: true })}>replace</button>
                </>
            );
        }
        render(<Probe />);
        fireEvent.click(screen.getByText("go"));
        expect(location.hrefs).toEqual(["/calendar"]);
        fireEvent.click(screen.getByText("replace"));
        expect(location.replace).toHaveBeenCalledWith("/calendar");
    });
});
