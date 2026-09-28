// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    htmlToPlainText,
    parseEventDescription,
    safeDescriptionHref,
    sanitizeEventDescriptionHtml,
} from "../../../lib/calendar/eventDescription.js";

describe("safeDescriptionHref", () => {
    it("keeps http, https and mailto links in their canonical form", () => {
        expect(safeDescriptionHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
        expect(safeDescriptionHref("HTTP://Example.com")).toBe("http://example.com/");
        expect(safeDescriptionHref("mailto:jane@example.com")).toBe("mailto:jane@example.com");
    });

    it("refuses every other scheme, a relative link, nothing at all and a scheme hidden by whitespace", () => {
        expect(safeDescriptionHref("javascript:alert(1)")).toBeUndefined();
        expect(safeDescriptionHref("java\tscript:alert(1)")).toBeUndefined();
        expect(safeDescriptionHref(" jav\nascript:alert(1)")).toBeUndefined();
        expect(safeDescriptionHref("data:text/html,<script>1</script>")).toBeUndefined();
        expect(safeDescriptionHref("tel:+15551234")).toBeUndefined();
        expect(safeDescriptionHref("/relative")).toBeUndefined();
        expect(safeDescriptionHref("")).toBeUndefined();
        expect(safeDescriptionHref(null)).toBeUndefined();
        expect(safeDescriptionHref(undefined)).toBeUndefined();
    });
});

describe("parseEventDescription", () => {
    it("is empty for nothing", () => {
        expect(parseEventDescription("")).toEqual([]);
        expect(parseEventDescription(null)).toEqual([]);
        expect(parseEventDescription(undefined)).toEqual([]);
    });

    it("reads text and the allowed elements, b and i becoming strong and em", () => {
        expect(parseEventDescription("<p>Hi <b>there</b> <i>you</i><br><u>u</u></p>")).toEqual([
            {
                tag: "p",
                children: [
                    { text: "Hi " },
                    { tag: "strong", children: [{ text: "there" }] },
                    { text: " " },
                    { tag: "em", children: [{ text: "you" }] },
                    { tag: "br", children: [] },
                    { tag: "u", children: [{ text: "u" }] },
                ],
            },
        ]);
    });

    it("keeps a safe link's href only and unwraps a link that goes nowhere safe", () => {
        expect(parseEventDescription('<a href="https://example.com" onclick="x()" style="color:red" class="c">go</a>')).toEqual([
            { tag: "a", href: "https://example.com/", children: [{ text: "go" }] },
        ]);
        expect(parseEventDescription('<a href="javascript:alert(1)">click</a><a>bare</a>')).toEqual([{ text: "click" }, { text: "bare" }]);
    });

    it("drops elements that run or embed something with their content, and unwraps other elements to their text", () => {
        expect(
            parseEventDescription(
                '<script>alert(1)</script><style>p{}</style><iframe src="x">frame</iframe><svg><text>svg</text></svg><textarea>ta</textarea><img src="x" onerror="y()"><div>kept <span>text</span></div><h1>head</h1>',
            ),
        ).toEqual([{ text: "kept " }, { text: "text" }, { text: "head" }]);
    });

    it("ignores comments", () => {
        expect(parseEventDescription("a<!-- hidden -->b")).toEqual([{ text: "a" }, { text: "b" }]);
    });

    it("unwraps a paragraph inside a list item, separating a second one with a break", () => {
        expect(parseEventDescription("<ul><li><p>one</p><p>more</p></li></ul>")).toEqual([
            {
                tag: "ul",
                children: [{ tag: "li", children: [{ text: "one" }, { tag: "br", children: [] }, { text: "more" }] }],
            },
        ]);
    });
});

describe("sanitizeEventDescriptionHtml", () => {
    it("writes canonical HTML: escaped text, a link with rel, nothing else", () => {
        expect(sanitizeEventDescriptionHtml('<p onclick="x()">1 &lt; 2 &amp; <a href="https://example.com/?a=1&amp;b=&quot;2&quot;">l</a></p><script>x</script>')).toBe(
            '<p>1 &lt; 2 &amp; <a href="https://example.com/?a=1&amp;b=%222%22" rel="noopener noreferrer">l</a></p>',
        );
        expect(sanitizeEventDescriptionHtml("<b>b</b><em>e</em><ol><li>x</li></ol>a<br>b")).toBe("<strong>b</strong><em>e</em><ol><li>x</li></ol>a<br>b");
    });

    it("escapes a quote that survives in a link's href", () => {
        // A `"` is percent-encoded by the URL parser in a query, but not in a mailto's path.
        expect(sanitizeEventDescriptionHtml('<a href="mailto:a&quot;b@example.com">m</a>')).toContain("&quot;");
    });

    it("drops the empty paragraphs and blank lines before and after the text, and keeps the ones between", () => {
        expect(sanitizeEventDescriptionHtml("<p></p> <p><br></p><p>a</p><p></p><p>b</p><p> </p><br><p></p>")).toBe("<p>a</p><p></p><p>b</p>");
        expect(sanitizeEventDescriptionHtml("<p></p><p> </p><br>")).toBe("");
        // A paragraph with a link or any text in it is not blank.
        expect(sanitizeEventDescriptionHtml("<p><a href=\"https://example.com\">x</a></p>")).toBe('<p><a href="https://example.com/" rel="noopener noreferrer">x</a></p>');
        expect(sanitizeEventDescriptionHtml("<ul><li></li></ul>")).toBe("<ul><li></li></ul>");
    });

    it("is idempotent, and nothing at all for nothing", () => {
        const once = sanitizeEventDescriptionHtml('<ul><li><p>x</p></li></ul><a href="https://example.com">l</a>');
        expect(sanitizeEventDescriptionHtml(once)).toBe(once);
        expect(sanitizeEventDescriptionHtml(null)).toBe("");
        expect(sanitizeEventDescriptionHtml("")).toBe("");
    });
});

describe("htmlToPlainText", () => {
    it("has a line for each paragraph, break and list item, numbering ordered lists", () => {
        expect(htmlToPlainText("<p>First</p><p>Second<br>line</p><ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>")).toBe(
            "First\nSecond\nline\n- a\n- b\n1. x\n2. y",
        );
    });

    it("keeps a list item's text on its bullet's line when the editor wrapped it in a paragraph", () => {
        expect(htmlToPlainText("<ul><li><p>one</p></li><li><p>two</p></li></ul>")).toBe("- one\n- two");
    });

    it("puts a link's address after its text unless the text is the address", () => {
        expect(htmlToPlainText('<p>See <a href="https://example.com/x">the page</a></p>')).toBe("See the page (https://example.com/x)");
        expect(htmlToPlainText('<a href="https://example.com/">https://example.com/</a>')).toBe("https://example.com/");
        expect(htmlToPlainText('<a href="mailto:jane@example.com">jane@example.com</a>')).toBe("jane@example.com");
    });

    it("collapses white space and runs of blank lines, and drops control characters", () => {
        expect(htmlToPlainText("<p>  a \n  b\u0001 </p><p></p><p></p><p></p><p>c</p>")).toBe("a b\nc");
        expect(htmlToPlainText("a<br><br><br><br>b")).toBe("a\n\nb");
    });

    it("is empty for an empty description", () => {
        expect(htmlToPlainText("<p></p>")).toBe("");
        expect(htmlToPlainText(null)).toBe("");
    });

    it("treats a list item outside any list as bulleted, and other elements as their content", () => {
        expect(htmlToPlainText("<li>lonely</li><u>under</u>")).toBe("- lonely\nunder");
    });
});
