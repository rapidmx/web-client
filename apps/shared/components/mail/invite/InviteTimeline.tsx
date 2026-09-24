///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { InviteScheduleEntry, MessageInvite } from "@rapidmx/react-shared/calendar/inviteApi.js";
import { validDate } from "./inviteFormat.js";

/** How tall one hour is drawn, in px. */
const HOUR_HEIGHT = 36;
/** The room the hour labels take at the left, as a CSS length. */
const LABEL_WIDTH = "3.25rem";
/** The hours of context shown before the invitation and after it, and the least the day view is tall (in hours). */
const CONTEXT_HOURS = 2;
const MIN_HOURS = 5;

const MINUTE_MS = 60_000;

/** A block of the day and where it sits among the blocks it overlaps. */
export interface PlacedBlock {
    /** Which of the overlapping columns it is drawn in. */
    column: number;
    /** How many columns its cluster of overlapping blocks needs. */
    columns: number;
}

/**
 * Lays overlapping blocks side by side: blocks that overlap (directly or through a chain of others) form a cluster, and each block takes the first
 * column of the cluster that is free where it starts. `blocks` must be sorted by start; the result is in the same order.
 */
export function placeBlocks(blocks: { start: number; end: number }[]): PlacedBlock[] {
    const placed: PlacedBlock[] = [];
    let cluster: { index: number; column: number }[] = [];
    let columnEnds: number[] = [];
    let clusterEnd = -Infinity;
    const close = () => {
        for (const member of cluster) {
            placed[member.index] = { column: member.column, columns: columnEnds.length };
        }
        cluster = [];
        columnEnds = [];
    };
    blocks.forEach((block, index) => {
        if (block.start >= clusterEnd) {
            close();
        }
        let column = columnEnds.findIndex((end) => end <= block.start);
        if (column === -1) {
            column = columnEnds.length;
        }
        columnEnds[column] = block.end;
        cluster.push({ index, column });
        clusterEnd = Math.max(clusterEnd, block.end);
    });
    close();
    return placed;
}

/** The hours the day view spans: the invitation's own, with `CONTEXT_HOURS` either side (at least `MIN_HOURS`), kept inside the invitation's day. */
function hourWindow(start: Date, end: Date): { from: number; to: number } {
    const sameDay = start.toDateString() === end.toDateString();
    const endHour = sameDay ? Math.ceil(end.getHours() + end.getMinutes() / 60) : 24;
    let from = Math.max(0, start.getHours() - CONTEXT_HOURS);
    let to = Math.min(24, endHour + CONTEXT_HOURS);
    if (to - from < MIN_HOURS) {
        to = Math.min(24, from + MIN_HOURS);
        from = Math.max(0, to - MIN_HOURS);
    }
    return { from, to };
}

interface Block {
    key: string;
    title: string;
    start: number;
    end: number;
    kind: "invite" | "conflict" | "busy" | "free";
    tentative: boolean;
}

const BLOCK_CLASS: Record<Block["kind"], string> = {
    invite: "bg-primary/20 border-primary text-text font-semibold",
    conflict: "bg-danger-bg border-danger text-danger",
    busy: "bg-surface border-border text-text",
    free: "bg-transparent border-border text-text-muted",
};

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const HOUR = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

export interface InviteTimelineProps {
    invite: Pick<MessageInvite, "startDate" | "endDate" | "summary" | "conflicts" | "schedule">;
}

/**
 * A small day agenda around an invitation, as Outlook draws it in its RSVP card: hour rows for the invitation's day (from a couple of hours before it
 * to a couple after), the invitation itself as a highlighted block, and the reader's other events as blocks - the ones that overlap it marked in red
 * (and named as conflicts to a screen reader). Overlapping blocks stand side by side. All-day events are listed above the hours rather than drawn.
 * Draws nothing when the invitation has no usable time.
 */
