import * as fs from "fs";
import path from "path";

let historyStream: fs.WriteStream | null = null;
let loggingEnabled = true;

export function setLoggingEnabled(enabled: boolean): void {
  loggingEnabled = enabled;
}

export function initHistoryLog(filePath: string = "history.toml"): void {
  if (historyStream) return;
  const dir = path.dirname(filePath);
  if (dir && dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }
  historyStream = fs.createWriteStream(filePath, { flags: "a" });
}

export function logToHistory(message: string): void {
  if (!loggingEnabled) return;
  process.stderr.write(message);
  if (historyStream) {
    historyStream.write(message);
    historyStream.emit("drain");
  }
}

export function logPrintln(...args: unknown[]): void {
  const message = args.map(String).join(" ") + "\n";
  logToHistory(message);
}
