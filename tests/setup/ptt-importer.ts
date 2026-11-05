import { setDefaultPttImporterForTests } from "../../src/core/parser-ptt";

// Vitest executes modules in a vm context, where the Function-based dynamic import used
// in production is unavailable. A literal import() works under Vite, so tests load the
// real package through it. The production loader is exercised in plain Node by
// tests/parser-ptt-loader.test.ts.
setDefaultPttImporterForTests(() => import("@aiostreams/release-parser"));
