import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    // Forces every resolution of react/react-dom to the same physical module instance. Originally added
    // for the former @rapidmx/react-shared package (portal-linked, with its own independent
    // devDependency copy of React needed to run its tests standalone), which would otherwise resolve as
    // a second instance and break every hook it exports with "Invalid hook call" - see rapidmx/server's
    // identical fix (and its own .claude/NOTES.md entry) for the full incident this was preempting.
    // Kept now that react-shared's code has moved into this package's own lib/ (2026-09-27, see
    // .claude/NOTES.md) as cheap insurance against the same class of issue with any other
    // portal/workspace-linked peer (e.g. @rapidrest/react in local development).
    resolve: {
        dedupe: ["react", "react-dom"],
    },
    test: {
        globals: true,
        // Every page/component test needs a DOM, so jsdom is the project-wide default here rather than an
        // opt-in per file - unlike the former @rapidmx/react-shared package's own vitest.config.ts, which
        // defaulted to "node" (most of its tests were plain fetch/logic) and opted individual test files
        // into jsdom with a `// @vitest-environment jsdom` docblock. Its tests, now under test/lib/, kept
        // those docblocks where present (harmless - jsdom is already the default here), and every file that
        // relied on the *implicit* "node" default there was given an explicit `// @vitest-environment node`
        // docblock here (35 files) rather than being left to inherit this package's jsdom default: several
        // do real WebCrypto/pkijs work (S/MIME encrypt/decrypt, key wrapping) that failed for real under
        // jsdom's own crypto shim (pkijs's ECDH KDF math threw "Zbuffer is not of type ArrayBuffer" -
        // confirmed 2026-09-27, see .claude/NOTES.md), and the `*.nodom.test.ts` files assert `document` is
        // literally undefined, which jsdom never satisfies.
        environment: "jsdom",
        setupFiles: ["./test/apps/setup.ts"],
        include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
        // Pins the test process's local timezone to UTC - the calendar views (MonthView/TimeGridView)
        // use date-fns's local-time-aware functions, so a UTC ISO fixture and the components' own
        // local-time calculations only agree everywhere the suite runs if both sides pin the same zone.
        // Carried over verbatim from rapidmx/server's own vitest.config.ts, which hit this for real.
        env: { TZ: "UTC" },
        fileParallelism: false,
        pool: "forks",
        // The defaults (5 s a test, 10 s a hook) are sized for a fast developer machine. A test renders whole pages
        // - 500-row lists, pages that import their heaviest chunk on first use - and a CI runner is several times
        // slower than that, so a test that takes 1.5 s here can take more than 5 s there. A test that is stuck
        // still fails, only later; a fast one is unaffected.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        clearMocks: true,
        coverage: {
            enabled: true,
            provider: "v8",
            include: ["apps/**/*.ts", "apps/**/*.tsx", "lib/**/*.ts", "lib/**/*.tsx"],
            exclude: ["**/node_modules/**", "**/test/**"],
            reporter: ["text", "json", "html", "lcov"],
            thresholds: {
                // This package is fully unit-tested and held to 100% - fails the build if new code lands
                // without matching tests. Carried over from rapidmx/server's own vitest.config.ts, which
                // enforced this on the same code before the 2026-09-10 extraction (see .claude/NOTES.md).
                'apps/**': {
                    // Branches held at 99%, not 100%, as a deliberate one-off covering two known,
                    // individually-investigated gaps - not a general excuse to skip writing branch-coverage
                    // tests:
                    // - `ComposeWindow.tsx`'s `e.target.files ?? []` branch is genuinely exercised on both
                    //   sides - confirmed via repeated isolated/small-group/single-threaded re-runs - but
                    //   `@vitest/coverage-v8`'s branch derivation reproducibly fails to attribute correctly
                    //   only at full-suite scale (statements/lines/functions all stay 100% regardless). See
                    //   rapidmx/server's `.claude/NOTES.md`'s 2026-09-07 "Floating Compose window" entry for
                    //   the full investigation.
                    // - `RuleBuilder.tsx`'s `removeListEntry()` has its own defensive `?? []` fallback for
                    //   `conditions[key]` being unset, mirroring `addListEntry()`'s identical fallback - but
                    //   unlike `addListEntry` (reachable: adding a field's *first* entry always starts from
                    //   `conditions[key] === undefined`), `removeListEntry` is only ever invoked from a
                    //   chip's own "Remove" button, which by construction only renders when
                    //   `conditions[key]` already holds that entry - so this fallback can't be reached
                    //   through the component's real UI (2026-09-11).
                    // Revisit if either count ever creeps further, or a real reachable path to
                    // `removeListEntry`'s fallback is found.
                    branches: 99,
                    functions: 100,
                    lines: 100,
                    statements: 100,
                },
                // Carried over verbatim from the former @rapidmx/react-shared package's own vitest.config.ts
                // (merged into this package 2026-09-27, see .claude/NOTES.md) along with its code. Branches
                // held at 98, not 100, covering four independently-justified, deliberate gaps - not a general
                // excuse to skip branch coverage elsewhere. Vitest's thresholds are an aggregate across every
                // file matched by a glob, not a per-file minimum, so each of these relaxes the whole `lib/**`
                // aggregate by a few branches, not just their own file.
                //
                // 1. useBranding.ts's stylesheet-link effect has a `!link` "reuse an existing link" branch
                //    that's unreachable through the public hook - `branding` starts `null` on every mount, so
                //    this effect's own first run (before the fetch resolves) always takes the "no
                //    stylesheetUrl yet" path and removes any existing link first; by the time branding loads,
                //    the link is already gone, so a new one is always created rather than reused. See
                //    test/lib/branding/useBranding.test.tsx's 2026-09-11 test for the actual
                //    (doc-comment-contradicting) behavior this documents - worth JP's own look as a possible
                //    real fix, not changed here.
                // 2. smime.ts has one branch unreachable through its own public API surface, documented inline
                //    at its exact location: `decryptEnvelopedData()`'s non-Error-thrown fallback (only
                //    reachable with zero recipientInfos, which `encryptForRecipients()` never produces in
                //    practice).
                // 3. queryGrammar.ts#extractFirst()'s `match[2] ?? match[3] ?? ""` fallback - the regex it
                //    follows requires one of group 2 (quoted value) or group 3 (bare value) whenever it
                //    matches at all, so the `?? ""` arm is unreachable.
                // 4. searchTier3.ts's `security.subject ?? ""` - `ProtectedHeaders.subject` is a required
                //    (non-optional) string field, so whenever `MessageSecurityResult.subject` is set at all
                //    (which the surrounding `!security.html && !security.subject` guard already requires
                //    before this line is reached), it is never `undefined`.
                'lib/**': {
                    branches: 98,
                    functions: 100,
                    lines: 100,
                    statements: 100,
                },
            },
            reportsDirectory: "coverage",
        },
        reporters: ["default", "junit"],
        outputFile: {
            junit: "junit.xml",
        },
    },
});
