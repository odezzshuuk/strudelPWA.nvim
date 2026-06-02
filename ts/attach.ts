import fs from "fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import os from "os";
import { logger } from "./logger.ts";

declare global {
    interface Window {
        strudelMirror: any;
        sendEditorContent: () => void;
        notifyEvalError: (evalErrorMessage: string | null) => void;
        sendEditorCursor: () => void;
    }
}

logger.setFileLogLevel("INFO");

process.on("SIGINT", () => {
    void shutdown(0);
});
process.on("SIGTERM", () => {
    void shutdown(0);
});

process.stderr.on("error", (err) => {
    // Handle EPIPE errors gracefully, which can occur if the parent process closes stdin/stdout.
    void logger.error("Error writing to stderr", err);
});

const STRUDEL_URL = "https://strudel.cc/";
const USER_DATA_DIR = path.join(os.homedir(), ".cache", "strudel-nvim");

type UserConfig = {
    hideTopBar: boolean;
    maximiseMenuPanel: boolean;
    hideMenuPanel: boolean;
    hideCodeEditor: boolean;
    hideErrorDisplay: boolean;
    customCss: string | undefined;
    isHeadless: boolean;
    userDataDir: string | undefined;
    browserExecPath: string | undefined;
    // strudelUrl: string,
};


type LocalPWACommand = {
    executable: string;
    args: Record<string, string>;
};

const MESSAGES = {
    CONTENT: "STRUDEL_CONTENT:",
    QUIT: "STRUDEL_QUIT",
    TOGGLE: "STRUDEL_TOGGLE",
    UPDATE: "STRUDEL_UPDATE",
    STOP: "STRUDEL_STOP",
    REFRESH: "STRUDEL_REFRESH",
    READY: "STRUDEL_READY",
    CURSOR: "STRUDEL_CURSOR:",
    EVAL_ERROR: "STRUDEL_EVAL_ERROR:",
};

const SELECTORS = {
    EDITOR: ".cm-content",
};
const EVENTS = {
    CONTENT_CHANGED: "strudel-content-changed",
};
const STYLES = {
    HIDE_EDITOR_SCROLLBAR: `
		.cm-scroller {
			scrollbar-width: none;
		}
	`,
    HIDE_TOP_BAR: `
		header {
			display: none !important;
		}
	`,
    MAX_MENU_PANEL: `
		nav:not(:has(> button:first-child)) {
			position: absolute;
			z-index: 99;
			height: 100%;
			width: 100vw;
			max-width: 100vw;
			background: linear-gradient(var(--lineHighlight), var(--lineHighlight)), var(--background);
		}
	`,
    HIDE_MENU_PANEL: `
		nav {
			display: none !important;
		}
	`,
    HIDE_CODE_EDITOR: `
		.cm-editor {
			display: none !important;
		}
	`,
    HIDE_ERROR_DISPLAY: `
		header + div + div {
			display: none !important;
		}
	`,
    DISABLE_EVAL_BG_FLASH: `
		.cm-line:not(.cm-activeLine):has(> span) {
			background: var(--lineBackground) !important;
			width: fit-content;
		}
		.cm-line.cm-activeLine {
			background: linear-gradient(var(--lineHighlight), var(--lineHighlight)), var(--lineBackground) !important;
		}
		.cm-line > *, .cm-line span[style*="background-color"] {
			background-color: transparent !important;
			filter: none !important;
		}
	`,
};

const CLI_ARGS = {
    HIDE_TOP_BAR: "--hide-top-bar",
    MAXIMISE_MENU_PANEL: "--maximise-menu-panel",
    HIDE_MENU_PANEL: "--hide-menu-panel",
    HIDE_CODE_EDITOR: "--hide-code-editor",
    HIDE_ERROR_DISPLAY: "--hide-error-display",
    CUSTOM_CSS_B64: "--custom-css-b64=",
    HEADLESS: "--headless",
    USER_DATA_DIR: "--user-data-dir=",
    BROWSER_EXEC_PATH: "--browser-exec-path=",
};

const cliOptions: UserConfig = {
    hideTopBar: false,
    maximiseMenuPanel: false,
    hideMenuPanel: false,
    hideCodeEditor: false,
    hideErrorDisplay: false,
    customCss: undefined,
    isHeadless: false,
    userDataDir: USER_DATA_DIR,
    browserExecPath: undefined,
};

