import { execFile } from "node:child_process";

// Arguments are passed as a list (no shell), so the URL cannot be read as a command.
export function openBrowser(url: string): void {
  if (!/^https:\/\//.test(url) && !/^http:\/\/127\.0\.0\.1:/.test(url)) return;
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  execFile(cmd, args as string[], () => {});
}
