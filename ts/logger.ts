import fs from "fs/promises";
import path from "path";
import { options } from "./parseOptions.ts";

const LOG_FILE = path.join(options.userDataDir, "runtime.log");
let fileLogLevel: LogLevel = "INFO";

export type LogLevel = "DEBUG" | "INFO" | "ERROR";
setFileLogLevel("INFO");

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	DEBUG: 10,
	INFO: 20,
	ERROR: 30,
};


function normalizeMessage(message: unknown): string {
	if (message instanceof Error) {
		return message.stack ?? `${message.name}: ${message.message}`;
	}

	if (typeof message === "string") {
		return message;
	}

	try {
		return JSON.stringify(message);
	} catch {
		return String(message);
	}
}

function shouldWriteToFile(level: LogLevel): boolean {
	return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[fileLogLevel];
}

function parseLogLevel(level: unknown): LogLevel | undefined {
	if (typeof level !== "string") {
		return undefined;
	}

	const normalizedLevel = level.toUpperCase();
    if (normalizedLevel === "DEBUG" || normalizedLevel === "INFO" || normalizedLevel === "ERROR") {
		return normalizedLevel;
	}

	return undefined;
}

async function writeLog(level: LogLevel, message: unknown, ...details: unknown[]) {
	const line = [
		new Date().toISOString(),
		`[${level}]`,
		normalizeMessage(message),
		...details.map(normalizeMessage),
	].join(" ") + "\n";

	if (shouldWriteToFile(level)) {
		try {
			await fs.mkdir(options.userDataDir, { recursive: true });
			await fs.appendFile(LOG_FILE, line, "utf8");
		} catch {
			// Logging must never break the runtime.
		}
	}

	if (level === "ERROR") {
		process.stderr.write(line);
	}
}

export function setFileLogLevel(level: LogLevel) {
	const parsedLevel = parseLogLevel(level);
	if (parsedLevel) {
		fileLogLevel = parsedLevel;
	}
}

export function debug(message: unknown, ...details: unknown[]) {
	return writeLog("DEBUG", message, ...details);
}

export function info(message: unknown, ...details: unknown[]) {
	return writeLog("INFO", message, ...details);
}

export function error(message: unknown, ...details: unknown[]) {
	return writeLog("ERROR", message, ...details);
}

export const logger = {
	debug,
	info,
	error,
	setFileLogLevel,
	path: LOG_FILE,
};
