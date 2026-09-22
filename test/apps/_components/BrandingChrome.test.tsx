// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    APP_TITLE_VARIABLE,
    BrandingFooter,
    BrandingHeader,
    FrameBrandingFooter,
    FrameBrandingHeader,
    SLOT_ATTRIBUTE,
    USER_MENU_VARIABLE,
    parseBrandingHtml,
    sanitizeBrandingHtml,
    useBrandingHtml,
} from "../../../apps/shared/components/layout/BrandingChrome.js";

/** Renders a header for `html` the way the frame does: parse in a layout effect, then the slots. */
function Header({ html, menu = true, fallback, title = "Mail" }: { html?: string; menu?: boolean; fallback?: boolean; title?: string }) {
    const parsed = useBrandingHtml(html);
    return (
        <FrameBrandingHeader
            parsed={parsed}
            userMenu={menu ? <button type="button">Account menu</button> : undefined}
            fallbackMenu={fallback ? <button type="button">Fallback menu</button> : undefined}
            appTitle={title}
        />
    );
}

function Footer({ html, menu, title = "Mail" }: { html?: string; menu?: boolean; title?: string }) {
    const parsed = useBrandingHtml(html);
    return <FrameBrandingFooter parsed={parsed} userMenu={menu ? <button type="button">Footer menu</button> : undefined} appTitle={title} />;
}

const slots = (container: HTMLElement, name: string) => container.querySelectorAll(`[${SLOT_ATTRIBUTE}="${name}"]`);

describe("sanitizeBrandingHtml", () => {
    it("drops form controls' actions and keeps ordinary markup", () => {
        expect(sanitizeBrandingHtml('<a href="https://x.example" formaction="https://evil.example">x</a>')).toBe('<a href="https://x.example">x</a>');
    });
});

describe("useBrandingHtml / the header and footer", () => {
    it("render nothing without HTML, without configured HTML, or when it sanitizes down to nothing", () => {
        expect(render(<Header />).container.innerHTML).toBe("");
        expect(render(<Header html="   " />).container.innerHTML).toBe("");
        expect(render(<Header html="<script>alert(1)</script>" />).container.innerHTML).toBe("");
        expect(render(<Footer />).container.innerHTML).toBe("");
        expect(render(<Footer html="<style>x{}</style>" />).container.innerHTML).toBe("");
    });

    it("strips scripts, event handlers, javascript: URLs, forms, and iframes but keeps ordinary markup", () => {
        const { container } = render(
            <Header
                html={
                    '<p data-testid="ok" class="banner"><b>Acme</b> <a href="https://acme.example">home</a></p>' +
                    '<img src="x.png" onerror="alert(1)">' +
                    '<a href="javascript:alert(1)">bad</a>' +
                    '<form action="https://evil.example"><input name="password"><button>Go</button></form>' +
                    '<iframe src="https://evil.example"></iframe>' +
                    "<style>body{display:none}</style>" +
                    "<script>alert(1)</script>"
                }
            />,
        );
        const html = container.innerHTML;
        expect(html).toContain("<b>Acme</b>");
        expect(html).toContain('href="https://acme.example"');
        expect(html).not.toContain("onerror");
        expect(html).not.toContain("javascript:");
        expect(html).not.toContain("<form");
        expect(html).not.toContain("<input");
        expect(html).not.toContain("<button>Go");
        expect(html).not.toContain("<iframe");
        expect(html).not.toContain("<style");
        expect(html).not.toContain("<script");
    });

    it("sanitizes the footer too", () => {
        const { container } = render(<Footer html='<span onclick="alert(1)">Acme footer</span>' />);
        expect(container.innerHTML).toBe("<div><span>Acme footer</span></div>");
    });

    it("wraps the header in a sticky banner landmark", () => {
        const { container } = render(<Header html="<p>Acme</p>" />);
        const header = container.querySelector("header")!;
        expect(header).toHaveClass("sticky", "top-0");
        expect(header).toHaveAttribute("data-branding-header");
    });

    it("re-parses when the HTML changes, and shows nothing again when it goes", () => {
        const { container, rerender } = render(<Header html="<p>One</p>" />);
        expect(container).toHaveTextContent("One");
        rerender(<Header html="<p>Two</p>" />);
        expect(container).toHaveTextContent("Two");
        expect(container).not.toHaveTextContent("One");
        rerender(<Header />);
        expect(container.innerHTML).toBe("");
    });
});

