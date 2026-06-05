import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";

const NIM_API_KEY_NAME = "NIM_APIKEY";

type OpenCodeProviderConfig = {
    provider?: Record<
        string,
        | {
              options?: Record<string, unknown>;
          }
        | undefined
    >;
};

function parsePresentApiKey(value: string | undefined): string | undefined {
    const trimmedValue = value?.trim();

    if (!trimmedValue) {
        return undefined;
    }

    return trimmedValue;
}

function removeInlineCommentOutsideQuotes(value: string): string {
    let isSingleQuoted = false;
    let isDoubleQuoted = false;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        const previousCharacter = value[index - 1];

        if (character === '"' && !isSingleQuoted && previousCharacter !== "\\") {
            isDoubleQuoted = !isDoubleQuoted;
            continue;
        }

        if (character === "'" && !isDoubleQuoted) {
            isSingleQuoted = !isSingleQuoted;
            continue;
        }

        if (character !== "#" || isSingleQuoted || isDoubleQuoted) {
            continue;
        }

        if (index === 0 || /\s/.test(previousCharacter ?? "")) {
            return value.slice(0, index);
        }
    }

    return value;
}

function unquoteEnvValue(value: string): string {
    const trimmedValue = removeInlineCommentOutsideQuotes(value).trim();
    const quote = trimmedValue.at(0);

    if ((quote !== '"' && quote !== "'") || trimmedValue.at(-1) !== quote) {
        return trimmedValue;
    }

    const quotedValue = trimmedValue.slice(1, -1);

    if (quote === "'") {
        return quotedValue;
    }

    return quotedValue.replace(/\\(["\\nrt])/g, (_, escapedCharacter: string) => {
        if (escapedCharacter === "n") {
            return "\n";
        }

        if (escapedCharacter === "r") {
            return "\r";
        }

        if (escapedCharacter === "t") {
            return "\t";
        }

        return escapedCharacter;
    });
}

function parseNimApiKeyFromEnvFile(content: string): string | undefined {
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#")) {
            continue;
        }

        const assignment = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
        const separatorIndex = assignment.indexOf("=");

        if (separatorIndex === -1) {
            continue;
        }

        const key = assignment.slice(0, separatorIndex).trim();

        if (key !== NIM_API_KEY_NAME) {
            continue;
        }

        const value = assignment.slice(separatorIndex + 1);

        return parsePresentApiKey(unquoteEnvValue(value));
    }

    return undefined;
}

async function loadNimApiKeyFromProjectEnv(): Promise<string | undefined> {
    const pluginPath = fileURLToPath(import.meta.url);
    const pluginDirectory = dirname(pluginPath);
    const projectEnvPath = join(pluginDirectory, "..", ".env");

    try {
        const envFileContent = await readFile(projectEnvPath, "utf8");
        return parseNimApiKeyFromEnvFile(envFileContent);
    } catch {
        return undefined;
    }
}

function injectNvidiaApiKey(cfg: unknown, nimApiKey: string | undefined): void {
    if (!nimApiKey) {
        return;
    }

    const config = cfg as OpenCodeProviderConfig;
    const nvidiaProvider = config.provider?.nvidia;

    if (!nvidiaProvider) {
        return;
    }

    nvidiaProvider.options = {
        ...nvidiaProvider.options,
        apiKey: nimApiKey,
    };
}

export default (async () => {
    const nimApiKey = parsePresentApiKey(process.env[NIM_API_KEY_NAME]) ?? (await loadNimApiKeyFromProjectEnv());

    return {
        config: async (cfg) => {
            injectNvidiaApiKey(cfg, nimApiKey);
        },
    };
}) satisfies Plugin;
