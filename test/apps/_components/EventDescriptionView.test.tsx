// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import EventDescriptionView from "../../../apps/shared/components/calendar/EventDescriptionView.js";

// An event's description, read-only. It can come from anyone (an invitation), so it is drawn as React elements from an allow-list, never as markup.

describe("EventDescriptionView", () => {
    it("draws the rich text: paragraphs, bold, italic, underline, breaks and both kinds of list", () => {
        const { container } = render(
            <EventDescriptionView html="<p>Hi <b>bold</b> <i>italic</i> <u>under</u><br>next</p><ul><li>a</li></ul><ol><li><p>b</p></li></ol>" />,
        );

        expect(container.querySelector("p")).toHaveTextContent("Hi bold italic undernext");
        expect(container.querySelector("strong")).toHaveTextContent("bold");
        expect(container.querySelector("em")).toHaveTextContent("italic");
        expect(container.querySelector("u")).toHaveTextContent("under");
        expect(container.querySelector("p br")).toBeInTheDocument();
        expect(container.querySelector("ul > li")).toHaveTextContent("a");
        expect(container.querySelector("ol > li")).toHaveTextContent("b");
    });

    it("opens a link in a new tab with rel noopener noreferrer", () => {
        const { container } = render(<EventDescriptionView html='<a href="https://example.com/x" target="_self" onclick="alert(1)" style="color:red">go</a>' />);
        const link = container.querySelector("a")!;
        expect(link).toHaveAttribute("href", "https://example.com/x");
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
        expect(link).not.toHaveAttribute("onclick");
        expect(link).not.toHaveAttribute("style");
    });

    it("draws nothing that runs or embeds: no script, image, iframe, style, event handler or javascript: link", () => {
        const { container } = render(
            <EventDescriptionView
                html={
                    '<script>window.hacked = 1</script><img src="https://tracker.example/x.png" onerror="window.hacked = 2">' +
                    '<iframe src="https://example.com"></iframe><style>p { color: red }</style>' +
                    '<p onclick="window.hacked = 3" style="color:red" class="x">text</p><a href="javascript:window.hacked = 4">link</a>' +
                    '<svg><script>window.hacked = 5</script></svg><form action="https://example.com"><input name="x"></form>'
                }
            />,
        );

        for (const selector of ["script", "img", "iframe", "style", "svg", "form", "input", "a"]) {
            expect(container.querySelector(selector)).toBeNull();
        }
        const paragraph = container.querySelector("p")!;
        expect(paragraph).toHaveTextContent("text");
        // Only the classes this component gives it: nothing the description said.
        for (const attribute of ["onclick", "style"]) {
            expect(paragraph.getAttribute(attribute)).toBeNull();
        }
        expect(paragraph.getAttribute("class")).not.toContain("x");
        expect(container).toHaveTextContent("link");
        expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
    });

    it("draws the plain text, its line breaks kept, when there is no HTML or the HTML holds no text", () => {
        const { container, rerender } = render(<EventDescriptionView text={"line one\nline two"} />);
        expect(container.firstElementChild).toHaveClass("whitespace-pre-wrap");
        expect(container.textContent).toBe("line one\nline two");

        rerender(<EventDescriptionView html="<p></p><script>x</script>" text="Fallback" />);
        expect(container).toHaveTextContent("Fallback");
    });

    it("prefers the HTML to the plain text, and takes a class", () => {
        const { container } = render(<EventDescriptionView html="<p>Rich</p>" text="Plain" className="extra" />);
        expect(container).toHaveTextContent("Rich");
        expect(container).not.toHaveTextContent("Plain");
        expect(container.firstElementChild).toHaveClass("extra");
    });

    it("draws nothing for no description", () => {
        expect(render(<EventDescriptionView />).container).toBeEmptyDOMElement();
        expect(render(<EventDescriptionView html={null} text="   " />).container).toBeEmptyDOMElement();
        expect(render(<EventDescriptionView html="<p> </p>" text={null} />).container).toBeEmptyDOMElement();
    });
});