for (const arg of process.argv) {
    if (arg === CLI_ARGS.HIDE_TOP_BAR) {
        cliOptions.hideTopBar = true;
    } else if (arg === CLI_ARGS.MAXIMISE_MENU_PANEL) {
        cliOptions.maximiseMenuPanel = true;
    } else if (arg === CLI_ARGS.HIDE_MENU_PANEL) {
        cliOptions.hideMenuPanel = true;
    } else if (arg === CLI_ARGS.HIDE_CODE_EDITOR) {
        cliOptions.hideCodeEditor = true;
    } else if (arg === CLI_ARGS.HIDE_ERROR_DISPLAY) {
        cliOptions.hideErrorDisplay = true;
    } else if (arg.startsWith(CLI_ARGS.CUSTOM_CSS_B64)) {
        const b64 = arg.slice(CLI_ARGS.CUSTOM_CSS_B64.length);
        try {
            cliOptions.customCss = Buffer.from(b64, "base64").toString("utf8");
        } catch (e) {
            void logger.error("Failed to decode custom CSS", e);
        }
    } else if (arg === CLI_ARGS.HEADLESS) {
        cliOptions.isHeadless = true;
    } else if (arg.startsWith(CLI_ARGS.USER_DATA_DIR)) {
        cliOptions.userDataDir = arg.slice(CLI_ARGS.USER_DATA_DIR.length);
    } else if (arg.startsWith(CLI_ARGS.BROWSER_EXEC_PATH)) {
        cliOptions.browserExecPath = arg.slice(CLI_ARGS.BROWSER_EXEC_PATH.length);
    }
}

cliOptions.browserExecPath = expandTilde(cliOptions.browserExecPath);

let page: Page | undefined;
let lastContent: string;
let browserCtx: BrowserContext;
let ctxArgs: string[] = [
    "--autoplay-policy=no-user-gesture-required",
    "--disable--infobars",
];
let isShuttingDown = false;

const eventQueue: string[] = [];
let isProcessingEvent = false;

function describeMessage(message: string | undefined) {
    if (!message) {
        return "empty";
    }
    if (message.startsWith(MESSAGES.CONTENT)) {
        return `STRUDEL_CONTENT (${message.length - MESSAGES.CONTENT.length} bytes)`;
    }
    if (message.startsWith(MESSAGES.CURSOR)) {
        return `STRUDEL_CURSOR (${message.slice(MESSAGES.CURSOR.length)})`;
    }
    if (message.startsWith(MESSAGES.EVAL_ERROR)) {
        return `STRUDEL_EVAL_ERROR (${message.length - MESSAGES.EVAL_ERROR.length} bytes)`;
    }
    return message;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitCommandLine(command: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    let escaping = false;

    for (const char of command) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }

        if (char === "\\") {
            escaping = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = "";
            }
            continue;
        }

        current += char;
    }

    if (escaping) {
        current += "\\";
    }
    if (current) {
        tokens.push(current);
    }

    return tokens;
}

function stripDesktopFieldCodes(args: string[]): string[] {
    return args
        .map((arg) => arg.replace(/%[fFuUdDnNickvm]/g, ""))
        .filter((arg) => arg.length > 0);
}

// function collectPages(currentBrowser: BrowserContext): Page[] {
//     return currentBrowser.pages().flatMap((context) => context.pages());
// }

