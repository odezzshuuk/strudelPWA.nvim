import os from "os";
import path from "path";
import { logger } from "./logger.ts";

export const options: Options = {
    hideTopBar: false,
    maximiseMenuPanel: false,
    hideMenuPanel: false,
    hideCodeEditor: false,
    hideErrorDisplay: false,
    customCss: undefined,
    isHeadless: false,
    userDataDir: path.join(os.homedir(), ".cache", "strudelPWA-nvim"),
    browserExecPath: undefined,
};


function ParseCommandLineArgs() {
    for (const arg of process.argv) {
        if (arg === CLI_ARGS.HIDE_TOP_BAR) {
            options.hideTopBar = true;
        } else if (arg === CLI_ARGS.MAXIMISE_MENU_PANEL) {
            options.maximiseMenuPanel = true;
        } else if (arg === CLI_ARGS.HIDE_MENU_PANEL) {
            options.hideMenuPanel = true;
        } else if (arg === CLI_ARGS.HIDE_CODE_EDITOR) {
            options.hideCodeEditor = true;
        } else if (arg === CLI_ARGS.HIDE_ERROR_DISPLAY) {
            options.hideErrorDisplay = true;
        } else if (arg.startsWith(CLI_ARGS.CUSTOM_CSS_B64)) {
            const b64 = arg.slice(CLI_ARGS.CUSTOM_CSS_B64.length);
            try {
                options.customCss = Buffer.from(b64, "base64").toString("utf8");
            } catch (e) {
                void logger.error("Failed to decode custom CSS", e);
            }
        } else if (arg.startsWith(CLI_ARGS.USER_DATA_DIR)) {
            options.userDataDir = arg.slice(CLI_ARGS.USER_DATA_DIR.length);
        } else if (arg.startsWith(CLI_ARGS.BROWSER_EXEC_PATH)) {
            options.browserExecPath = arg.slice(CLI_ARGS.BROWSER_EXEC_PATH.length);
        } else if (arg.startsWith(CLI_ARGS.DEBUGGING_PORT)) {
            const port = arg.slice(CLI_ARGS.DEBUGGING_PORT.length);
            options.debuggingPort = parseInt(port, 10);
        }
    }
    options.browserExecPath = expandTilde(options.browserExecPath);
}

export type Options = {
    hideTopBar?: boolean;
    maximiseMenuPanel?: boolean;
    hideMenuPanel?: boolean;
    hideCodeEditor?: boolean;
    hideErrorDisplay?: boolean;
    customCss?: string;
    isHeadless: boolean;
    userDataDir: string;
    browserExecPath?: string, 
    debuggingPort?: number;
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
    DEBUGGING_PORT: "--debugging-port=",
};

function expandTilde(p: string | undefined): string | undefined {
    if (!p) return undefined;
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

ParseCommandLineArgs();