export default function InviteTimeline({ invite }: InviteTimelineProps) {
    const start = validDate(invite.startDate);
    const end = validDate(invite.endDate);
    if (!start || !end || end <= start) {
        return null;
    }
    const { from, to } = hourWindow(start, end);
    const windowStart = new Date(start.getFullYear(), start.getMonth(), start.getDate(), from).getTime();
    const windowEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate(), to).getTime();
    const conflictUids = new Set(invite.conflicts.map((entry) => entry.uid));
    // A conflict the schedule doesn't list is still drawn.
    const entries: InviteScheduleEntry[] = [...invite.schedule, ...invite.conflicts.filter((c) => !invite.schedule.some((s) => s.uid === c.uid))];
    const allDay = entries.filter((entry) => entry.allDay);

    const blocks: Block[] = [{ key: "invite", title: invite.summary?.trim() || "(no title)", start: start.getTime(), end: end.getTime(), kind: "invite", tentative: false }];
    for (const entry of entries) {
        const entryStart = validDate(entry.startDate)?.getTime();
        const entryEnd = validDate(entry.endDate)?.getTime();
        if (entry.allDay || entryStart === undefined || entryEnd === undefined) {
            continue;
        }
        blocks.push({
            key: entry.uid,
            title: entry.title || "(no title)",
            start: entryStart,
            end: entryEnd,
            kind: conflictUids.has(entry.uid) ? "conflict" : entry.busy ? "busy" : "free",
            tentative: entry.tentative,
        });
    }
    // Clipped to the hours shown; a block entirely outside them isn't drawn.
    const visible = blocks
        .map((block) => ({ ...block, start: Math.max(block.start, windowStart), end: Math.min(block.end, windowEnd), fullStart: block.start, fullEnd: block.end }))
        .filter((block) => block.end > block.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const placed = placeBlocks(visible);
    const hours = Array.from({ length: to - from }, (_, i) => from + i);

    return (
        <div aria-label="Your schedule around this meeting" role="group" className="text-xs">
            {allDay.length > 0 && (
                <ul aria-label="All-day events" className="mb-1 flex flex-col gap-0.5">
                    {allDay.map((entry) => (
                        <li key={entry.uid} className="px-2 py-0.5 rounded-sm border border-border bg-surface text-text-muted truncate">
                            All day: {entry.title || "(no title)"}
                        </li>
                    ))}
                </ul>
            )}
            <div className="relative border-t border-border" style={{ height: hours.length * HOUR_HEIGHT }}>
                {hours.map((hour) => (
                    <div
                        key={hour}
                        aria-hidden="true"
                        className="absolute inset-x-0 border-b border-border text-text-muted"
                        style={{ top: (hour - from) * HOUR_HEIGHT, height: HOUR_HEIGHT }}
                    >
                        <span className="absolute left-0 top-0 pr-1 leading-none pt-0.5" style={{ width: LABEL_WIDTH }}>
                            {HOUR.format(new Date(2000, 0, 1, hour))}
                        </span>
                    </div>
                ))}
                <ul aria-label="Events">
                    {visible.map((block, index) => {
                        const { column, columns } = placed[index];
                        const top = ((block.start - windowStart) / MINUTE_MS / 60) * HOUR_HEIGHT;
                        const height = Math.max(18, ((block.end - block.start) / MINUTE_MS / 60) * HOUR_HEIGHT - 1);
                        const range = `${CLOCK.format(block.fullStart)} to ${CLOCK.format(block.fullEnd)}`;
                        return (
                            <li
                                key={block.key}
                                title={`${block.title}, ${range}`}
                                data-kind={block.kind}
                                className={[
                                    "absolute overflow-hidden rounded-sm border px-1.5 py-0.5 leading-tight",
                                    BLOCK_CLASS[block.kind],
                                    block.tentative ? "border-dashed" : "",
                                ].join(" ")}
                                style={{
                                    top,
                                    height,
                                    left: `calc(${LABEL_WIDTH} + (100% - ${LABEL_WIDTH}) * ${column} / ${columns})`,
                                    width: `calc((100% - ${LABEL_WIDTH}) / ${columns} - 2px)`,
                                }}
                            >
                                <span className="block truncate">{block.title}</span>
                                <span className="sr-only">
                                    , {range}
                                    {block.kind === "invite" ? ", this meeting" : ""}
                                    {block.kind === "conflict" ? ", conflicts with this meeting" : ""}
                                    {block.tentative ? ", tentative" : ""}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </div>
    );
}
