import { spawn, type ChildProcess } from "child_process";
import net from "net";
import { chromium, type Browser, type Page } from "playwright";

// /opt/brave-bin/brave --profile-directory=Default --app-id=camedmhajlokcgipjhegkdobhmafconk --user-data-dir=/home/odezzshog/.cache/strudelPWA-nvim/ --autoplay-policy=no-user-gesture-required --remote-debugging-port=39747

// "chromium --disable-stub-ethernet --default-stub-network-state-idle --disable-background-networking \"https://example.com\""
let homeDir = process.env.HOME;
let executable = "/opt/brave-bin/brave";

function isFreePort(
    port: number,
    host: string = "localhost",
): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();

        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                resolve(false); // port is taken
            } else {
                resolve(false); // other errors, treat as not usable
            }
        });

        server.once("listening", () => {
            server.close(() => resolve(true)); // free port
        });

        server.listen(port, host);
    });
}

let debugPort = 9595;
let proxyPort = 7897;

// if (!(await isFreePort(debugPort))) {
//     console.error(
//         `Error: Required ports ${debugPort} or ${proxyPort} are not in use. Please ensure the browser is running with remote debugging enabled on port ${debugPort}.`,
//     );
// } else {
//     let browserArgs = [
//         "--profile-directory=Default",
//         // "--app-id=camedmhajlokcgipjhegkdobhmafconk",
//         // "--app=https://strudel.cc",
//         // `--user-data-dir=${homeDir}/.cache/strudelPWA-nvim/`,
//         "--autoplay-policy=no-user-gesture-required",
//         // `--proxy-server=http://localhost:${proxyPort}`,
//         // `--remote-debugging-port=${debugPort}`,
//     ];
//
//     let browser = await chromium.launchPersistentContext(`${homeDir}/.cache/strudelPWA-nvim/`, {
//         headless: false,
//         executablePath: executable,
//         args: browserArgs,
//         ignoreDefaultArgs: [
//             "--mute-audio",
//             "--enable-automation",
//             "--no-sandbox",
//         ],
//     }); 
// }

let text = "Exec=/opt/brave-bin/brave --user-data-dir=/home/odezzshog/.cache/strudel-nvim --profile-directory=Default --app-id=camedmhajlokcgipjhegkdobhmafconk"

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

let arr = splitCommandLine(text)
let idx = arr.indexOf("--user-data-dir");
console.log(idx)
