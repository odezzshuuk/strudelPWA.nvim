import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from "playwright";
import http from "node:http";
import os from "os";
import { logger } from "./logger.ts";
import { options, title } from "./parseOptions.ts";

declare global {
    interface Window {
        strudelMirror: any;
        sendEditorContent: () => void;
        notifyEvalError: (evalErrorMessage: string | null) => void;
        sendEditorCursor: () => void;
    }
}


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

let strudelPage: Page | undefined;
let lastContent: string;
let browser: Browser;
let browserCtx: BrowserContext;

// let childProcessArgs: string[] = [
// ];
let isShuttingDown = false;

const eventQueue: string[] = [];
let isProcessingEvent = false;

/**
 * Read the CDP WebSocket endpoint without going through environment proxies.
 * Playwright's HTTP discovery request respects http_proxy/https_proxy, which
 * can send this localhost request to a proxy and produce a 502 response.
 */
function getCdpWebSocketUrl(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const request = http.get(
            {
                hostname: "127.0.0.1",
                port,
                path: "/json/version/",
                agent: false,
            },
            (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    body += chunk;
                });
                response.on("end", () => {
                    if (response.statusCode !== 200) {
                        reject(new Error(`CDP endpoint returned HTTP ${response.statusCode}`));
                        return;
                    }

                    try {
                        const endpoint = JSON.parse(body).webSocketDebuggerUrl;
                        if (typeof endpoint !== "string" || !endpoint.startsWith("ws")) {
                            throw new Error("webSocketDebuggerUrl is missing");
                        }
                        resolve(endpoint);
                    } catch (error) {
                        reject(new Error(`Invalid CDP endpoint response: ${String(error)}`));
                    }
                });
            },
        );
        request.on("error", reject);
    });
}

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
    if (!strudelPage) return;

    try {
        await strudelPage.evaluate((newContent: string) => {
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
    if (!strudelPage) return;
    void logger.debug("Handling cursor message", describeMessage(message));
    const cursorStr = message.slice(MESSAGES.CURSOR.length);
    const [rowStr, colStr] = cursorStr.split(":");
    const row = parseInt(rowStr);
    const col = parseInt(colStr);

    await strudelPage.evaluate(
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
    if (!strudelPage) return;

    void logger.debug("Handling event", describeMessage(message));
    if (message === MESSAGES.QUIT) {
        await shutdown(0);
    } else if (message === MESSAGES.TOGGLE) {
        await strudelPage.evaluate(() => {
            window.strudelMirror.toggle();
        });
    } else if (message === MESSAGES.UPDATE) {
        await strudelPage.evaluate(() => {
            window.strudelMirror.evaluate();
        });
    } else if (message === MESSAGES.REFRESH) {
        await strudelPage.evaluate(() => {
            if (window.strudelMirror.repl.state.started) {
                window.strudelMirror.evaluate();
            }
        });
    } else if (message === MESSAGES.STOP) {
        await strudelPage.evaluate(() => {
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

(async () => {
    try {
        process.stdout.write(`Log write to file: ${logger.path.replace(os.homedir(), "~")}\n`);

        if (!options.debuggingPort) {
            throw new Error("No browser debugging port was provided");
        }
        const cdpWebSocketUrl = await getCdpWebSocketUrl(options.debuggingPort);
        browser = await chromium.connectOverCDP(cdpWebSocketUrl);

        process.stdout.write("Connected to browser\n");
        browserCtx = browser.contexts()[0];

        browserCtx.on("close", () => {
            if (!isShuttingDown) {
                process.exit(0);
            }
        });

        for (const page of browserCtx.pages()) {
            const url = page.url();
            if (url.includes("strudel.cc")) {
                void logger.info("Found existing Strudel page, reusing it");
                strudelPage = page
                browserCtx.pages().forEach((p) => {
                    if (p !== page) {
                        p.close().catch(() => undefined);
                    }
                });
                break;
            }
        }

        if (!strudelPage) {
            logger.error("No page found in browser context");
            return;
        }

        strudelPage.on("close", () => {
            if (!isShuttingDown) {
                void shutdown(0);
            }
        });

        // await page.addStyleTag({ content: STYLES.HIDE_EDITOR_SCROLLBAR });
        // await page.addStyleTag({ content: STYLES.DISABLE_EVAL_BG_FLASH });
        //
        // if (Options.maximiseMenuPanel) {
        //     await page.addStyleTag({ content: STYLES.MAX_MENU_PANEL });
        // }
        // if (Options.hideTopBar) {
        //     await page.addStyleTag({ content: STYLES.HIDE_TOP_BAR });
        // }
        // if (Options.hideMenuPanel) {
        //     await page.addStyleTag({ content: STYLES.HIDE_MENU_PANEL });
        // }
        // if (Options.hideCodeEditor) {
        //     await page.addStyleTag({ content: STYLES.HIDE_CODE_EDITOR });
        // }
        // if (Options.hideErrorDisplay) {
        //     await page.addStyleTag({ content: STYLES.HIDE_ERROR_DISPLAY });
        // }
        // if (Options.customCss) {
        //     await page.addStyleTag({ content: Options.customCss });
        // }
        await strudelPage.evaluate((evlTitle) => {
            document.title = evlTitle || document.title
        }, title)

        await strudelPage.exposeFunction("sendEditorContent", async () => {
            const content = await strudelPage?.evaluate(() => {
                return window.strudelMirror.code;
            });

            const base64Content = Buffer.from(content).toString("base64");

            if (base64Content !== lastContent && !isProcessingEvent) {
                lastContent = base64Content;

                process.stdout.write(MESSAGES.CONTENT + base64Content + "\n");
            }
        });
        if (!options.isHeadless) {
            await strudelPage.evaluate(
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

        await strudelPage.exposeFunction("notifyEvalError", (evalErrorMessage: string) => {
            if (evalErrorMessage) {
                const b64 = Buffer.from(evalErrorMessage).toString("base64");
                process.stdout.write(MESSAGES.EVAL_ERROR + b64 + "\n");
            }
        });
        await strudelPage.evaluate(() => {
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

        await strudelPage.exposeFunction("sendEditorCursor", async () => {
            const cursor = await strudelPage?.evaluate(() => {
                const view = window.strudelMirror.editor;
                const pos = view.state.selection.main.head;
                const lineInfo = view.state.doc.lineAt(pos);
                const row = lineInfo.number;
                const col = pos - lineInfo.from;
                return `${row}:${col}`;
            });
            process.stdout.write(MESSAGES.CURSOR + cursor + "\n");
        });
        if (!options.isHeadless) {
            await strudelPage.evaluate((editorSelector) => {
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