async function getLocalPWACommand(): Promise<LocalPWACommand | null> {
    const applicationsDir = path.join(
        os.homedir(),
        ".local",
        "share",
        "applications",
    );
    try {
        const entries = await fs.readdir(applicationsDir);
        const desktopFiles = entries.filter((name) => name.endsWith(".desktop"));

        for (const fileName of desktopFiles) {
            const filePath = path.join(applicationsDir, fileName);
            const content = await fs.readFile(filePath, "utf8");

            let inDesktopEntry = false;
            let name: string | null = null;
            let exec: string | null = null;

            for (const rawLine of content.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line || line.startsWith("#")) continue;
                if (line.startsWith("[") && line.endsWith("]")) {
                    inDesktopEntry = line === "[Desktop Entry]";
                    continue;
                }

                if (!inDesktopEntry) continue;
                const eq = line.indexOf("=");
                if (eq === -1) continue;

                const key = line.slice(0, eq);
                const value = line.slice(eq + 1);

                if (key === "Name") {
                    name = value;
                }
                if (key === "Exec") {
                    exec = value;
                }
            }

            if (name !== "Strudel REPL" || !exec) {
                continue;
            }

            const tokens = stripDesktopFieldCodes(splitCommandLine(exec));
            const [executable, ...rawArgs] = tokens;
            if (!executable) {
                continue;
            }

            const args: Record<string, string> = {};
            for (const arg of rawArgs) {
                if (arg.startsWith("--")) {
                    const parts = arg.split("=");
                    const key = parts[0];
                    const value = parts.length > 1 ? parts.slice(1).join("=") : "";
                    args[key] = value;
                }
            }

            return { executable, args };
        }
    } catch (error) {
        void logger.error("Error reading desktop files", error);
    }

    return null;
}

async function shutdown(exitCode: number) {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;

    try {
        if (browserCtx) {
            await browserCtx.close().catch(() => undefined);
        }
    } finally {
        process.exit(exitCode);
    }
}

async function updateEditorContent(content: string) {
    if (!page) return;

    try {
        await page.evaluate((newContent: string) => {
            const view = window.strudelMirror.editor;
            const oldContent = view.state.doc.toString();

            let start = 0;
            while (
                start < oldContent.length &&
                start < newContent.length &&
                oldContent[start] === newContent[start]
            ) {
                start++;
            }

            let endOld = oldContent.length - 1;
            let endNew = newContent.length - 1;
            while (
                endOld >= start &&
                endNew >= start &&
                oldContent[endOld] === newContent[endNew]
            ) {
                endOld--;
                endNew--;
            }

            if (start <= endOld || start <= endNew) {
                view.dispatch({
                    changes: {
                        from: start,
                        to: endOld + 1,
                        insert: newContent.slice(start, endNew + 1),
                    },
                });
            }
        }, content);
    } catch (error) {
        void logger.error("Error updating editor", error);
    }

    await page.locator("#autoplay-helper").click();
}

// async function moveEditorCursor(position: number) {
// 	await page.evaluate((pos) => {
// 		const docLength = window.strudelMirror.editor.state.doc.length;
// 		if (pos < 0) pos = 0;
// 		if (pos > docLength) pos = docLength;
// 		window.strudelMirror.setCursorLocation(pos);
// 		window.strudelMirror.editor.dispatch({ scrollIntoView: true });
// 	}, position);
// }

async function handleCursorMessage(message: string) {
    if (!page) return;
    void logger.debug("Handling cursor message", describeMessage(message));
    const cursorStr = message.slice(MESSAGES.CURSOR.length);
    const [rowStr, colStr] = cursorStr.split(":");
    const row = parseInt(rowStr);
    const col = parseInt(colStr);

    await page.evaluate(
        ({ row, col }) => {
            const view = window.strudelMirror.editor;
            const lineCount = view.state.doc.lines;
            const clampedRow = Math.max(1, Math.min(row, lineCount));
            const lineInfo = view.state.doc.line(clampedRow);
            const clampedCol = Math.max(0, Math.min(col, lineInfo.length));
            const pos = Math.min(lineInfo.from + clampedCol, lineInfo.to);
            view.dispatch({
                selection: { anchor: pos },
                scrollIntoView: true,
            });
        },
        { row, col },
    );
}

process.stdin.on("data", (data) => {
    void logger.debug("Received stdin data", { raw: data.toString() });
    const message = data.toString().trim();
    void logger.debug("Received stdin event", describeMessage(message));
    eventQueue.push(message);
    processEventQueue();
});

async function processEventQueue() {
    if (isProcessingEvent) return;
    isProcessingEvent = true;

    while (eventQueue.length > 0) {
        const message = eventQueue.shift();
        try {
            await handleEvent(message);
        } catch (err) {
            void logger.error("Error processing event", err);
        }
    }

    isProcessingEvent = false;
}

