import path from "path";
import os from "os";

export const DEFAULT_USER_DATA_DIR = path.join(os.homedir(), ".cache", "strudelPWA-nvim");

type UserConfig = {
    hideTopBar: boolean;
    maximiseMenuPanel: boolean;
    hideMenuPanel: boolean;
    hideCodeEditor: boolean;
    hideErrorDisplay: boolean;
    customCss: string | undefined;
    isHeadless: boolean;
    userDataDir: string;
    browserExecPath: string | undefined;
    // strudelUrl: string,
};

export const Options: UserConfig = {
    hideTopBar: false,
    maximiseMenuPanel: false,
    hideMenuPanel: false,
    hideCodeEditor: false,
    hideErrorDisplay: false,
    customCss: undefined,
    isHeadless: false,
    userDataDir: DEFAULT_USER_DATA_DIR,
    browserExecPath: undefined,
};
