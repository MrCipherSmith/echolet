import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function ask(question: string, defaultValue = ""): Promise<string> {
  const rl = createInterface({ input, output });
  const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  try {
    const answer = await rl.question(promptText);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
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
  if (!isNaN(num) && num >= 1 && num <= choices.length) {
    return choices[num - 1].value;
  }
  return choices[defaultIndex].value;
}