describe("{USER_MENU}", () => {
    it("is replaced by the account menu, in the place it was written", () => {
        const { container } = render(<Header html='<div class="bar"><span class="left">Acme</span><span class="right">{USER_MENU}</span></div>' />);
        const slot = container.querySelector(`.right [${SLOT_ATTRIBUTE}="user-menu"]`)!;
        expect(slot).not.toBeNull();
        expect(slot).toContainElement(screen.getByRole("button", { name: "Account menu" }));
        expect(container).not.toHaveTextContent("{USER_MENU}");
        // Focus order follows the document: the menu is after the text before it.
        expect(
            container.querySelector(".left")!.compareDocumentPosition(screen.getByRole("button", { name: "Account menu" })) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it("leaves the text around it: adjacent to other text, and inside one text node", () => {
        const { container } = render(<Header html="<p>Signed in: {USER_MENU} (you)</p>" />);
        expect(container.querySelector("p")!.childNodes[0].textContent).toBe("Signed in: ");
        expect(container.querySelector("p")!.lastChild!.textContent).toBe(" (you)");
    });

    it("is replaced once: a second, third or adjacent copy is removed", () => {
        const { container } = render(<Header html="<p>{USER_MENU}{USER_MENU}</p><p>a {USER_MENU} b</p><div>{USER_MENU}</div>" />);
        expect(slots(container, "user-menu")).toHaveLength(1);
        expect(screen.getAllByRole("button", { name: "Account menu" })).toHaveLength(1);
        expect(container.textContent).not.toContain("{USER_MENU}");
        expect(container.querySelectorAll("p")[1].textContent).toBe("a  b");
    });

    it("is not touched inside attributes, and inside a link it is removed rather than hosting a menu in an anchor", () => {
        const { container } = render(
            <Header html='<a href="/x?u={USER_MENU}" title="{USER_MENU}" class="{USER_MENU}">go {USER_MENU}</a><div>{USER_MENU}</div>' />,
        );
        const link = container.querySelector("a")!;
        expect(link.getAttribute("href")).toBe("/x?u={USER_MENU}");
        expect(link.getAttribute("title")).toBe("{USER_MENU}");
        expect(link.textContent).toBe("go ");
        expect(link.querySelector(`[${SLOT_ATTRIBUTE}]`)).toBeNull();
        // The menu went to the first place that can hold one.
        expect(container.querySelector(`div [${SLOT_ATTRIBUTE}="user-menu"]`)).not.toBeNull();
        expect(screen.getAllByRole("button", { name: "Account menu" })).toHaveLength(1);
    });

    it("does nothing in text that can't hold an element (title), and never runs from script or style", () => {
        const parsed = parseBrandingHtml("<title>{USER_MENU}</title><script>{USER_MENU}</script><style>{USER_MENU}</style><p>x</p>");
        expect(parsed!.hasUserMenu).toBe(false);
        expect(parsed!.html).not.toContain(SLOT_ATTRIBUTE);
    });

    it("takes the text of an element it removes (a textarea) as the ordinary text it has become", () => {
        expect(parseBrandingHtml("<p>a</p><textarea>{USER_MENU}</textarea>")!.hasUserMenu).toBe(true);
    });

    it("cannot be forged: an author's own data-rr-slot is stripped before anything else", () => {
        const parsed = parseBrandingHtml(`<span ${SLOT_ATTRIBUTE}="user-menu">fake</span><b ${SLOT_ATTRIBUTE}="app-title">x</b>`)!;
        expect(parsed.hasUserMenu).toBe(false);
        expect(parsed.html).not.toContain(SLOT_ATTRIBUTE);
        const { container } = render(<Header html={`<span ${SLOT_ATTRIBUTE}="user-menu">fake</span>`} fallback />);
        expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
        expect(screen.getByRole("button", { name: "Fallback menu" })).toBeInTheDocument();
        expect(container).toHaveTextContent("fake");
    });

    it("matches exactly: lower case, spaces or a missing brace are text", () => {
        const { container } = render(<Header html="<p>{user_menu} { USER_MENU } {USER_MENU {USER_MENU}x</p>" />);
        expect(slots(container, "user-menu")).toHaveLength(1);
        expect(container.querySelector("p")!.textContent).toBe("{user_menu} { USER_MENU } {USER_MENU Account menux");
    });

    it("also survives an entity-encoded brace pair (it is the text that counts)", () => {
        const { container } = render(<Header html="<p>&#123;USER_MENU&#125;</p>" />);
        expect(slots(container, "user-menu")).toHaveLength(1);
    });

    it("is offered in the footer only when the frame passes the menu", () => {
        const { container } = render(<Footer html="<p>{USER_MENU}</p>" />);
        expect(slots(container, "user-menu")).toHaveLength(1);
        expect(screen.queryByRole("button", { name: "Footer menu" })).toBeNull();
        render(<Footer html="<p>{USER_MENU}</p>" menu />);
        expect(screen.getByRole("button", { name: "Footer menu" })).toBeInTheDocument();
    });

    it("puts the menu in a right-hand cell of the header when the HTML has no {USER_MENU}, and not otherwise", () => {
        const { container, rerender } = render(<Header html="<p>No variable</p>" menu={false} fallback />);
        const cell = container.querySelector("[data-branding-menu-cell]")!;
        expect(cell).toContainElement(screen.getByRole("button", { name: "Fallback menu" }));
        rerender(<Header html="<p>{USER_MENU}</p>" fallback />);
        expect(container.querySelector("[data-branding-menu-cell]")).toBeNull();
        expect(screen.queryByRole("button", { name: "Fallback menu" })).toBeNull();
        expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    });

    it("has no cell when nothing was asked for", () => {
        const { container } = render(<Header html="<p>Plain</p>" />);
        expect(container.querySelector("[data-branding-menu-cell]")).toBeNull();
    });
});

describe("{APP_TITLE}", () => {
    it("is replaced everywhere it is written, and follows the current app", () => {
        const { container, rerender } = render(<Header html="<h1>{APP_TITLE}</h1><p>You are in {APP_TITLE}.</p>" title="Mail" />);
        expect(container.querySelector("h1")).toHaveTextContent("Mail");
        expect(container.querySelector("p")).toHaveTextContent("You are in Mail.");
        expect(slots(container, "app-title")).toHaveLength(2);
        rerender(<Header html="<h1>{APP_TITLE}</h1><p>You are in {APP_TITLE}.</p>" title="Calendar" />);
        expect(container.querySelector("h1")).toHaveTextContent("Calendar");
        expect(container.querySelector("p")).toHaveTextContent("You are in Calendar.");
    });

    it("is text, never markup: a title that looks like HTML stays text", () => {
        const { container } = render(<Header html="<p>{APP_TITLE}</p>" title={"<img src=x onerror=alert(1)>"} />);
        expect(container.querySelector("p img")).toBeNull();
        expect(container.querySelector("p")).toHaveTextContent("<img src=x onerror=alert(1)>");
    });

    it("works in the footer, beside {USER_MENU}, and stays as written in text that can't hold an element", () => {
        const { container } = render(<Footer html="<p>{APP_TITLE} {USER_MENU}</p><title>{APP_TITLE}</title>" title="Tasks" />);
        expect(container.querySelector("p")).toHaveTextContent("Tasks");
        expect(container.querySelector("title")!.textContent).toBe("{APP_TITLE}");
    });

    it("is not touched inside an attribute", () => {
        const { container } = render(<Header html='<a href="/x" aria-label="{APP_TITLE}">{APP_TITLE}</a>' title="Mail" />);
        expect(container.querySelector("a")!.getAttribute("aria-label")).toBe("{APP_TITLE}");
    });
});

describe("parseBrandingHtml", () => {
    it("names the variables it understands", () => {
        expect(USER_MENU_VARIABLE).toBe("{USER_MENU}");
        expect(APP_TITLE_VARIABLE).toBe("{APP_TITLE}");
    });

    it("is null for nothing left after sanitizing, and reports whether a menu slot was made", () => {
        expect(parseBrandingHtml("<script>x</script>")).toBeNull();
        expect(parseBrandingHtml("<p>hi</p>")).toEqual({ html: "<p>hi</p>", hasUserMenu: false });
        expect(parseBrandingHtml("<p>{USER_MENU}</p>")!.hasUserMenu).toBe(true);
        expect(parseBrandingHtml("{USER_MENU}")!.html).toBe(`<span ${SLOT_ATTRIBUTE}="user-menu"></span>`);
    });

    it("keeps the sanitizer's guarantees on hostile input around the variables", () => {
        const parsed = parseBrandingHtml('<img src="x" onerror="alert(1)">{USER_MENU}<a href="javascript:alert(1)">{APP_TITLE}</a>')!;
        expect(parsed.html).not.toContain("onerror");
        expect(parsed.html).not.toContain("javascript:");
        expect(parsed.hasUserMenu).toBe(true);
    });
});

describe("BrandingHeader and BrandingFooter for pages without a shell (the booking pages)", () => {
    const BASE = { companyName: "Acme", title: "Acme Mail" };

    it("render nothing without branding or without configured HTML", () => {
        expect(render(<BrandingHeader branding={null} />).container.innerHTML).toBe("");
        expect(render(<BrandingFooter branding={BASE} />).container.innerHTML).toBe("");
        expect(render(<BrandingHeader branding={{ ...BASE, headerHtml: "<script>alert(1)</script>" }} />).container.innerHTML).toBe("");
    });

    it("render the sanitized HTML in a plain block, with no menu and the page's own title for {APP_TITLE}", () => {
        const { container } = render(
            <BrandingHeader branding={{ ...BASE, headerHtml: '<p onclick="alert(1)">Acme {APP_TITLE} {USER_MENU}</p>' }} appTitle="Booking" />,
        );
        expect(container.querySelector("p")).toHaveTextContent("Acme Booking");
        expect(container.innerHTML).not.toContain("onclick");
        expect(container.querySelector("button")).toBeNull();
        expect(container.querySelector("header")).toBeNull();
    });

    it("render the footer the same way, with nothing for {APP_TITLE} when the page has no title", () => {
        const { container } = render(<BrandingFooter branding={{ ...BASE, footerHtml: "<span>Footer {APP_TITLE}</span>" }} />);
        expect(container.querySelector("span")).toHaveTextContent("Footer");
        expect(container.querySelector("span")!.textContent).toBe("Footer ");
    });
});
