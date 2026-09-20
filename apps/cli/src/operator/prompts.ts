import { createInterface, type Interface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

let sharedRl: Interface | null = null;
let sharedIterator: AsyncIterator<string> | null = null;

export function getReadline(): { rl: Interface; iterator: AsyncIterator<string> } {
  if (!sharedRl) {
    sharedRl = createInterface({ input, output });
    sharedIterator = sharedRl[Symbol.asyncIterator]();
    sharedRl.on("close", () => {
      sharedRl = null;
      sharedIterator = null;
    });
  }
  return { rl: sharedRl, iterator: sharedIterator! };
}

export function closeReadline(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
    sharedIterator = null;
  }
}

export async function ask(question: string, defaultValue = ""): Promise<string> {
  const { rl, iterator } = getReadline();
  const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  rl.setPrompt(promptText);
  rl.prompt();
  const { value, done } = await iterator.next();
  if (done || typeof value !== "string" || !value.trim()) {
    return defaultValue;
  }
  return value.trim();
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(`${question} ${hint}`, defaultYes ? "y" : "n");
  return answer.toLowerCase().startsWith("y");
}

export async function askChoice(
  question: string,
  choices: { label: string; value: string }[],
  defaultIndex = 0
): Promise<string> {
  console.log(`\n${question}`);
  choices.forEach((c, idx) => {
    const marker = idx === defaultIndex ? "*" : " ";
    console.log(`  [${idx + 1}]${marker} ${c.label}`);
  });
  const raw = await ask(`Выберите вариант (1-${choices.length})`, String(defaultIndex + 1));
  const num = parseInt(raw, 10);
  const selected = !isNaN(num) && num >= 1 && num <= choices.length ? choices[num - 1] : undefined;
  if (selected) {
    return selected.value;
  }
  const fallback = choices[defaultIndex];
  return fallback ? fallback.value : (choices[0]?.value ?? "");
}
