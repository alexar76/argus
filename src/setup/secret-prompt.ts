import { stdin, stdout } from "node:process";

/** One-line prompt; keystrokes are not echoed (paste-friendly). Requires a TTY. */
export function readSecretLine(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    return Promise.reject(new Error("secret prompt requires an interactive terminal"));
  }

  stdout.write(prompt);

  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const cleanup = () => {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.removeListener("data", onData);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u0004") {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (ch === "\u0015") {
          value = "";
          continue;
        }
        value += ch;
      }
    };

    stdin.on("data", onData);
  });
}