async function handleEvent(message: string | undefined) {
    if (!message) return;
    if (!page) return;

    void logger.debug("Handling event", describeMessage(message));
    if (message === MESSAGES.QUIT) {
        await shutdown(0);
    } else if (message === MESSAGES.TOGGLE) {
        await page.evaluate(() => {
            window.strudelMirror.toggle();
        });
    } else if (message === MESSAGES.UPDATE) {
        await page.evaluate(() => {
            window.strudelMirror.evaluate();
        });
    } else if (message === MESSAGES.REFRESH) {
        await page.evaluate(() => {
            if (window.strudelMirror.repl.state.started) {
                window.strudelMirror.evaluate();
            }
        });
    } else if (message === MESSAGES.STOP) {
        await page.evaluate(() => {
            window.strudelMirror.stop();
        });
    } else if (message.startsWith(MESSAGES.CONTENT)) {
        const base64Content = message.slice(MESSAGES.CONTENT.length);
        if (base64Content === lastContent) return;

        lastContent = base64Content;

        const content = Buffer.from(base64Content, "base64").toString("utf8");
        await updateEditorContent(content);
    } else if (message.startsWith(MESSAGES.CURSOR)) {
        await handleCursorMessage(message);
    }
}

function expandTilde(p: string | undefined): string | undefined {
    if (!p) return undefined;
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

(async () => {
    try {
        void logger.info("Starting attach runtime", `LogFile: ${logger.path}`);
        process.stdout.write(`Log write to file: ${logger.path.replace(os.homedir(), "~")}\n`);

        const pwaCommand = await getLocalPWACommand();

        let ignoreDefaultArgs = [
            "--mute-audio",
            "--enable-automation",
            "--no-sandbox",
        ];

        // user data is necessary
        if (
            !pwaCommand ||
            !("--user-data-dir" in pwaCommand.args) ||
            pwaCommand.args["--user-data-dir"] !== cliOptions.userDataDir

        ) {
            void logger.info(
                "PWA not installed or not installed at given user-data-dir",
            );

            browserCtx = await chromium.launchPersistentContext(
                cliOptions.userDataDir || USER_DATA_DIR,
                {
                    headless: cliOptions.isHeadless,
                    executablePath: cliOptions.browserExecPath || "chrome",
                    args: ctxArgs,
                    ignoreDefaultArgs: ignoreDefaultArgs,
                },
            );
            // check url of every pages if it contains strudel.cc, if yes reuse it and close others
            let reuse = false;
            void logger.debug("pages count", browserCtx.pages().length);
            for (const pg of browserCtx.pages()) {
                const url = pg.url();
                if (url.includes("strudel.cc")) {
                    void logger.info("Found existing Strudel page, reusing it");
                    reuse = true;
                    page = pg
                    browserCtx.pages().forEach((p) => {
                        if (p !== pg) {
                            p.close().catch(() => undefined);
                        }
                    });
                    break;
                }
            }
            void logger.debug("pages count", browserCtx.pages().length);
            if (!reuse) {
                page = browserCtx.pages()[0];
                await page.goto(STRUDEL_URL);
            }
        } else {
            void logger.info("Launch from PWA");

            for (const opt in pwaCommand.args) {
                if (opt === "--user-data-dir") {
                    continue;
                } else {
                    ctxArgs.push(`${opt}=${pwaCommand.args[opt]}`);
                }
            }

            browserCtx = await chromium.launchPersistentContext(
                cliOptions.userDataDir || USER_DATA_DIR,
                {
                    headless: cliOptions.isHeadless,
                    executablePath: cliOptions.browserExecPath || "chrome",
                    args: ctxArgs,
                    ignoreDefaultArgs: ignoreDefaultArgs,
                },
            );

            page = browserCtx.pages()[0];
        }

        browserCtx.on("close", () => {
            if (!isShuttingDown) {
                process.exit(0);
            }
        });

        if (!page) {
            logger.error("No page found in browser context");
            return;
        }
        page.on("close", () => {
            if (!isShuttingDown) {
                void shutdown(0);
            }
        });

        await page.addStyleTag({ content: STYLES.HIDE_EDITOR_SCROLLBAR });
        await page.addStyleTag({ content: STYLES.DISABLE_EVAL_BG_FLASH });

        if (cliOptions.maximiseMenuPanel) {
            await page.addStyleTag({ content: STYLES.MAX_MENU_PANEL });
        }
        if (cliOptions.hideTopBar) {
            await page.addStyleTag({ content: STYLES.HIDE_TOP_BAR });
        }
        if (cliOptions.hideMenuPanel) {
            await page.addStyleTag({ content: STYLES.HIDE_MENU_PANEL });
        }
        if (cliOptions.hideCodeEditor) {
            await page.addStyleTag({ content: STYLES.HIDE_CODE_EDITOR });
        }
        if (cliOptions.hideErrorDisplay) {
            await page.addStyleTag({ content: STYLES.HIDE_ERROR_DISPLAY });
        }
        if (cliOptions.customCss) {
            await page.addStyleTag({ content: cliOptions.customCss });
        }

        await page.evaluate(() => {
            const el = document.createElement("div");
            el.id = "autoplay-helper";
            Object.assign(el.style, {
                position: "fixed",
                left: "0px",
                top: "0px",
                width: "4px",
                height: "4px",
                opacity: "0",
                pointerEvents: "auto",
                zIndex: "2147483647",
            });

            el.addEventListener(
                "mousedown",
                (e) => {
                    e.preventDefault();
                },
                { passive: false },
            );

            document.body.appendChild(el);
        });

        await page.exposeFunction("sendEditorContent", async () => {
            const content = await page?.evaluate(() => {
                return window.strudelMirror.code;
            });

            const base64Content = Buffer.from(content).toString("base64");

            if (base64Content !== lastContent && !isProcessingEvent) {
                lastContent = base64Content;

                process.stdout.write(MESSAGES.CONTENT + base64Content + "\n");
            }
        });
        if (!cliOptions.isHeadless) {
            await page.evaluate(
                ({ editorSelector, eventName }) => {
                    const editor = document.querySelector(editorSelector);
                    if (!editor) return;

                    const observer = new MutationObserver(() => {
                        editor.dispatchEvent(new CustomEvent(eventName));
                    });
                    observer.observe(editor, {
                        childList: true,
                        characterData: true,
                        subtree: true,
                    });

                    editor.addEventListener(eventName, window.sendEditorContent);
                },
                {
                    editorSelector: SELECTORS.EDITOR,
                    eventName: EVENTS.CONTENT_CHANGED,
                },
            );
        }

        await page.exposeFunction("notifyEvalError", (evalErrorMessage: string) => {
            if (evalErrorMessage) {
                const b64 = Buffer.from(evalErrorMessage).toString("base64");
                process.stdout.write(MESSAGES.EVAL_ERROR + b64 + "\n");
            }
        });
        await page.evaluate(() => {
            let lastError: string | null = null;
            setInterval(() => {
                try {
                    const currentError =
                        window.strudelMirror.repl.state.evalError.message;
                    if (currentError !== lastError) {
                        lastError = currentError;
                        window.notifyEvalError(currentError);
                    }
                } catch {
                    // Ignore transient page readiness issues.
                }
            }, 300);
        });

        await page.exposeFunction("sendEditorCursor", async () => {
            const cursor = await page?.evaluate(() => {
                const view = window.strudelMirror.editor;
                const pos = view.state.selection.main.head;
                const lineInfo = view.state.doc.lineAt(pos);
                const row = lineInfo.number;
                const col = pos - lineInfo.from;
                return `${row}:${col}`;
            });
            process.stdout.write(MESSAGES.CURSOR + cursor + "\n");
        });
        if (!cliOptions.isHeadless) {
            await page.evaluate((editorSelector) => {
                const editor = document.querySelector(editorSelector);
                if (!editor) return;
                editor.addEventListener("keyup", window.sendEditorCursor);
                editor.addEventListener("keydown", window.sendEditorCursor);
                editor.addEventListener("mouseup", window.sendEditorCursor);
                editor.addEventListener("mousedown", window.sendEditorCursor);
            }, SELECTORS.EDITOR);
        }

        process.stdout.write(MESSAGES.READY + "\n");
        void logger.info("Attach runtime ready");
    } catch (error) {
        await logger.error("Fatal runtime error", error);
        await shutdown(1);
    }
})();
