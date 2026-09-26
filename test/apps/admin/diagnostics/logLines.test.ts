// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    entriesToLog,
    entriesToNdjson,
    entryMatches,
    entryTime,
    formatLogLine,
    isControlFrame,
    LOG_LEVELS,
    LogEntry,
    levelVisible,
    parseLogFrame,
    stripAnsi,
} from "../../../../apps/shared/components/admin/diagnostics/logLines.js";

function entry(raw: string, id = 1): LogEntry {
    const frame = parseLogFrame(raw, id, 1_000);
    if (isControlFrame(frame)) {
        throw new Error("a control frame");
    }
    return frame;
}

describe("parseLogFrame", () => {
    it("reads the control frame, and does not make a line of it", () => {
        const frame = parseLogFrame('{"id":0,"type":"SUBSCRIBED","success":true,"data":"logs"}', 1, 0);
        expect(isControlFrame(frame)).toBe(true);
        expect(frame).toEqual({ control: true, success: true, data: "logs" });
    });

    it("reads a control frame that says the subscription failed", () => {
        expect(parseLogFrame('{"type":"SUBSCRIBED","success":false}', 1, 0)).toEqual({ control: true, success: false, data: undefined });
    });

    it("reads a Winston info object, keeping its other fields", () => {
        const line = entry(
            '{"level":"warn","message":"Slow query","timestamp":"2026-09-26T10:00:00.000Z","label":"db","stack":"Error: x\\n at y"}',
            7
        );
        expect(line).toMatchObject({
            id: 7,
            receivedAt: 1_000,
            level: "warn",
            message: "Slow query",
            timestamp: "2026-09-26T10:00:00.000Z",
            structured: true,
            extra: { label: "db", stack: "Error: x\n at y" },
        });
        expect(JSON.parse(line.json)).toMatchObject({ level: "warn", label: "db" });
    });

    it("does not take an info object with a type of SUBSCRIBED and a level for the control frame", () => {
        const line = entry('{"type":"SUBSCRIBED","level":"info","message":"a logged line"}');
        expect(line.message).toBe("a logged line");
        expect(line.extra).toEqual({ type: "SUBSCRIBED" });
    });

    it("tolerates missing fields, upper-case and coloured levels, and a message that is not text", () => {
        expect(entry("{}")).toMatchObject({ level: "", message: "", timestamp: undefined, structured: true });
        expect(entry('{"level":"\\u001b[31mERROR\\u001b[39m","message":"\\u001b[1mbold\\u001b[22m"}')).toMatchObject({
            level: "error",
            message: "bold",
        });
        expect(entry('{"level":"info","message":{"a":1}}').message).toBe('{"a":1}');
        expect(entry('{"level":"info","message":42,"timestamp":1}')).toMatchObject({ message: "42", timestamp: undefined });
    });

    it("shows a frame that is not JSON as it came, on one line of JSON in the ndjson", () => {
        const line = entry("plain \u001b[32mtext\u001b[39m\nsecond line");
        expect(line).toMatchObject({ level: "", message: "plain text\nsecond line", structured: false, extra: {} });
        expect(JSON.parse(line.json)).toEqual({ raw: "plain \u001b[32mtext\u001b[39m\nsecond line" });
        expect(line.json).not.toContain("\n");
    });

    it("shows JSON that is not an object as text", () => {
        for (const raw of ["42", "null", '"a string"', "[1,2]"]) {
            expect(entry(raw)).toMatchObject({ message: raw, structured: false });
        }
    });
});

describe("formatting", () => {
    const stamped = entry('{"level":"info","message":"Started","timestamp":"2026-09-26T10:00:00.000Z"}');
    const unstamped = entry('{"level":"error","message":"Failed"}');
    const raw = entry("just text");

    it("uses the server's time, else the time the line was received", () => {
        expect(entryTime(stamped)).toBe("2026-09-26T10:00:00.000Z");
        expect(entryTime(unstamped)).toBe(new Date(1_000).toISOString());
    });

    it("writes <timestamp> <LEVEL> <message>, and no level for a line without one", () => {
        expect(formatLogLine(stamped)).toBe("2026-09-26T10:00:00.000Z INFO Started");
        expect(formatLogLine(unstamped)).toBe(`${new Date(1_000).toISOString()} ERROR Failed`);
        expect(formatLogLine(raw)).toBe(`${new Date(1_000).toISOString()} just text`);
        expect(formatLogLine(entry("{}"))).toBe(new Date(1_000).toISOString());
    });

    it("writes one line for each entry in a .log, folding a message's own line breaks", () => {
        const multi = entry('{"level":"error","message":"a\\r\\nb\\nc","timestamp":"T"}');
        expect(entriesToLog([stamped, multi])).toBe("2026-09-26T10:00:00.000Z INFO Started\nT ERROR a ↵ b ↵ c\n");
    });

    it("writes each frame as one line of JSON in an .ndjson", () => {
        const text = entriesToNdjson([stamped, raw]);
        const lines = text.trimEnd().split("\n");
        expect(text.endsWith("\n")).toBe(true);
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toMatchObject({ message: "Started" });
        expect(JSON.parse(lines[1])).toEqual({ raw: "just text" });
    });
});

describe("filtering", () => {
    const info = entry('{"level":"info","message":"Hello World","label":"Mailer"}');
    const debug = entry('{"level":"debug","message":"x"}');
    const odd = entry('{"level":"notice","message":"y"}');
    const raw = entry("plain");

    it("keeps the levels that are on, and always a line with no known level", () => {
        const onlyInfo = new Set(["info"]);
        expect(levelVisible(info, onlyInfo)).toBe(true);
        expect(levelVisible(debug, onlyInfo)).toBe(false);
        expect(levelVisible(odd, onlyInfo)).toBe(true);
        expect(levelVisible(raw, new Set<string>())).toBe(true);
        expect(LOG_LEVELS).toHaveLength(7);
    });

    it("searches the time, level, message and other fields, ignoring case", () => {
        expect(entryMatches(info, "")).toBe(true);
        expect(entryMatches(info, "hello")).toBe(true);
        expect(entryMatches(info, "info hello")).toBe(true);
        expect(entryMatches(info, "mailer")).toBe(true);
        expect(entryMatches(info, "missing")).toBe(false);
        expect(entryMatches(debug, "missing")).toBe(false);
    });

    it("strips colour codes", () => {
        expect(stripAnsi("\u001b[1;32mok\u001b[0m")).toBe("ok");
    });
});
